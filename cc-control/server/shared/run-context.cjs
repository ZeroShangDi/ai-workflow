'use strict';
/**
 * run-context.cjs — run 上下文装配器（纯派生，零副作用）
 *
 * 职责：输入 sid + config（projectRoot/会话/端口）→ 输出该 run 的标识、路径、会话名、settings 引用。
 * 把散落在 cli/server/MCP 的「单例路径/会话名/workdir 硬推导」收敛到单一装配点，供
 * T1-006(server 引用)、T1-007(cli/MCP 引用) 替换；多 run 命名接入由 T1-039/T1-069 消费本模块输出。
 *
 * 约定：
 *   - 纯函数：只算字符串，不读写文件、不 mkdir、不改 env。唯一例外是 ensureRunLayoutSync
 *     （显式副作用，单独导出，需要建目录的调用方自行调用）。
 *   - config 单源：会话名/端口经 runtime-config（plugin/config.json + CC_* env 覆盖）。
 *   - 现行落盘点仍是单 run 布局（state.json/.awf 根下）；.awf/runs/<sid>/ 每 run 布局在
 *     T1-018 迁移落盘前只派生 runDir 锚点、不产生文件。本模块不改变任何现有布局。
 *   - infraRoot = cc-control 包根（经模块位置定位，不受 cwd 影响）；projectRoot = run 项目根
 *     （.awf 宿主，默认 CC_PROJECT || cwd，与 server.cjs/run.js 现有约定一致）。
 *
 * 边界：只做「装配」不做「落盘」；也不决定目录里放什么内容（内容文件集由 store 归位任务使用）。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getSessionName, getServerPort } = require('./runtime-config.cjs');
const { SID_PATTERN, validateRunId } = require('./run-id.cjs');
const projectPaths = require('./project-paths.cjs'); // .awf 布局单源（本文件的路径表全部取自它）

/** cc-control 包根：server/shared/run-context.cjs → 上溯两级（shared → server → 包根），不受 cwd 影响 */
const INFRA_ROOT = path.resolve(__dirname, '..', '..');

/**
 * 校验 sid（run 标识）合法性；不合法即抛。
 * @param {string|null|undefined} sid null/undefined 视为「无 sid」放行；否则必须匹配 SID_PATTERN
 * @throws {Error} sid 非法（防路径/会话名注入）
 */
function assertSid(sid) {
  // sid 合法性单源在 run-id（SID_PATTERN ≤64 字符，防路径/名称注入）
  if (sid != null && !validateRunId(sid)) {
    throw new Error(`run-context: 非法 sid "${sid}"（须匹配 ${SID_PATTERN}，≤64 字符）`);
  }
}

/**
 * 装配一个 run 的上下文（纯计算，不落盘）。
 * @param {{ sid?: string, projectRoot?: string, env?: object }} input
 *   - sid          run 标识；缺省 null（未接 sid 前视为默认 run，runSessionName 回落基础会话名）
 *   - projectRoot  run 项目根（.awf 宿主）；缺省 env.CC_PROJECT || process.cwd()
 *   - env          环境变量（缺省 process.env），供测试注入
 * @returns {object} 见各字段注释；含标识（sid/session/runSessionName/port）、根（projectRoot/infraRoot）、
 *   现行单 run 路径、每 run 路径（有 sid 才有）、infra/settings 引用。
 * @throws {Error} sid 非法（assertSid）
 */
function buildRunContext({ sid = null, projectRoot, env = process.env } = {}) {
  assertSid(sid);
  // 三级回落：显式入参 > CC_PROJECT（server 注入）> cwd。保证 server 与 cli 对「项目根」理解一致
  const root = projectRoot || env.CC_PROJECT || process.cwd();
  const session = getSessionName(env);
  // bootstrap 会把完整 runSessionName 写进 CC_SESSION。若调用方从该 run 内再次装配同一 sid，
  // 不得重复追加后缀（cc-<sid>-<sid>）；跨 run 的父身份由 run-env 在命令边界清洗。
  const sidSuffix = sid == null ? null : `-${sid}`;
  const runSessionName = sid == null || session.endsWith(sidSuffix) ? session : `${session}${sidSuffix}`;
  const awfDir = projectPaths.awfDir(root);
  /** 每 run 目录（T1-018 布局）：.awf/runs/<sid>/；无 sid 时不派生 */
  const runDir = sid == null ? undefined : path.join(awfDir, 'runs', sid);
  // 每 run 布局子路径（sid 存在时产出；内容文件集由 store 归位任务使用，W1-019/020+ 落盘）
  const perRun = sid == null
    ? {}
    : {
      runStatePath: path.join(runDir, 'state.json'),
      runLogsDir: path.join(runDir, 'logs'),
      runContextDir: path.join(runDir, 'context'),
      runUsagePath: path.join(runDir, 'context', 'usage.json'),
      runDecisionsDir: path.join(runDir, 'decisions'),
      runMetaPath: path.join(runDir, 'meta', 'run-meta.json'),
    };

  return {
    // ── 标识 ──
    sid,
    /** tmux 会话基础名（config runtime.session / CC_SESSION） */
    session,
    /** 该 run 的 tmux 会话名：多 run 隔离 = `${session}-${sid}`；无 sid 回落基础名 */
    runSessionName,
    /** Session Server 端口（config port / CC_PORT） */
    port: getServerPort(env),

    // ── 根 ──
    /** run 项目根（.awf 宿主；server.cjs 的 CC_PROJECT） */
    projectRoot: root,
    /** cc-control 包根（config/settings/server/bootstrap 所在，经模块位置定位） */
    infraRoot: INFRA_ROOT,

    // ── .awf 现行单 run 布局路径（未接 sid 前 store 落盘点） ──
    // 与下方每 run 布局并存：无 sid 时 store 用这里的 statePath/contextUsagePath；
    // 有 sid 时改走 runStatePath/runUsagePath（见 store.createRunStores 的回落逻辑）。
    awfDir,
    statePath: projectPaths.stateFilePath(root),
    runConfigPath: projectPaths.configFilePath(root),
    runSettingsPath: projectPaths.settingsFilePath(root),
    contextUsagePath: projectPaths.contextUsagePath(root),
    runMetaPath: projectPaths.runMetaPath(root),
    logsDir: projectPaths.logsDir(root),
    decisionsDir: projectPaths.decisionsRunsDir(root),

    // ── 每 run 布局（T1-018）：.awf/runs/<sid>/ 及子路径（无 sid → 不派生） ──
    runDir,
    ...perRun, // sid 存在时平铺 runStatePath/runLogsDir/runContextDir/runUsagePath/runDecisionsDir/runMetaPath；无 sid 时为空对象

    // ── infra/settings 引用 ──
    /** 插件注册/安装单源（plugin/settings.json 安装清单） */
    pluginSettingsPath: path.join(INFRA_ROOT, 'server', 'adapters', 'cc', 'plugin', 'settings.json'),
    /** 插件唯一配置源（plugin/config.json） */
    infraConfigPath: path.join(INFRA_ROOT, 'server', 'adapters', 'cc', 'plugin', 'config.json'),
    /** 常驻 server 入口 —— CLI spawn 它（`cli/lib/session.cjs` 的 ensureServer），单源在此 */
    serverScriptPath: path.join(INFRA_ROOT, 'server', 'server.cjs'),
    bootstrapScriptPath: path.join(INFRA_ROOT, 'scripts', 'bootstrap.sh'),
    /** cc-control 开发用 .claude/settings.json */
    repoDevSettingsPath: path.join(INFRA_ROOT, '.claude', 'settings.json'),
    /** 项目级 .mcp.json（MCP 工具在 enabled-only 注册下可用之必要条件） */
    projectMcpJsonPath: path.join(root, '.mcp.json'),
  };
}

/**
 * 物理建立每 run 目录布局（runDir + 常用子目录）。有副作用，独立于纯装配 buildRunContext。
 * @param {object} ctx - buildRunContext 输出（需含 runDir）
 * @returns {string[]} 已确保存在的目录；无 runDir（未接 sid）→ []（不建任何目录）
 */
function ensureRunLayoutSync(ctx) {
  if (!ctx?.runDir) return [];
  const dirs = [
    ctx.runDir,
    ctx.runLogsDir,
    ctx.runContextDir,
    ctx.runDecisionsDir,
    path.join(ctx.runDir, 'meta'), // meta 子目录 ctx 未单列，此处就地拼出（与 runMetaPath 的父目录一致）
  ].filter(Boolean); // 排除 ctx 里可能缺失的子路径，避免 mkdirSync(undefined) 抛错
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  return dirs;
}

/**
 * 确定性项目 sid（run 标签）：由归一化 projectRoot 的 SHA-1 派生固定短 id。
 * 保证同一项目跨 CLI/server/重启产生同一会话名（tmux `cc-<sid>` 可被 --resume/--attach 重发现），
 * 且 SID_PATTERN 合法（`p` + 12 位 hex，48bit 冲突概率对少量并存项目足够低）。
 * 仅供命名/路由标签用：不落盘、不派生 `.awf/runs/<sid>/`。
 * @param {string} projectRoot run 项目根（.awf 宿主）
 * @returns {string} 形如 `p1a2b3c4d5e6f`
 */
function projectSid(projectRoot) {
  // path.resolve 归一（去掉尾斜杠、把相对路径接到 cwd），确保同一项目无论怎么传都得到同一 sid
  const root = path.resolve(projectRoot || '');
  const digest = crypto.createHash('sha1').update(root).digest('hex').slice(0, 12);
  return `p${digest}`;
}

/**
 * 该项目 run 的 tmux 会话名：`${session}-${projectSid(projectRoot)}`。
 * 单 server 多项目时每个项目会话名唯一（不再共用基础名 `cc` 而互相 kill）。
 * @param {string} projectRoot
 * @param {{ env?: object }} [opts]
 * @returns {string}
 */
function projectSessionName(projectRoot, { env = process.env } = {}) {
  return `${getSessionName(env)}-${projectSid(projectRoot)}`;
}

// SID_PATTERN 从 run-id 透传：调用方（server/routes）常需一起用，避免各自 import 两个模块。
module.exports = { buildRunContext, projectSid, projectSessionName, SID_PATTERN, INFRA_ROOT, ensureRunLayoutSync };
