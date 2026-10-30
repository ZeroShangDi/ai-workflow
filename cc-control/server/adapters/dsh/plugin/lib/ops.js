import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mountMcpServers } from './mcp.js';
import { registerSkills } from './skills.js';
import { mountSubagentTools } from './agents.js';

/**
 * ops.js — 指令实现表（插件 host 半侧）
 *
 * 每个 op 是 `async (args, command) => ({ ok, result?, error? })`。**未实现的 op 必须显式失败**，
 * 不允许返回空结果冒充成功（AWF 侧把 `ok:false` 当平台拒绝处理）。
 *
 * 已实现（均已在隔离真机上跑通）：
 *   P2-5a  `session.facts` / `session.nudge` / `session.open`
 *   P2-5b  `session.create`（`sessionController.create`）/ `session.interrupt`（`cancel`，keepInbox）
 *          / `session.stop`（cancel + 逐个 `subagents.interrupt` 子 Agent，U11 停止范围）
 *   P2-5c+ `session.prompt` / `session.snapshot` / `session.tools` / `session.children`
 *   P2-5f  `plan.launch` / `llm.oneshot`
 * 不属于插件职责（显式失败并说明归属）：`plugin.install/uninstall`（那是 CLI 装 profile 的活）。
 *
 * ⚠️ U16 批准策略**暂定「只记录 + 委派」**（不自动批准）：在实测搞清「workspace-write 预设下什么操作真的会
 * 请求批准」之前不放开。记录的事实（toolName/reason/sessionId）会经事件上报给 AWF，作为定策略的依据。
 */

/** 平台 MCP 客户端插件：运行时按 agent 作用域挂载（与 dsh-acp 的 mountAcpMcpServers 同一手法） */
async function loadMcpClientReal() {
  try {
    return await import('@deepseek-ai/dsh-mcp-client');
  } catch (err) {
    throw new Error(
      ' 无法加载 @deepseek-ai/dsh-mcp-client —— 离线装配需把它链接进 dsh-plugin/node_modules'
      + `（见 scripts/probe/dsh/install-fixture.sh）：${err.message}`,
    );
  }
}

/** 平台 llm 包：构造平台形状的 user message（`llm.stream` 不接受裸 {role,content}） */
async function loadLlmBits() {
  try {
    return await import('@deepseek-ai/dsh-llm');
  } catch (err) {
    throw new Error(
      ' 无法加载 @deepseek-ai/dsh-llm —— 离线装配需把它链接进 dsh-plugin/node_modules'
      + `（见 scripts/probe/dsh/install-fixture.sh）：${err.message}`,
    );
  }
}

/** 平台 agent 包：装模型选择用（F19 配方 ①） */
async function loadAgentBits() {
  try {
    return await import('@deepseek-ai/dsh-agent');
  } catch (err) {
    throw new Error(
      ' 无法加载 @deepseek-ai/dsh-agent —— 离线装配需把它链接进 dsh-plugin/node_modules'
      + `（见 scripts/probe/dsh/install-fixture.sh）：${err.message}`,
    );
  }
}

/**
 * 未实现 / 不属于插件职责的 op —— **显式失败**，并说清归属。
 * `plugin.*` 特别说明：DSH 侧的插件装配是**装 profile**（写 profile 的 patch 层 / 链接包），
 * 属于 **CLI 侧**（awf plugin / init，T-P2-02）的活，插件自身无法安装自己 —— 因此这里不是"没做完"，
 * 而是"不在这一层"。
 */
function notImplemented(op) {
  if (String(op).startsWith('plugin.')) {
    return {
      ok: false,
      error: `op "${op}" 不属于插件侧：DSH 的接入装配是「装 profile」（写 profile patch 层 / 链接包），由 AWF CLI 执行（T-P2-02）`,
    };
  }
  return { ok: false, error: `op "${op}" 尚未实现（P2-5f）：见 docs/discuss/dsh-adapter-execution.md §2.12` };
}

/**
 * @param {object} deps
 * @param {object} deps.ctx Cordis 上下文
 * @param {object} [deps.config] 插件配置（provider/model/webUrl 等平台参数）
 * @param {Function} [deps.log]
 */
/**
 * 末条 assistant 文本（可截断）—— `session.snapshot`（读本项目会话）与「子 Agent 结束上报」
 * （读子会话，供 AWF 解析 RESULT/NEEDS_INPUT 落账）共用**同一份**提取实现。
 * @param {object} session 平台会话
 * @param {number} [maxChars]
 * @returns {{ text: string|null, truncated: boolean, turn: number|null }}
 */
export function lastAssistantText(session, maxChars = 8000) {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.type !== 'assistant/message') continue;
    const blocks = e.data?.message?.content ?? [];
    const text = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
    return {
      text: text.length > maxChars ? text.slice(0, maxChars) : text,
      truncated: text.length > maxChars,
      turn: e.data?.turn ?? null,
      seq: e.seq ?? null,
      at: e.time ? new Date(e.time).toISOString() : null,
    };
  }
  return { text: null, truncated: false, turn: null, seq: null, at: null };
}

export function createOps({
  ctx,
  config = {},
  log = () => {},
  onEvent = () => {},
  loadMcpClient = loadMcpClientReal,
  loadAgent = loadAgentBits,
  loadLlm = loadLlmBits,
  loadToolSubagent, // 缺省交给 lib/agents.js 自己 import；测试注入用
}) {
  /** 有回合在跑的会话 id（prompt 置位、turn 结束清除）—— 供 ready 判定 */
  const inFlight = new Set();
  /** **AWF 自己创建的**会话 id（批准应答者据此判断「这是不是我们的会话」，U16） */
  const createdByAwf = new Set();
  /** 收到过的批准请求（只记录，不自动批准；给 U16 定策略用） */
  const approvalRequests = [];

  /** 取平台服务（缺失返回 undefined，调用方负责显式失败） */
  const service = (name) => (typeof ctx?.get === 'function' ? ctx.get(name) : undefined);

  /**
   * 路径同一性：`/var/...` 与 `/private/var/...`（macOS 临时目录）指的是同一个地方，但字符串不等。
   * 会话身份按路径比，就必须先规范化 —— 否则 AWF 传进来的真实路径与平台记的原始 cwd 对不上，
   * 表现为「明明建过会话却找不到」（实测：CLI 的 `awf attach` 因此拿到 web 根地址而不是会话地址）。
   */
  function canonPath(p) {
    if (typeof p !== 'string' || p === '') return null;
    try { return fs.realpathSync.native(p); } catch { /* 路径不存在（已删/临时目录）→ 退字符串归一 */ }
    const abs = path.resolve(p).replace(/\/+$/, '');
    return abs === '' ? '/' : abs;
  }

  function samePath(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    return a === b || canonPath(a) === canonPath(b);
  }

  /** 按项目根找活会话（会话身份 = header.cwd + header.id，spec C06「项目名不是唯一身份」） */
  function findSession(projectRoot) {
    const sessions = service('sessions');
    const all = typeof sessions?.list === 'function' ? sessions.list() : [];
    if (!projectRoot) return all[0] ?? null;
    return all.find((s) => samePath(s?.header?.cwd, projectRoot)) ?? null;
  }

  /**
   * 给某个会话挂项目 MCP（**会话/agent 作用域**，spec C30）。
   * 实现落在 `lib/mcp.js`：入口一律本包内的 `mcp/<name>/server.cjs`，不再经 `awfRepo`
   * 去 cc 插件树取。这里只做 DI 透传，保持 ops 的可测性。
   * @param {string} sessionId
   * @param {string} cwd 项目根
   * @returns {Promise<{mounted: string[], tools: number}}>
   */
  async function mountMcpInto(agentCtx, cwd) {
    const names = await mountMcpServers(agentCtx, cwd, { config, log, loadMcpClient });
    return names;
  }

  /**
   * 把项目目录登记成 DSH 的**工作区**，并**把会话登记进该工作区**（都幂等）。
   *
   * 真机踩到过两次，是两个不同的坑：
   *   ① 只建工作区、不登记会话 → 网页里会话掉进「未分组」。
   *      `dsh-client-ui-workspace` 的 `groupByWorkspace` 按 **`workspace.sessionIds`** 归属，
   *      不是按 cwd 前缀猜的 —— 必须 `workspace.attachSession(sessionId)` 才会有归属。
   *   ② `Workspace.sessionIds` 的 getter 会按 `host.sessionPath(id) === workspace.path` **再过一遍**：
   *      会话的 cwd 与工作区路径必须**逐字相等**。所以两边都用同一个规范化路径（`canonPath`），
   *      否则 macOS 上 `/tmp/x` 与 `/private/tmp/x` 这类差异会让登记静默失效。
   * @param {string} cwd 项目根（已规范化）
   * @param {string} sessionId 要登记进工作区的会话
   * @returns {Promise<{ok: boolean, id?: string|null, title?: string|null, created?: boolean, attached?: boolean, reason?: string}>}
   */
  async function ensureWorkspace(cwd, sessionId) {
    const registry = service('workspaceRegistry');
    if (!registry?.create) return { ok: false, reason: 'workspaceRegistry 服务不可用（ctx.get 为空）' };
    let existed = false;
    try { existed = (registry.list?.() ?? []).some((w) => samePath(w?.path, cwd)); } catch { /* 列表读不到不影响创建 */ }
    const ws = await registry.create(cwd, path.basename(cwd) || cwd);
    // 建了工作区不等于会话归属它 —— 少这一步网页里就是「未分组」
    let attached = false;
    if (sessionId && typeof ws?.attachSession === 'function') {
      await ws.attachSession(sessionId);
      attached = true;
    }
    return { ok: true, id: ws?.id ?? null, title: ws?.title ?? null, created: !existed, attached };
  }

  /**
   * 给会话设一个**人可读的标题**（失败只告警，不阻断建会话 —— 标题是展示面）。
   *
   * 为什么必须显式设：DSH 的会话标题默认取**首条用户消息**。AWF 注入的是命令正文（w-plan.md
   * 全文，9.4KB），于是侧栏里一排会话全叫「# w-plan 主规划流程。从一句话」—— 真机踩到。
   * @param {object} agent `agents.create` 回的 agent
   * @param {string} title 标题
   */
  async function setSessionTitle(agent, title) {
    const clean = String(title ?? '').trim();
    if (clean === '') return false;
    const titles = service('sessionTitle');
    if (!titles?.rename || !agent?.session) {
      log('warn', 'sessionTitle 服务不可用 —— 会话标题会是首条消息的第一行（注入正文时很难看）');
      return false;
    }
    try {
      titles.rename(agent.session, clean.slice(0, 120));
      return true;
    } catch (err) {
      log('warn', `会话标题设置失败：${err.message}`);
      return false;
    }
  }

  /** 兜底标题：`AWF · <项目目录名>`（AWF 没给标题时用，至少不是一坨正文） */
  function defaultTitle(cwd, purpose) {
    const name = path.basename(cwd) || cwd;
    return purpose === 'plan' ? `AWF 规划 · ${name}` : `AWF · ${name}`;
  }

  /**
   * 建一个「完整配方」的会话（execution / planning 共用）：
   * 在 **agent 发布前**的 setup 窗口里依次 ① installModelSelection ② agentPresets.mount ③（可选）挂项目 MCP。
   * 为什么不用 `sessionController.create`：它没有 setup 窗口，挂上去的 MCP 工具进不了会话工具表（实测 0 个工具）。
   * @param {{cwd: string, mountMcp?: boolean, title?: string, purpose?: string}} opts
   * @returns {Promise<{ok: boolean, sessionId?: string, agent?: object, mounted?: string[], error?: string}>}
   */
  async function createSession({ cwd, mountMcp = true, title, purpose } = {}) {
    const agents = service('agents');
    if (!agents?.create) return { ok: false, error: 'agents 服务不可用（ctx.get("agents") 为空）' };
    const defaultModel = service('agentDefaultModel');
    const selection = defaultModel?.currentSelection?.();
    // 规范化路径在**会话 cwd 与工作区路径上用同一个值** —— `Workspace.sessionIds` 的 getter
    // 会按 `sessionPath(id) === workspace.path` 过滤，两边不一致会让归属静默失效（见 ensureWorkspace）
    const projectCwd = canonPath(cwd) || cwd;
    let mounted = [];
    let skills = [];
    let subagents = [];
    try {
      const sessionIdAsked = `session-${randomUUID()}`;
      const created = await agents.create({
        sessionId: sessionIdAsked,
        meta: { cwd: projectCwd },
        ...(selection ? { agentOptions: { provider: selection.provider, model: selection.model } } : {}),
        setup: async (agentCtx) => {
          const agentBits = await loadAgent();
          agentBits.installModelSelection(agentCtx, { current: selection, assembled: undefined });
          const presets = service('agentPresets');
          if (!presets?.mount) throw new Error('agentPresets 服务不可用（ctx.get("agentPresets") 无 mount）');
          await presets.mount(agentCtx, config.agentPreset ?? 'standard');
          // 顺序有讲究：MCP 先挂（工具面齐了），子 Agent 的白名单核验才拿得到真实工具名
          if (mountMcp) mounted = await mountMcpInto(agentCtx, projectCwd);
          // 会话级资产：技能（36 个）与命名子 Agent（awf_worker / awf_monitor_*）。
          // 落在本 agent 作用域 → 只有 AWF 建的会话看得到，不污染用户自己的 DSH 会话。
          skills = registerSkills(agentCtx, { log }).registered;
          subagents = (await mountSubagentTools(agentCtx, {
            log,
            ...(loadToolSubagent ? { loadToolSubagent } : {}),
          })).mounted;
        },
      });
      const agent = created?.agent;
      const sessionId = agent?.session?.header?.id ?? sessionIdAsked;
      if (!sessionId) return { ok: false, error: 'agents.create 未回可用的会话 id' };
      createdByAwf.add(sessionId);
      // 标题：优先用调用方给的（AWF 知道需求原文），否则退到项目名 —— 都不要让侧栏显示注入正文的第一行
      const titled = await setSessionTitle(agent, title || defaultTitle(projectCwd, purpose));
      // 工作区登记失败**不阻断建会话**（分组是展示面），但必须留痕、不静默（U6）
      let workspace = null;
      try {
        workspace = await ensureWorkspace(projectCwd, sessionId);
        if (workspace.ok !== true) log('warn', `工作区登记未生效：${workspace.reason}（网页里这个会话会显示在「未分组」）`);
        else log('info', `工作区${workspace.created ? '已登记' : '已存在'}：${workspace.title ?? cwd}`);
      } catch (err) {
        workspace = { ok: false, reason: err.message };
        log('warn', `工作区登记失败：${err.message}（网页里这个会话会显示在「未分组」）`);
      }
      return { ok: true, sessionId, agent, mounted, skills, subagents, titled, workspace };
    } catch (err) {
      return { ok: false, error: `agents.create 失败：${err.message}` };
    }
  }

  /** 子会话判定：平台字段真名是 `header.parentSession`（实测；别名兜底防版本差异） */
  function parentOf(child) {
    return child?.header?.parentSession ?? child?.header?.parentSessionId ?? child?.header?.parent ?? null;
  }

  /** 网页里定位某个会话的 URL（DSH 是网页形态；上层拿它 open） */
  function sessionUrl(sessionId) {
    const base = config.webUrl ?? `http://127.0.0.1:${config.webPort ?? 3080}`;
    return sessionId ? `${base}/?session=${encodeURIComponent(sessionId)}` : base;
  }

  /**
   * 等 MCP 工具出现在**模型可见工具表**里（F29 注册异步 / F30 不要看 agent.ctx.tools）。
   * @param {object} session 平台会话
   * @param {string[]} serverNames 已挂的 server 名
   * @param {{timeoutMs?: number}} [opts]
   * @returns {Promise<number>} 工具总数
   */
  async function waitForMcpTools(session, serverNames, { timeoutMs = config.mcpReadyTimeoutMs ?? 20000 } = {}) {
    const wanted = serverNames.map((n) => `mcp__${n}__`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const tools = session?.requestHeader?.()?.tools ?? [];
      const names = tools.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean);
      if (wanted.every((p) => names.some((t) => t.startsWith(p)))) return tools.length;
      if (Date.now() >= deadline) {
        throw new Error(`MCP 工具未在 ${timeoutMs}ms 内注册（期望前缀 ${wanted.join(',')}；实得 ${names.length} 个工具）`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /**
   * 从 `ctx.llm.stream()` 里取出可见文本。
   * 流里混着两类记录（对齐平台自身的 `joinAssistantStreamText`）：
   *   `{type:'chunk', chunk:{type:'text-delta', text}}` 与 `{type:'text-chunks', texts:[…]}`；
   * 也兼容被直接 yield 的裸 chunk。取不到就回空串 —— **不编**（调用方按「空 = 没拿到」处理）。
   */
  async function collectText(stream) {
    let text = '';
    const seen = [];
    for await (const record of stream) {
      seen.push(record?.type === 'chunk' ? `chunk:${record.chunk?.type}` : String(record?.type ?? typeof record));
      if (record?.type === 'finish') { collectText.lastFinish = record; }
      if (seen.length <= 200) { /* 只留前 200 条，够定位形状 */ }
      if (typeof record === 'string') { text += record; continue; }
      if (record?.type === 'text-chunks' && Array.isArray(record.texts)) { text += record.texts.join(''); continue; }
      const chunk = record?.type === 'chunk' ? record.chunk : record;
      if (!chunk || typeof chunk !== 'object') continue;
      // 只认 delta（与平台 `joinAssistantStreamText` 一致）：**不要**再叠加 `block-end`
      // 的整块文本，否则同一段会被算两遍（实测得到 "OKOK"）
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
      else if (chunk.type === 'text' && typeof chunk.text === 'string') text += chunk.text;
    }
    collectText.lastRecordTypes = seen;
    return text;
  }

  const ops = {
    /**
     * 平台事实：会话存在/可达/就绪 + cwd/sessionId。
     * 「就绪」是**插件自己的事实**（有回合在跑 = 不就绪），不是界面状态。
     */
    async 'session.facts'(args = {}) {
      const s = findSession(args.projectRoot);
      const id = s?.header?.id ?? null;
      return {
        ok: true,
        result: {
          sessionExists: !!s,
          reachable: true,
          ready: s ? !inFlight.has(id) : false,
          cwd: s?.header?.cwd ?? null,
          sessionId: id,
          // 观看地址随事实一起回：CLI 进程**没有** bridge，`awf attach` 只能经 AWF server 的
          // /probe 拿事实；而 DSH 的 web 口只有本插件知道（profile patch 里的 config）
          url: sessionUrl(id),
          snapshot: null, // 可读快照走 `session.snapshot`（本 op 只回事实）
        },
      };
    },

    /** 唤醒输入框：DSH 无「信任弹窗打空」问题，按幂等 no-op 实现（不是失败） */
    async 'session.nudge'() {
      return { ok: true, result: { noop: true } };
    },

    /** 打开项目页面/执行会话：DSH 是网页形态，回 URL 交上层打开 */
    async 'session.open'(args = {}) {
      const s = findSession(args.projectRoot);
      return { ok: true, result: { url: s ? sessionUrl(s.header.id) : sessionUrl(null), sessionId: s?.header?.id ?? null } };
    },

    /**
     * 创建（或幂等领养）执行会话 —— 平台的 `sessionController.create`。
     * DSH 侧一次完成「建会话 + 模型选择 + preset 装载」（F19：只调 agents.create 会得到裸 agent）。
     * @param {{projectRoot: string}} args
     */
    async 'session.create'(args = {}) {
      const cwd = args.projectRoot;
      if (typeof cwd !== 'string' || cwd === '') return { ok: false, error: 'projectRoot 必须是非空字符串' };
      const created = await createSession({ cwd, mountMcp: true, title: args.title });
      if (!created.ok) return { ok: false, error: created.error };
      // 注意：**不能**在 create 时用 `session.requestHeader().tools` 判「工具注册好了」——
      // 它是 `request/header` 事件的折叠，**首次模型请求之前恒为 undefined**（实测 0 个工具）。
      // 挂载发生在 setup（发布前），工具从**第一次请求**起就在场；核对点因此放在首次派发之后
      // （`session.tools` 指令 / turn 结束时上报），而不是这里。
      onEvent({ type: 'session.started', sessionId: created.sessionId, cwd }, { sessionExists: true, reachable: true, cwd, sessionId: created.sessionId });
      return {
        ok: true,
        result: {
          sessionId: created.sessionId,
          agentPreset: config.agentPreset ?? 'default',
          cwd,
          mcp: { mounted: created.mounted, toolsAtCreate: null },
          // 会话级资产的实际装配结果（技能数 / 命名子 Agent 工具名）——供 AWF 与探针核对，
          // 避免「装上了但没生效」只能靠翻日志判断
          skills: created.skills ?? [],
          subagents: created.subagents ?? [],
          titled: created.titled === true,
          workspace: created.workspace ?? null, // 网页分组依据（未登记 → DSH 显示「未分组」）
        },
      };
    },

    /**
     * 可读快照（C25）：本次会话**最后一条助手消息的文本**。
     * 来源是会话日志里的 `assistant/message` 事件（`data.message.content` 是 ContentBlock[]，
     * 只取 `type==='text'` 的块）。拿不到就回 `text:null` + 原因，**不编内容**。
     * @param {{maxChars?: number}} [args]
     */
    async 'session.snapshot'(args = {}) {
      const s = findSession(args.projectRoot);
      if (!s) return { ok: false, error: `projectRoot=${args.projectRoot ?? '(未给)'} 没有活会话` };
      const max = Number(args.maxChars) || 8000;
      const got = lastAssistantText(s, max);
      if (got.text === null) {
        return { ok: true, result: { text: null, truncated: false, note: '还没有助手消息（首次派发前，或这一轮没有文本产出）' } };
      }
      return {
        ok: true,
        result: { text: got.text, truncated: got.truncated, turn: got.turn, seq: got.seq, at: got.at },
      };
    },

    /**
     * 诊断：本项目主会话的子 Agent 会话（按 `header.parentSessionId` 找）。
     * 用于「停止项目执行要逐个打断子 Agent」（U11/C14）的可核对性。
     */
    async 'session.children'(args = {}) {
      const s = findSession(args.projectRoot);
      if (!s) return { ok: false, error: `projectRoot=${args.projectRoot ?? '(未给)'} 没有活会话` };
      const ids = (service('sessions')?.list?.() ?? [])
        .filter((x) => parentOf(x) === s.header.id)
        .map((x) => x.header.id);
      return { ok: true, result: { parent: s.header.id, children: ids, count: ids.length } };
    },

    /**
     * 诊断：本次会话**模型可见的工具名**（`session.requestHeader().tools`）。
     * 只在首次模型请求之后才有值（header 是事件折叠）；用于核对「MCP 工具真的进了工具表」（F29/F30）。
     */
    async 'session.tools'(args = {}) {
      const s = findSession(args.projectRoot);
      if (!s) return { ok: false, error: `projectRoot=${args.projectRoot ?? '(未给)'} 没有活会话` };
      const tools = s.requestHeader?.()?.tools ?? [];
      const names = tools.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean);
      return { ok: true, result: { count: names.length, names, mcp: names.filter((n) => n.startsWith('mcp__')) } };
    },

    /**
     * 开始规划（C07 / U2-Q2）：在目标项目**新建会话**并注入规划指令，用户在网页里接着聊。
     * 与 cc 的「直开终端对话」不是同一形态，但对上层是同一个能力（`interactive.launchDialog`）。
     * 规划会话同样要挂项目 MCP —— 规划产物（state.json）是通过 awf-state MCP 工具写出来的。
     * @param {{cwd: string, prompt: string}} args
     */
    async 'plan.launch'(args = {}) {
      const cwd = args.cwd;
      const text = args.prompt;
      if (typeof cwd !== 'string' || cwd === '') return { ok: false, error: 'cwd 必须是非空字符串' };
      if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'prompt 必须是非空字符串' };
      const controller = service('sessionController');
      if (!controller?.prompt) return { ok: false, error: 'sessionController.prompt 不可用' };

      const created = await createSession({ cwd, mountMcp: true, title: args.title, purpose: 'plan' });
      if (!created.ok) return { ok: false, error: created.error };
      const sessionId = created.sessionId;
      try {
        const r = await controller.prompt(
          { sessionId, content: [{ type: 'text', text }], requestId: `plan-${randomUUID()}` },
          new AbortController().signal,
        );
        onEvent({ type: 'session.started', sessionId, cwd, purpose: 'plan' }, { sessionExists: true, reachable: true, cwd, sessionId });
        return {
          ok: true,
          result: {
            sessionId,
            accepted: r?.accepted === true,
            url: sessionUrl(sessionId),
            mcp: { mounted: created.mounted },
          titled: created.titled === true,
            workspace: created.workspace ?? null,
          },
        };
      } catch (err) {
        return { ok: false, error: `规划指令注入失败：${err.message}`, result: { sessionId } };
      }
    },

    /**
     * 提交一轮输入（能力方法）：文本 → **平台受理回执**。
     * 平台语义：`prompt()` 只保证「已受理」，**回合结束**另经 `turn/end` 会话事件回来
     * （index.js 订阅 `session/event` 后上报 `session.ready`）—— 「平台受理」与「任务完成」分开。
     * F26：signal 是**第二位置参数**（放进 request 对象无效）。
     */
    async 'session.prompt'(args = {}, command = {}) {
      const controller = service('sessionController');
      if (!controller?.prompt) return { ok: false, error: 'sessionController.prompt 不可用' };
      const s = findSession(args.projectRoot);
      if (!s) return { ok: false, error: `projectRoot=${args.projectRoot ?? '(未给)'} 没有活会话` };
      const text = args.text;
      if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'text 必须是非空字符串' };
      const sessionId = s.header.id;
      inFlight.add(sessionId);
      try {
        const r = await controller.prompt(
          {
            sessionId,
            content: [{ type: 'text', text }],
            // requestId 用 AWF 的 commandId：平台按它去重（补发不会变成两轮）
            ...(command?.commandId ? { requestId: command.commandId } : {}),
          },
          new AbortController().signal,
        );
        onEvent({ type: 'prompt.submitted', sessionId, cwd: s.header.cwd }, { ready: false, sessionExists: true, sessionId, cwd: s.header.cwd });
        return { ok: true, result: { accepted: r?.accepted === true, sessionId } };
      } catch (err) {
        inFlight.delete(sessionId);
        return { ok: false, error: `sessionController.prompt 失败：${err.message}` };
      }
    },

    /**
     * 打断当前响应：`cancel({sessionId})` 只**发起**取消（平台语义：回执 ≠ 已停）。
     * `keepInbox` 由平台固定为 true —— 排队内容不会丢，编排侧不要假设「cancel = 全部停下」（E-06）。
     */
    async 'session.interrupt'(args = {}) {
      const controller = service('sessionController');
      if (!controller?.cancel) return { ok: false, error: 'sessionController.cancel 不可用' };
      const s = findSession(args.projectRoot);
      if (!s) return { ok: false, error: `projectRoot=${args.projectRoot ?? '(未给)'} 没有活会话` };
      try {
        const r = controller.cancel({ sessionId: s.header.id });
        return { ok: true, result: { accepted: r?.accepted === true, sessionId: s.header.id, keepInbox: true } };
      } catch (err) {
        return { ok: false, error: `sessionController.cancel 失败：${err.message}` };
      }
    },

    /**
     * 停止本项目执行（U11 范围）：先 cancel 主会话，再**逐个**打断子 Agent。
     * **不是**删除会话/关后台（spec §2：停项目不停共享 DSH 后台）。
     */
    async 'session.stop'(args = {}) {
      const controller = service('sessionController');
      const subagents = service('subagents');
      const s = findSession(args.projectRoot);
      if (!s) return { ok: false, error: `projectRoot=${args.projectRoot ?? '(未给)'} 没有活会话` };
      const sessionId = s.header.id;
      // 子 Agent 名单必须在 cancel **之前**取：平台 cancel 父会话会连带把子激活摘出活动列表
      // （实测：cancel 后再 list() 找不到任何 parentSession === sessionId 的子会话）。
      const childIds = (service('sessions')?.list?.() ?? [])
        .filter((c) => parentOf(c) === sessionId)
        .map((c) => c.header.id);
      const stopped = { sessionId, cancelled: false, subagents: [], subagentsSeen: childIds, subagentsAvailable: !!subagents?.interrupt, errors: [] };
      try {
        if (controller?.cancel) { controller.cancel({ sessionId }); stopped.cancelled = true; }
      } catch (err) {
        return { ok: false, error: `cancel 失败：${err.message}` };
      }
      // 子 Agent：**逐个**打断（E-06：取消父会话不会自动停子 Agent）。
      // 平台 `interrupt(targetSessionId, authority)` 的 user 权威**必须带 parentSessionId**
      // （它会校验 `child.header.parentSession === authority.parentSessionId`，不给就 UNAUTHORIZED —— 实测踩到）。
      if (subagents?.interrupt) {
        for (const id of childIds) {
          try {
            subagents.interrupt(id, config.stopAuthority ?? { kind: 'user', parentSessionId: sessionId });
            stopped.subagents.push(id);
          } catch (err) {
            stopped.errors.push(`${id}: ${err.message}`);
            log('warn', `打断子 Agent ${id} 失败：${err.message}`);
          }
        }
      }
      inFlight.delete(sessionId);
      onEvent({ type: 'session.stopped', sessionId, cwd: s.header.cwd }, { sessionExists: true, ready: false, sessionId, cwd: s.header.cwd });
      return { ok: true, result: stopped };
    },

    /**
     * 无状态一次性调用（`ctx.llm.stream`，不建会话）—— 不建会话、可超时、可取消（X7 机制）。
     * provider/model 缺省取平台默认选择（与建会话同一来源）。
     */
    async 'llm.oneshot'(args = {}) {
      const llm = service('llm');
      if (!llm?.stream) return { ok: false, error: 'llm 服务不可用（ctx.get("llm") 为空）' };
      const prompt = args.prompt;
      if (typeof prompt !== 'string' || prompt === '') return { ok: false, error: 'prompt 必须是非空字符串' };
      const timeoutMs = Number(args.timeoutMs) || 60000;
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        // provider/model：显式配置优先；否则用平台默认选择（与建会话同一来源）
        const fallback = service('agentDefaultModel')?.currentSelection?.();
        // 消息必须是**平台形状**（`createUserMessage({content:[blocks], source})`）；
        // 传裸 `{role,content}` 会得到 `content.some is not a function`（实测踩到）。
        const llmBits = await loadLlm();
        const messages = [llmBits.createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'user' },
        })];
        const stream = llm.stream({
          provider: config.provider ?? fallback?.provider,
          model: config.model ?? fallback?.model,
          messages,
          signal,
        });
        const text = await collectText(stream);
        if (text === '') {
          // 空文本**不装成功**：把看到的记录形状带回去，便于定位（换版本时最先坏在这里）
          return {
            ok: false,
            error: `llm.stream 未产出文本（记录形状：${JSON.stringify((collectText.lastRecordTypes ?? []).slice(0, 12))}；`
              + `finish：${JSON.stringify(collectText.lastFinish ?? null).slice(0, 400)}）`,
          };
        }
        return { ok: true, result: { ok: true, text } };
      } catch (err) {
        return { ok: false, error: `llm.stream 失败：${err.message}` };
      }
    },
  };

  /** 未实现的 op 统一答复（显式失败，不静默） */
  function dispatch(command) {
    const op = command?.op;
    const handler = ops[op];
    if (!handler) return Promise.resolve(notImplemented(op));
    return Promise.resolve(handler(command.args ?? {}, command));
  }

  /** 批准请求登记（U16 定策略的依据；只记录不自动批准） */
  function noteApproval(req, detail = {}) {
    approvalRequests.push({ at: new Date().toISOString(), toolName: req?.toolName ?? null, reason: req?.reason ?? null, ...detail });
    if (approvalRequests.length > 50) approvalRequests.shift();
    return approvalRequests[approvalRequests.length - 1];
  }

  return { ops, dispatch, inFlight, findSession, createdByAwf, approvalRequests, noteApproval };
}
