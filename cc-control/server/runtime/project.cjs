'use strict';
/**
 * projects/context.cjs — 项目上下文（纯）
 *
 * 收缩动机：原 `project-context.cjs` 把三类完全不同的东西塞进一个返回对象 ——
 *   ① 身份（projectRoot / sid / 会话名）② 路径（logsDir / 各 jsonl / runStateFile）
 *   ③ 出口（tmux 注入 / stores 落盘 / logger 日志）**以及** ④ 一堆**运行态**
 *   （state / decisionPending / waiters / decisionGate / runHost / runStateApi / …）。
 * 因为运行态寄存在这个共享对象上，`server.cjs` 满篇 `pcx.state = 'busy'` 这类写，
 * 模块边界永远立不起来。
 *
 * 现在这里**只装前三类**（身份 + 路径 + 出口），运行态归各能力自己持有 ——
 * 装配见 `projects/runtime.cjs`，会话态见 `session/index.cjs`。
 *
 * 关键约定（不变）：
 *   - 磁盘锚「无 sid」的 storeCtx → 状态仍是 <root>/.awf/state.json，绝不静默分片。
 *   - 每个 ctx 的出口实例相互独立，跨项目隔离由「每项目一份」在构造上保证。
 *   - 纯容器 + 纯寻址：构造不读写业务文件。
 */

const path = require('node:path');
const fs = require('node:fs');
const { buildRunContext, projectSid } = require('../shared/run-context.cjs');
const { createRunStores } = require('../shared/store.cjs');
const storeCore = require('../shared/store-core.cjs');
const { RunLogger: RealRunLogger } = require('../observability/run-logger.cjs');
const projectPaths = require('../shared/project-paths.cjs'); // .awf 布局单源
const { host: createHostPort } = require('../adapters/ports.cjs'); // 经唯一门（不在 adapters 外直连 cc/xxx.cjs）
const { isDecisionEnabled } = require('../features/decision/config.cjs');
const { DecisionStore } = require('../features/decision/store.cjs');

/**
 * @param {{ projectRoot: string, env?: object, sid?: string, tmuxFactory?: Function, RunLogger?: Function }} input
 *   projectRoot  run 项目根（.awf 宿主）
 *   env          环境（缺省 process.env；会话名/端口经 runtime-config）
 *   sid          显式 run 标签；缺省用确定性 projectSid(projectRoot)
 *   tmuxFactory  (sessionName) => tmux 原语集；缺省 host 端口（测试可注入 mock）
 *   RunLogger    RunLogger 类；缺省真实实现（测试注入 mock）
 * @returns 一个**纯容器**：身份 + 路径 + 出口（见文件头），构造过程不读写业务文件
 */
function createProjectContext({ projectRoot, env = process.env, sid, tmuxFactory, RunLogger = RealRunLogger } = {}) {
  const root = path.resolve(projectRoot || env.CC_PROJECT || process.cwd());
  const runSid = sid || projectSid(root);
  // 命名 ctx：带 sid 标签（tmux 会话名 cc-<sid>）；磁盘 ctx：无 sid（.awf/state.json 现行布局）
  // 两个 ctx 分离是刻意的：会话名按 run 分片，但磁盘锚保持「本项目唯一 state.json」，不因 sid 漂移
  const nameCtx = buildRunContext({ projectRoot: root, sid: runSid, env });
  const storeCtx = buildRunContext({ projectRoot: root, env });
  const logger = new RunLogger(root);
  const stores = createRunStores(storeCtx);
  const tmux = typeof tmuxFactory === 'function'
    ? tmuxFactory(nameCtx.runSessionName)
    : createHostPort({ sessionName: nameCtx.runSessionName });

  // ── 路径 ──
  /** sid 落盘路径（软边界，仅 ?sid= 显式路径用；根锚本项目） */
  function runStateFile(sidKey) {
    return sidKey
      ? projectPaths.runStateFilePath(root, sidKey) // 显式分片：.awf/runs/<sid>/state.json
      : projectPaths.stateFilePath(root);          // 无 sid：现行布局，绝不静默分片
  }
  /** 与 runStateFile 配套的锁文件路径（同目录，.lock 后缀） */
  function runStateLockFile(sidKey) {
    return sidKey
      ? projectPaths.runStateLockPath(root, sidKey)
      : projectPaths.stateLockPath(root);
  }
  /** 写某个 sid 的 state.json：建目录 → 加文件锁 → 原子写（只在显式 sid 路径用） */
  function writeRunStateSid(sidKey, state) {
    const file = runStateFile(sidKey);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return storeCore.withFileLock(runStateLockFile(sidKey), () => storeCore.writeJsonAtomicSync(file, state));
  }

  return {
    // ── 身份 ──
    projectRoot: root,
    sid: runSid,
    session: nameCtx.session,
    runSessionName: nameCtx.runSessionName, // tmux 会话名 cc-<sid>
    port: nameCtx.port,
    nameCtx,
    storeCtx,

    // ── 路径 ──
    logsDir: storeCtx.logsDir,
    subagentEventPath: path.join(storeCtx.logsDir, 'subagent-events.jsonl'),
    subagentFailedPath: path.join(storeCtx.logsDir, 'subagent-failed.jsonl'),
    subagentNeedsPath: path.join(storeCtx.logsDir, 'subagent-needs-input.jsonl'),
    runStateFile,
    runStateLockFile,
    writeRunStateSid,

    // ── 出口（对外部世界的全部副作用，就这四个）──
    tmux,                                     // ① 会话注入
    stores,                                   // ② 落盘
    storeCore,
    logger,                                   // ③ 日志
    newDecisionStore: () => new DecisionStore(root), // ④ 决策存储（工厂：每次取新实例）
    decisionEnabled: () => isDecisionEnabled(root),  // 决策开关（读项目配置，运行期可变）
  };
}

module.exports = { createProjectContext };
