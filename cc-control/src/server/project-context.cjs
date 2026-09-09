'use strict';
/**
 * project-context.cjs — 单 server 多项目的每项目上下文容器 + 注册表
 *
 * 目标（用户裁定，方向文档 multi-run-server-architecture 主键改为 projectRoot）：
 * 一个常驻 Session Server 进程内服务多个不同的项目目录。每个项目一份 ProjectCtx，
 * 持有该项目自己的磁盘锚点（.awf/state.json / config / logs / decisions）、tmux 会话
 * （run 标签唯一化）、per-sid 内存槽、决策/落账所需的惰性字段与 run host 装配位。
 *
 * 关键约定：
 *   - 磁盘一律锚「无 sid」的 storeCtx → 状态仍是 <root>/.awf/state.json，绝不静默分片到
 *     .awf/runs/<sid>/（Q1 裁定不做 sid 磁盘分片）。sid 只作 run 标签（tmux 会话名 + hook 路由）。
 *   - 每个 ProjectCtx 的 mutable 字段相互独立（ready/busy/decision/host 等），
 *     跨项目隔离由"每项目一份闭包对象"在构造上保证，不靠共享单槽。
 *   - 本模块只做「打包/寻址」，不含 HTTP 逻辑；HTTP 层（server.cjs）解析 p 后取其上下文操作。
 *
 * 纯容器 + 纯寻址：构造不读写业务文件（RunLogger/stores 均容忍 .awf 尚不存在）。
 */

const path = require('node:path');
const fs = require('node:fs');
const { buildRunContext, projectSid } = require('../lib/run-context.cjs');
const { createRunStores } = require('../lib/store.cjs');
const storeCore = require('../lib/store-core.cjs');
const { RunLogger } = require('./run-logger.cjs');
const { createRunSlot } = require('./run-slot.cjs');
const { createTmux } = require('./tmux.cjs');
const { isDecisionEnabled } = require('../lib/decision-config.cjs');
const gateRules = require('./decision-gate.cjs');
const { DecisionStore } = require('./decision-store.cjs');

/**
 * 构建一个项目的运行时上下文（含 immutable 锚点 + mutable 槽位占位）。
 * @param {{ projectRoot: string, env?: object, sid?: string, tmuxFactory?: Function }} input
 *   - projectRoot  run 项目根（.awf 宿主）
 *   - env          环境（缺省 process.env；会话名/端口经 runtime-config）
 *   - sid          显式 run 标签；缺省用确定性 projectSid(projectRoot)（跨进程一致）
 *   - tmuxFactory  (sessionName) => tmux 原语集；缺省 createTmux（测试可注入）
 */
function createProjectContext({ projectRoot, env = process.env, sid, tmuxFactory } = {}) {
  const root = path.resolve(projectRoot || env.CC_PROJECT || process.cwd());
  const runSid = sid || projectSid(root);
  // 命名 ctx：带 sid 标签（tmux 会话名 cc-<sid>）；磁盘 ctx：无 sid（.awf/state.json 现行布局）
  const nameCtx = buildRunContext({ projectRoot: root, sid: runSid, env });
  const storeCtx = buildRunContext({ projectRoot: root, env });
  const logger = new RunLogger(root);
  const stores = createRunStores(storeCtx);
  const tmux = (typeof tmuxFactory === 'function' ? tmuxFactory(nameCtx.runSessionName) : createTmux(nameCtx.runSessionName));

  // per-sid 内存槽（hook 按 sid 路由到独立 ready/busy/decision，不串 run）
  const runSlots = new Map();
  function runSlotFor(sidKey) {
    if (sidKey == null || sidKey === '') return null;
    const key = String(sidKey);
    let slot = runSlots.get(key);
    if (!slot) { slot = createRunSlot(key); runSlots.set(key, slot); }
    return slot;
  }

  // T1-078 sid 落盘帮助（保留软边界，仅 ?sid= 显式路径用；根锚本项目）
  function runStateFile(sidKey) {
    return sidKey
      ? path.join(root, '.awf', 'runs', sidKey, 'state.json')
      : path.join(root, '.awf', 'state.json');
  }
  function runStateLockFile(sidKey) {
    return sidKey
      ? path.join(root, '.awf', 'runs', sidKey, 'state.lock')
      : path.join(root, '.awf', 'state.lock');
  }
  function writeRunStateSid(sidKey, state) {
    const file = runStateFile(sidKey);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return storeCore.withFileLock(runStateLockFile(sidKey), () => storeCore.writeJsonAtomicSync(file, state));
  }

  return {
    // ── 标识/锚点 ──
    projectRoot: root,
    /** run 标签（确定性；tmux 会话名 + hook 路由用） */
    sid: runSid,
    session: nameCtx.session,
    runSessionName: nameCtx.runSessionName,
    port: nameCtx.port,
    nameCtx,
    storeCtx,

    // ── 磁盘 store / 日志 / tmux ──
    logger,
    stores,
    storeCore,
    tmux,
    runSlots,
    runSlotFor,
    runStateFile,
    runStateLockFile,
    writeRunStateSid,
    logsDir: storeCtx.logsDir,
    subagentEventPath: path.join(storeCtx.logsDir, 'subagent-events.jsonl'),
    subagentFailedPath: path.join(storeCtx.logsDir, 'subagent-failed.jsonl'),
    subagentNeedsPath: path.join(storeCtx.logsDir, 'subagent-needs-input.jsonl'),

    // ── 决策/闸门按项目读取自身 config ──
    decisionEnabled: () => isDecisionEnabled(root),
    newDecisionStore: () => new DecisionStore(root),

    // ── mutable 单槽占位（server HTTP 层按上下文操作；每项目独立）──
    state: 'ready',             // 'ready' | 'busy'
    decisionPending: null,
    waiters: [],
    fallbackTimer: null,
    contextReady: false,
    mainSessionId: null,
    agents: new Map(),          // 子 agent 观测（按 session/agent id）
    decisionGate: null,         // null | { phase:'deciding', startedAt }
    decisionResume: null,
    decisionSeqGen: gateRules.createDecisionSeq(),
    metricsCache: { at: 0, value: null },
    diagnosisInFlight: false,

    // ── run host / state api 装配位（惰性；每项目独立）──
    runHost: null,
    runHostReady: null,
    runHostBootErr: null,
    runStateApi: null,
    runStateApiReady: null,
  };
}

/**
 * 项目注册表：懒建 ProjectCtx，缺省 root → boot（兼容不带 p 的存量请求/测试）。
 * @param {{ env?: object, bootRoot?: string, tmuxFactory?: Function }} [deps]
 */
function createProjectRegistry({ env = process.env, bootRoot, tmuxFactory } = {}) {
  const boot = path.resolve(bootRoot || env.CC_PROJECT || process.cwd());
  const map = new Map();
  let bootCtx = null; // boot 上下文最先构造，保证 no-p 落到与旧单槽一致的项目

  function norm(root) {
    return root ? path.resolve(root) : boot;
  }

  function ctxFor(root) {
    const key = norm(root);
    const existing = map.get(key);
    if (existing) return existing;
    const created = createProjectContext({ projectRoot: key, env, tmuxFactory });
    map.set(key, created);
    if (key === boot && !bootCtx) bootCtx = created;
    return created;
  }

  /** 解析一次请求的项目上下文：p（归一化）缺省 → boot；body.projectRoot 兜底 */
  function resolveCtx({ p, projectRoot, bodyProjectRoot } = {}) {
    const root = p || bodyProjectRoot || projectRoot || boot;
    return ctxFor(root);
  }

  function list() {
    return [...map.values()].map((c) => ({
      projectRoot: c.projectRoot,
      runSessionName: c.runSessionName,
      state: c.state,
      decisionPending: c.decisionPending,
      contextReady: c.contextReady,
    }));
  }

  function reset() {
    for (const c of map.values()) {
      if (c.fallbackTimer) { clearTimeout(c.fallbackTimer); c.fallbackTimer = null; }
      if (c.runHost) { try { c.runHost.stop(); } catch { /* ignore */ } }
      c.state = 'ready';
      c.decisionPending = null;
      c.decisionGate = null;
      c.decisionResume = null;
      c.decisionSeqGen.reset();
      c.runSlots.clear();
      c.waiters = [];
      c.contextReady = false;
      c.mainSessionId = null;
      c.agents.clear();
      c.metricsCache = { at: 0, value: null };
      c.diagnosisInFlight = false;
      c.runHost = null;
      c.runHostReady = null;
      c.runHostBootErr = null;
      c.runStateApi = null;
      c.runStateApiReady = null;
    }
  }

  // 预置 boot 上下文（构造即注册，保证 /status 无 p 时可立即响应且与原行为等价）
  ctxFor(boot);

  return { bootRoot: boot, ctxFor, resolveCtx, list, reset, get size() { return map.size; } };
}

module.exports = { createProjectContext, createProjectRegistry };
