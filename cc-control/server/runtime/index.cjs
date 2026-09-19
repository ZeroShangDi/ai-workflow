'use strict';
/**
 * projects/runtime.cjs — 每项目能力装配（runtime）
 *
 * 新的**装配核心**：把「一个项目的全部能力实例」装成一份 runtime。
 *
 * 与旧形态的关键差别：这些实例的**状态**过去贴在共享 pcx 上（`pcx.runHost` / `pcx.taskChannel` /
 * `pcx.runStateApi` / `pcx.metricsCache` …），于是没有任何模块能独立测试、也没有人能说清
 * 「谁在什么时候改了它」。现在它们都是 runtime 的**成员**：生命周期清晰，`reset()` 一次收干净。
 *
 * 依赖方向（只许向下）：
 *   runtime ─→ context（纯上下文）
 *           ─→ session/*（会话态 + 执行器 + 通道）
 *           ─→ run/*（编排域）
 *           ─→ decision/*（决策）
 *           ─→ observability/*（观测）
 *           ─→ adapters（经 ports 取 cc 能力）
 */

const { createProjectContext } = require('./project.cjs');
const { createSession } = require('./session.cjs');
const { createSingleExecutor } = require('./executor.cjs');
const { createSessionChannelFactory } = require('./channel.cjs');
const { createSubagentRecorder } = require('../run/subagent.cjs');
const { createObservability } = require('../observability/index.cjs');
const { createDecisionHandler } = require('../features/decision/handler.cjs');
const gateRules = require('../features/decision/gate.cjs');
const replanning = require('../features/replanning/index.cjs');
const { createMonitor } = require('../features/monitor/index.cjs');
const { createEventBus } = require('../shared/events.cjs');

/**
 * @param {{ projectRoot: string, env?: object, sid?: string, hostFactory?: Function, RunLogger?: Function, adapterDeps?: object }} input
 * @returns runtime：ctx（纯上下文）+ 各能力实例 + 惰性装配入口（ensureRunHost / ensureRunStateApi / dynamicPlanning）
 */
function createProjectRuntime({ projectRoot, env, sid, hostFactory, RunLogger, adapterDeps } = {}) {
  // 装配顺序（有依赖，别乱动）：
  //   ① ctx（纯上下文）先建 —— 后面所有成员都从这里取出口
  //   ② session（会话态）—— decision/subagent/observability/channel 都依赖它
  //   ③ observability / subagent —— 依赖 ctx + session
  //   ④ decision —— 依赖 session + ctx 出口 + publishEvent
  //   ⑤ channel（通道）—— 依赖 ctx + session + observability
  //   ⑥ runHost / runStateApi / dynamicPlanning —— 惰性（首次用到才建），见各自 ensure*
  // 平台事件总线：适配器把平台事件翻译成领域事件后 emit 到这里（dsh 的 hook 端口就是这么接的）。
  // 订阅方是下面的会话态映射 —— 它是 CC 侧 `/hook` 路由的**等价物**（DSH 没有 hook 路由）。
  const bus = createEventBus();
  const ctx = createProjectContext({
    projectRoot,
    env,
    sid,
    hostFactory,
    RunLogger,
    adapterDeps: { ...(adapterDeps || {}), bus },
  });

  // ── 会话态：主槽一个 Session；每个 sid 一个（承接原 run-slot 的职责）──
  // 主槽 sid = ctx.sid；sid 槽按需懒建并缓存。decisionSeqGen 由 gate 规则提供，保证决策序号单调。
  const sessions = new Map();
  const session = createSession({ sid: ctx.sid, decisionSeqGen: gateRules.createDecisionSeq() });
  /** 取某 sid 的会话槽（懒建）；空 sid → null（无 sid 的请求走主槽） */
  function sessionFor(sidKey) {
    if (sidKey == null || sidKey === '') return null;
    const key = String(sidKey);
    let s = sessions.get(key);
    if (!s) {
      s = createSession({ sid: key, decisionSeqGen: gateRules.createDecisionSeq() });
      sessions.set(key, s);
    }
    return s;
  }

  // monitor 在 observability 之后装配（它要读指标与 state），而 observability 的采集前钩子
  // 又指向它 —— 用 let + 闭包打破构造期先后（钩子运行时才被调用）
  let monitor = null;

  const observability = createObservability({
    ctx,
    session,
    // 指标采集前先做「诊断后效」对齐（会话可能被诊断换过 id）：时机归观测，策略归 monitor。
    // 闭包 + 下面的 `let`：钩子只在运行时被调用，那时 monitor 已装配就位。
    onBeforeSnapshot: () => monitor?.reconcile(),
  });
  const subagent = createSubagentRecorder({
    paths: { event: ctx.subagentEventPath, failed: ctx.subagentFailedPath, needsInput: ctx.subagentNeedsPath },
    stores: ctx.stores,
  });

  // ── run host 装配位（惰性）──
  // runHost：装配后的宿主；runHostReady：装配中的 promise（防并发重复装配）；runHostBootErr：失败原因
  let runHost = null;
  let runHostReady = null;
  let runHostBootErr = null;

  /** 往 run host 事件环推事件（host 未装配时静默跳过） */
  function publishEvent(type, payload) {
    if (runHost && typeof runHost.publish === 'function') {
      try { runHost.publish(type, payload); } catch { /* 推送失败不影响主流程 */ }
    }
  }

  const decision = createDecisionHandler({
    session,
    logger: ctx.logger,
    newDecisionStore: ctx.newDecisionStore,
    decisionEnabled: ctx.decisionEnabled,
    publishEvent,
    stores: ctx.stores,
  });

  const channel = createSessionChannelFactory({ ctx, session, observability });

  // ── 平台事件 → 会话态（CC 的等价物在 web/api/hook.cjs；DSH 没有 hook 路由，故在装配层接）──
  // 只认「平台说了什么」：turn/end → READY、prompt 提交 → BUSY、会话起来 → ready + 会话序号 +1
  //（会话序号让 CLI 的「等会话就绪」在 DSH 侧也能工作）。
  bus.on('run.phase', (event) => {
    const phase = event?.payload?.phase;
    if (phase === 'BUSY') session.setBusy();
    else if (phase === 'READY') session.setReady();
    publishEvent('session.phase', { phase, runId: event?.runId ?? null });
  });
  bus.on('run.started', () => {
    session.setReady();
    session.bumpSessionSeq();
    publishEvent('session.ready', { via: 'platform' });
  });
  bus.on('run.stopped', () => {
    session.clearDecision?.();
    session.setReady();
  });

  // ── 侦查端口（probe）──
  // 消费方在**外部**：w-monitor 经 MCP awf_session_status → HTTP GET /probe 拿到
  // 「会话在不在 + ready/busy + 抓取时刻」。server 内部不用它 —— 内部守卫要的是
  // 「会话没了就 503」的动作语义，那属于 host 端口；probe 是只读观测，且没有失败态。
  // status 注入进程内读会话态：不给自己的 /status 打回环 HTTP。
  // probe 工厂取自**本项目解析出的平台适配器**（T-P1-01）：dsh 的 probe 与 cc 不同实现，
  // 不能在这里写死 cc 的工厂。
  // probe：cc 需要调用方注入 host/status，故 `impls.probe` 是工厂；DSH 的 probe 自带 bridge，
  // 平台注册表给的是空 impls → 回落用已绑定的端口句柄。
  const probeFactory = ctx.adapters.impls?.probe;
  const probe = typeof probeFactory === 'function'
    ? probeFactory({ host: ctx.host, status: () => ({ state: session.state }) })
    : ctx.adapters.ports.probe;

  // ── 介入（monitor.features）──
  // 诊断：编排异常时拉起一次隔离的 claude -p 分析现场（协议见 features/monitor/index.cjs）。
  // 它的「检测」一半不在这里：会话现场走上面的 probe 端口，工作流进展走 observability。
  monitor = createMonitor({ ctx, session, observability, oneshot: ctx.adapters.ports.oneshot });

  // ── state 写原语（惰性装载；测试可经 __CC_RUN_HOST_DEPS__.stateApi 覆盖）──
  // 用「ready promise + 结果变量」双重缓存：-Ready 防并发重复装载，-Api 是可用引用（失败时置 null）
  let runStateApi = null;
  let runStateApiReady = null;
  /**
   * 装载 state 写原语（saveState / replaceStateIfUnchanged / setWorkflowMode / markTaskActive / backupState）。
   * 优先用测试覆盖（global.__CC_RUN_HOST_DEPS__.stateApi），否则动态 import core/state.js。
   * 失败不抛：清引用并返回 null，由调用方检查后回 503。
   */
  async function ensureRunStateApi() {
    if (runStateApiReady) return runStateApiReady;
    runStateApiReady = (async () => {
      const override = global.__CC_RUN_HOST_DEPS__?.stateApi;
      if (override) {
        // 测试覆盖：缺哪个方法就补一个返回固定值的占位（保持形状，便于断言「没被调用」）
        runStateApi = {
          saveState: override.saveState || (() => false),
          replaceStateIfUnchanged: override.replaceStateIfUnchanged || null,
          setWorkflowMode: override.setWorkflowMode || (() => false),
          markTaskActive: override.markTaskActive || (() => false),
          backupState: override.backupState || (() => undefined),
        };
        return runStateApi;
      }
      const state = await import('../shared/state.js');
      // 包一层显式端口：把 core/state 的函数收敛成 runtime 对外承诺的固定接口（cli/api 只见这层）
      runStateApi = {
        saveState: (r, s) => state.saveState(r, s),
        replaceStateIfUnchanged: (r, s, expected, fingerprint) => (
          state.replaceStateIfUnchanged(r, s, expected, fingerprint)
        ),
        setWorkflowMode: (r, m) => state.setWorkflowMode(r, m),
        markTaskActive: (r, id) => state.markTaskActive(r, id),
        backupState: (r) => state.backupState(r),
      };
      return runStateApi;
    })().catch((err) => {
      // 失败要清掉两个缓存，否则后续调用会拿到 rejected/半成品
      runStateApi = null;
      runStateApiReady = null;
      console.error(`[server] state api 装载失败: ${err.message}`);
      return null;
    });
    return runStateApiReady;
  }

  /**
   * 多 agent 传输：把 run/transport.cjs 的端口接到本项目现场。
   * 派发经会话注入 subagentDispatch 提示词（主会话派生后台子 Agent），完成感知轮询本项目 state。
   */
  async function batchTransportFor(stateApi) {
    const bridge = await import('../shared/prompts.js');
    const { waitWhilePaused } = await import('../features/pause/index.js');
    const { createBatchTransport } = require('../run/transport.cjs');
    return createBatchTransport({
      send: async (text, label = 'batch-send') => {
        await waitWhilePaused(ctx.projectRoot, { label, log: observability.pauseNoticeLog() });
        // 派发不能静默丢失：主会话不就绪/未收尾 → 抛错让 run 显式失败，而不是让任务悬着等超时
        const ok = await channel.sendPromptAndWait(text);
        if (!ok) throw new Error(`派发未送达（主会话未在超时内就绪/收尾）：${String(text).slice(0, 60)}…`);
      },
      prompts: {
        subagentDispatch: bridge.subagentDispatch,
        subagentRedispatch: bridge.subagentRedispatch,
        resend: bridge.subagentResend,
      },
      markActive: (id) => stateApi.markTaskActive(ctx.projectRoot, id),
      releaseActive: (id) => stateApi.requeueTaskIfActive?.(ctx.projectRoot, id) ?? false,
      // 连续派发均未生效（主会话收下提示词却不派子 Agent）→ 标 blocked 让编排跳过，
      // 与收尾协商「多轮无产出 → blocked」同一语义；不这样做 run 会干等到超时。
      markBlocked: (id) => ctx.stores.state.updateSync((s) => {
        const t = (s?.tasks || []).find((x) => x.id === id);
        if (!t) return false;
        t.status = 'blocked';
        return true;
      }),
      readTasks: () => ctx.stores.state.readSync()?.tasks || [],
      isBusy: () => session.state === 'busy',
      decisionPending: () => session.decisionPending,
      failedPath: ctx.subagentFailedPath,
      needsPath: ctx.subagentNeedsPath,
      eventsPath: ctx.subagentEventPath,
      waitWhilePaused: (opts = {}) => waitWhilePaused(ctx.projectRoot, { log: observability.pauseNoticeLog(), ...opts }),
      log: (level, msg) => observability.notice('batch', level, msg),
    });
  }

  /** 装配 run host（每项目惰性单例；失败记录原因不抛） */
  async function ensureRunHost() {
    if (runHostReady) return runHostReady;
    runHostReady = (async () => {
      const override = global.__CC_RUN_HOST_DEPS__; // 测试整体覆盖
      let stateApi;
      let cfg;
      let chain;
      let schedulerFn;
      let gateFix;
      let executor;
      let batch;
      if (override) {
        // 测试路径：所有依赖从 override 取（不进磁盘、不起常驻宿主逻辑）
        stateApi = override.stateApi;
        cfg = override.cfg;
        chain = override.chain;
        schedulerFn = override.scheduler;
        gateFix = override.handleGateCompletion;
        executor = override.executor;
        batch = override.batch;
      } else {
        // 生产路径：动态装载 run 配置 / 调度器 / 门禁修复，再建执行器与批传输
        const state = await import('../shared/state.js');
        stateApi = {
          loadState: (r) => state.loadState(r),
          saveState: (r, s) => state.saveState(r, s),
          markTaskActive: (r, id) => state.markTaskActive(r, id),
          requeueTaskIfActive: (r, id) => state.requeueTaskIfActive(r, id),
          findNextTask: (s) => state.findNextTask(s),
          setWorkflowMode: (r, m) => state.setWorkflowMode(r, m),
          backupState: (r) => state.backupState(r), // run 结束版本归档
        };
        const rc = await import('../run/config.js');
        cfg = rc.loadRunConfig(ctx.projectRoot);
        const sch = await import('../run/scheduler.js');
        schedulerFn = sch.runScheduler;
        gateFix = await ensureGateFix();
        chain = require('../run/driver.cjs');
        executor = createSingleExecutor({ ctx, session, channel, observability }); // 单 agent 执行器
        batch = await batchTransportFor(stateApi); // 多 agent 传输
      }
      const { createRunHost } = require('../run/host.cjs');
      const host = createRunHost({
        projectRoot: ctx.projectRoot,
        cfg,
        state: stateApi,
        chain,
        handleGateCompletion: gateFix,
        scheduler: schedulerFn,
        executor,
        batch,
      });
      host.start(); // 宿主立即开始运转（事件环 + 调度）
      runHost = host;
      return host;
    })().catch((err) => {
      // 装配失败：记原因返回 null（api 据此回 503），不改 runHost
      runHostBootErr = err;
      console.error(`[server] run host bootstrap 失败: ${err.message}`);
      return null;
    });
    return runHostReady;
  }

  /** 动态任务规划服务（每项目惰性单例；协议/策略/记录锚定本项目） */
  let dynamicPlanning = null;
  function dynamicPlanningService() {
    if (!dynamicPlanning) {
      dynamicPlanning = replanning.createDynamicPlanningService({
        projectRoot: ctx.projectRoot,
        decisionPort: replanning.createDynamicPlanningDecisionPort({
          storeFactory: () => ctx.newDecisionStore(),
        }),
      });
    }
    return dynamicPlanning;
  }

  /**
   * 门禁闭环入口（懒装载；run host 与 web 路由共用同一份实现）。
   * 消费方一律经这里取 —— web 层不直连 features 内部文件。
   */
  let gateFixFn = null;
  async function ensureGateFix() {
    if (!gateFixFn) gateFixFn = (await import('../features/gate/fix.js')).handleGateCompletion;
    return gateFixFn;
  }

  /** 把本项目的一切运行态收干净（测试复位 / shutdown） */
  function reset() {
    session.clearFallbackTimer();
    session.reset();
    for (const s of sessions.values()) {
      s.clearFallbackTimer(); // 兜底定时器不属于 session.reset，单独清
      s.reset();
    }
    sessions.clear();
    observability.reset();
    monitor?.reset(); // 解除诊断互斥闩
    if (runHost) { try { runHost.stop(); } catch { /* ignore */ } } // 停宿主
    // 清掉所有惰性装配缓存，使下次 ensure* 重新装配
    runHost = null;
    runHostReady = null;
    runHostBootErr = null;
    runStateApi = null;
    runStateApiReady = null;
    dynamicPlanning = null;
  }

  return {
    ctx,
    session,      // 主槽会话（无 sid 的请求用它）
    sessions,     // sid → Session（多 run 分片）
    sessionFor,   // 取/建 sid 槽
    subagent,     // 子 Agent 记录器（SubagentStart/Stop 落账）
    decision,     // 决策处理器（onStop / onAskUserQuestion）
    observability,
    channel,      // 会话通道工厂（sendPromptAndWait / sendLocalCmd / channel()）
    probe,        // 侦查端口（GET /probe 用；供外部 w-monitor 经 MCP 取会话现场）
    monitor,      // 介入：诊断（GET/POST /awf/diagnostics 用；协议见 features/monitor）
    ensureRunHost,
    ensureRunStateApi,
    ensureGateFix,
    batchTransportFor,
    publishEvent,
    dynamicPlanning: dynamicPlanningService,
    reset,
    // 惰性装配的只读视图（getter：读到的是最新装配结果，不是快照）
    get runHost() { return runHost; },
    get runHostBootErr() { return runHostBootErr; },
    get runStateApi() { return runStateApi; },
  };
}

module.exports = { createProjectRuntime };
