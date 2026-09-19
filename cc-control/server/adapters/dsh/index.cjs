'use strict';
/**
 * dsh/index.cjs — DSH（DeepSeek Harness）平台适配器（AWF 侧）
 *
 * 定位：把 AWF 的 7 个端口实现成「往插件 host 半侧发指令」，指令通道见 `./bridge.cjs`。
 * 平台事实、会话生命周期、派发/打断、快照、一次性调用、资产装配全部由 DSH 侧的插件执行；
 * **本目录不做任何会话调度判断**（调度权仍归 AWF 宿主，S‑C34）。
 *
 * ## 与 cc 适配器的差别（P2-4 的范围）
 * | 面 | cc | DSH |
 * |---|---|---|
 * | 机制 | tmux 注入 + hooks 回调 | 会话控制器 + 平台事件（插件经 HTTP 回传） |
 * | 同步事实 | `hasSession()` 可同步真查 | **只有异步事实**：同步方法回「最近一次已知值」，新鲜事实走 `probe.inspect()` |
 * | cc 机制方法 | `spawnClaudeP` / `claudePArgs` / `claudeAvailable` / `build*` | **显式 unsupported**（抛错，不静默返回假值） |
 *
 * ## 状态（诚实口径）
 * 本文件是 AWF 侧适配器：端口面、指令协议、三种送达结论都已实现并过契约自检。
 * **插件 host 半侧（`dsh-plugin/`）与真实链路均已落地**（P2-5a～P2-6f，隔离真机实测），
 * 故 `ADAPTER_PLATFORMS.dsh.status` 已转 `factory`：`resolveProjectAdapters()` 对 dsh 项目真实返回 7 端口。
 * 未落地部分按能力逐项记账（见 `docs/discuss/dsh-adapter-execution.md` §2.18 的 V01～V12 对照），
 * 不用「整体可用/整体不可用」糊过去。
 */

const { createEvent } = require('../../shared/events.cjs');
const { isSamePath } = require('../../shared/project-paths.cjs');

/** 需要等结果的长指令（建会话/派发/一次性调用）；其余用 bridge 缺省窗口 */
const RESULT_WINDOWS = {
  'session.create': 120000,
  'session.prompt': 600000,
  'session.stop': 60000,
  'llm.oneshot': 300000,
  'plan.launch': 60000,
};

/** DSH 平台事件 → AWF 领域事件（与 cc 的 HOOK_EVENT_MAP 同义，名字不同） */
const DSH_EVENT_MAP = {
  'session.started': () => ({ type: 'run.started', payload: {} }),
  'session.stopped': () => ({ type: 'run.stopped', payload: {} }),
  'prompt.submitted': () => ({ type: 'run.phase', payload: { phase: 'BUSY' } }),
  // 回合结束 = 会话回到可派发（与 cc 的 Stop hook 同义）。用既有的 run.phase 词表，不新造事件类型。
  // lastAssistantMessage：带**这一轮的末条文本**，运行时的回合末门阀（决策）据此判定（cc 走 Stop hook 的
  // body.last_assistant_message，两条入口喂的是同一份东西）。
  'session.ready': (p) => ({
    type: 'run.phase',
    payload: { phase: 'READY', lastAssistantMessage: p.lastAssistantMessage ?? null },
  }),
  // 子 Agent 生命周期：payload 里必须带**父会话 id**（归属判定）与**末条 assistant 文本**
  // （RESULT/NEEDS_INPUT 就写在那里，落账正文见 server/run/subagent.cjs 的平台无关处理器）
  'agent.started': (p) => ({
    type: 'agent.started',
    payload: { agentId: p.agentId || 'agent', parentSessionId: p.parentSessionId ?? null, cwd: p.cwd ?? null },
  }),
  'agent.stopped': (p) => ({
    type: 'agent.stopped',
    payload: {
      agentId: p.agentId || 'agent',
      taskId: p.taskId ?? null,
      parentSessionId: p.parentSessionId ?? null,
      lastAssistantMessage: p.lastAssistantMessage ?? null,
      reason: p.reason ?? null,
    },
  }),
};

/** 平台事实里与领域事件无关、但同步方法要用的字段 */
function factsFromEvent(payload = {}) {
  const patch = {};
  if (payload.type === 'session.started') { patch.sessionExists = true; patch.reachable = true; }
  if (payload.type === 'session.stopped') { patch.sessionExists = false; patch.ready = false; }
  if (payload.type === 'session.ready') { patch.ready = true; patch.reachable = true; }
  if (payload.type === 'prompt.submitted') { patch.ready = false; }
  if (payload.sessionId) patch.sessionId = payload.sessionId;
  return patch;
}

/**
 * cc 机制方法的显式不支持实现。
 * 为什么给一个会抛的函数而不是省略：省略 → 上层拿到 `undefined is not a function`（难查）；
 * 抛错 → 一眼看出「这个能力平台不支持」，符合 U6「可选能力显式不支持」。
 */
function unsupported(methodName) {
  return () => {
    throw new Error(`dsh adapter: ${methodName} 是 cc 机制方法，DSH 平台无对应能力（显式不支持，不静默降级）`);
  };
}

/**
 * DSH 平台的依赖检查（C02）：不要求用户安装 Claude Code。
 * 与端口面分开导出：`checks` 是**平台属性**（装配进 ADAPTER_PLATFORMS），不是端口（见 P1-05 口径：
 * 工厂必须恰好返回 7 个端口）。
 * @param {{ execSync?: Function }} [deps]
 * @returns {Array<{name: string, ok: boolean, hint: string}>}
 */
function checkPrerequisites({ execSync } = {}) {
  const run = execSync || ((cmd) => require('node:child_process').execSync(cmd, { stdio: 'ignore' }));
  const has = (cmd) => { try { run(`command -v ${cmd}`); return true; } catch { return false; } };
  return [
    { name: 'dsh', ok: has('dsh'), hint: '安装 DeepSeek Harness 并确保 dsh 在 PATH' },
    { name: 'node', ok: has('node'), hint: '安装 Node.js（插件 MCP server 需要）' },
  ];
}

/**
 * 「未连接」的通道替身：端口照常构造，真发指令即得「未交给平台」。
 * 为什么不是直接抛：CLI 侧命令只用到 tools/checks，不该因为「CLI 没有常驻通道」就装不起来；
 * 而真要用端口时，失败信息必须与真断链一致（not-delivered）。
 */
function detachedBridge() {
  return {
    connected: () => false,
    detachedReason: () => '本进程没有指令通道（bridge 只在常驻 AWF server 里）',
    lastFacts: () => ({}),
    noteFacts: () => ({}),
    onEvent: () => () => {},
    pendingCount: () => 0,
    request: async (op) => ({
      commandId: null,
      op,
      delivery: 'not-delivered',
      error: '指令通道未连接（未交给平台）：本进程没有 bridge（CLI 侧只做装配/检查，不驱动会话）',
    }),
  };
}

/** 工厂返回值**只含 7 个端口**（契约自检要求：不多不少） */
function createDshAdapters({ bridge, sessionName = 'dsh', bus, projectRoot } = {}) {
  // 没有 bridge **不抛**：见 detachedBridge 的说明
  const channel = bridge && typeof bridge.request === 'function' ? bridge : detachedBridge();
  const emit = bus?.emit || (() => 0);

  /**
   * 给指令参数补上**项目身份**。
   * 为什么必须补：DSH 的指令通道是**进程级共享**的（一个后台服务多项目），平台侧按
   * `projectRoot` 找会话；而 cc 的 host 是每项目一份（tmux 会话名自带身份），所以端口签名里
   * 没有 projectRoot。漏了它，两个项目的指令会打到同一个会话上（实测踩到）。
   */
  const withRoot = (args = {}) => (
    projectRoot && args.projectRoot === undefined ? { ...args, projectRoot } : args
  );

  /**
   * 发指令并把「未交给平台 / 无法确认 / 平台报错」变成显式异常。
   * 只有确认受理且结果 ok 才返回结果 —— 未知一律不装成功。
   * @param {string} op 指令名
   * @param {object} [args]
   * @param {{ projectRoot?: string }} [opts]
   */
  async function must(op, args = {}, opts = {}) {
    const r = await channel.request(op, withRoot(args), { projectRoot, resultTimeoutMs: RESULT_WINDOWS[op], ...opts });
    if (r.delivery !== 'accepted') {
      throw new Error(`dsh ${op}: ${r.delivery === 'unconfirmed' ? '无法确认' : '未交给平台'}：${r.error || ''}`);
    }
    if (r.ok === false) throw new Error(`dsh ${op}: 平台拒绝：${r.error || 'unknown'}`);
    return r.result;
  }

  /** 取新鲜平台事实（异步）；失败不抛，返回 { ok:false, error } 交调用方判定 */
  async function facts(opts = {}) {
    const r = await channel.request('session.facts', withRoot({}), { projectRoot, ...opts });
    if (r.delivery !== 'accepted' || r.ok === false) {
      return { ok: false, error: r.error || `facts 未取得（delivery=${r.delivery}）` };
    }
    const f = r.result || {};
    channel.noteFacts(f);
    return { ok: true, ...f };
  }

  const host = {
    sessionName,
    /**
     * 会话是否存在 —— **最近一次已知值**（同步 API 无法等网络）。
     * DSH 侧判「能否派发」要看新鲜事实：用 `probe.inspect()`（C09：平台报事实，AWF 判定，U10）。
     */
    hasSession() {
      return channel.connected() && channel.lastFacts().sessionExists === true;
    },
    /** 以字面文本输入（不提交）。异步：返回的 Promise 解析为送达结论，调用方可 await。 */
    sendText(text) {
      return must('session.inject', { text });
    },
    /** 提交当前输入（回车） */
    sendEnter() {
      return must('session.enter', {});
    },
    /**
     * 提交一段输入（能力方法，等价 cc 的 sendPrompt）：文本 + 提交一次交给平台。
     * 结果区分「平台受理」与「任务完成」——这里只保证前者。
     * @param {string} text
     */
    sendPrompt(text) {
      return must('session.prompt', { text });
    },
    /** 打断当前响应（Ctrl-C 的等价物：平台 cancel；完成信号是 whenIdle，见 bridge 结果） */
    sendCtrlC() {
      return must('session.interrupt', {});
    },
    /** 抓取可读快照 —— 最近一次已知值（同步 API）；新鲜快照走 probe.inspect() */
    capture() {
      return channel.lastFacts().snapshot ?? '';
    },
  };

  const session = {
    sessionName,
    /** 会话是否存在（最近一次已知值） */
    exists() {
      return channel.connected() && channel.lastFacts().sessionExists === true;
    },
    /** 会话工作目录（最近一次已知值）；未知 → null */
    cwd() {
      return channel.lastFacts().cwd ?? null;
    },
    /**
     * 创建/确保执行会话：DSH 侧一次完成「建会话 + 装模型选择 + 装 preset + 挂项目 MCP + 批准策略」。
     * @param {{ projectRoot: string, env?: object }} opts
     */
    async start({ projectRoot, env } = {}) {
      const r = await must('session.create', { projectRoot, env: env ? Object.keys(env) : undefined }, { projectRoot });
      channel.noteFacts({ sessionExists: true, reachable: true, cwd: projectRoot });
      return { ok: true, sessionId: r?.sessionId ?? null };
    },
    /** 停止会话（只停本项目执行，不关共享后台，spec §2 边界）—— 回执含逐个打断的子 Agent（U11） */
    async kill() {
      const stop = await must('session.stop', {}, {});
      channel.noteFacts({ sessionExists: false, ready: false });
      return stop ?? { sessionId: null, cancelled: false, subagents: [] };
    },
    /**
     * 激活输入框。DSH 无「信任弹窗打空」这类机制，平台侧实现为 no-op（不是失败）——
     * 但**必须存在**，否则 CLI 的就绪等待会在缺方法处炸。
     */
    async nudge() {
      await must('session.nudge', {});
    },
    /** 接入观看：DSH 是网页形态（返回 URL 供上层打开），不是终端 attach */
    async attach() {
      const r = await must('session.open', {}, {});
      return { ok: true, url: r?.url ?? null };
    },
  };

  const probe = {
    /**
     * 侦查：取**新鲜**会话事实。遵守 cc probe 的约定——侦查没有失败态，
     * `ok` 恒 true，信息不足用 `state:'unknown'` 表达。
     */
    async inspect() {
      const f = await facts();
      const state = !channel.connected() ? 'unknown'
        : f.ok === false ? 'unknown'
          : f.ready === true ? 'ready'
            : f.sessionExists === true ? 'busy'
              : 'absent';
      return {
        ok: true,
        session: f.ok === false ? false : f.sessionExists === true,
        state,
        capturedAt: new Date().toISOString(),
        // 网页形态的「观看地址」：CLI 的 `awf attach` 经 /probe 拿它（跨进程唯一可用的事实源）
        ...(f.ok !== false && f.url ? { url: f.url } : {}),
        ...(f.ok === false ? { unknownReason: f.error } : {}),
      };
    },
  };

  const hook = {
    /**
     * DSH 平台事件 → 领域事件上抛（与 cc hook 端口同形：返回本次 emit 的条数）。
     * 事件由插件经 HTTP 回传（bridge 分发给本端口，接线在 P2-5）。
     * @param {{type: string}} payload DSH 事件
     * @param {{runId?: string}} [ctx]
     * @returns {number} emit 的事件条数（未知事件 0 条，不抛）
     */
    hook(payload, ctx = {}) {
      if (!payload || typeof payload.type !== 'string') return 0;
      const patch = factsFromEvent(payload);
      if (Object.keys(patch).length > 0) channel.noteFacts(patch);
      const mapper = DSH_EVENT_MAP[payload.type];
      if (!mapper) return 0;
      const ev = mapper(payload);
      if (!ev) return 0;
      emit(createEvent(ev.type, ev.payload, ctx.runId));
      return 1;
    },
  };

  const oneshot = {
    /**
     * 无状态一次性调用（对应平台 `ctx.llm.stream`）：不建会话、可超时可取消。
     * @param {{prompt: string, cwd?: string, timeoutMs?: number}} p
     */
    async runOneShot({ prompt, cwd, timeoutMs } = {}) {
      const r = await must('llm.oneshot', { prompt, cwd, timeoutMs });
      return { ok: r?.ok !== false, text: r?.text ?? '' };
    },
    // cc 机制方法：DSH 无「spawn claude -p」这个概念
    spawnClaudeP: unsupported('spawnClaudeP'),
    claudePArgs: unsupported('claudePArgs'),
  };

  const tooling = {
    /** 装配/卸载接入能力（DSH 侧 = profile 插件装配；无 pnpm 时走离线等价路径，F13） */
    async install(opts = {}) {
      return await must('plugin.install', opts);
    },
    async uninstall(opts = {}) {
      return await must('plugin.uninstall', opts);
    },
    // cc 机制方法（claude 命令字面与 marketplace 构造）：DSH 侧不适用
    claudeAvailable: unsupported('claudeAvailable'),
    buildMarketplaceAdd: unsupported('buildMarketplaceAdd'),
    buildInstall: unsupported('buildInstall'),
    buildUninstall: unsupported('buildUninstall'),
  };

  const interactive = {
    /**
     * 可脱离终端进程 launch 吗？DSH **可以**：它只是「开会话 + 注入指令 + 回网页 URL」，
     * 不需要占住调用方的终端。CLI 侧因此可以在**没有 bridge** 的进程里经 AWF server 的
     * `POST /interactive/plan` 触发（cc 不行：交互式对话必须占住用户终端，见 cc/interactive.cjs）。
     */
    detached: true,
    /**
     * 开始规划：DSH 侧在目标项目**新建会话并注入规划指令**，用户在网页里接着聊（U2/Q2）。
     * 与 cc 的「直开终端」不是同一形态，但对上层是同一个能力。
     * @param {{cwd: string, prompt: string}} opts
     */
    async launchDialog({ cwd, prompt } = {}) {
      const r = await must('plan.launch', { cwd, prompt });
      return { ok: true, url: r?.url ?? null, sessionId: r?.sessionId ?? null };
    },
  };

  // ── 平台事件入口接线 ──
  // bridge 是**进程级**的（一个 DSH 后台服务多项目），所以每个项目的适配器都会收到所有项目的事件；
  // 用 projectRoot 过滤（插件在每个事件里带 cwd）。有 bus 时才接（测试/无总线场景不订阅）。
  if (bus?.emit && typeof channel.onEvent === 'function') {
    channel.onEvent((payload) => {
      const cwd = payload?.cwd ?? null;
      // 别的项目的事件不接；路径比对走同一性判定（`/var` 与 `/private/var` 是同一处，F38）
      if (projectRoot && cwd && !isSamePath(cwd, projectRoot)) return;
      hook.hook(payload, {});
    });
  }

  return { host, hook, oneshot, tooling, interactive, probe, session };
}

module.exports = { createDshAdapters, checkPrerequisites, DSH_EVENT_MAP, RESULT_WINDOWS };
