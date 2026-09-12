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

const { createProjectContext } = require('./context.cjs');
const { createSession } = require('../session/index.cjs');
const { createSingleExecutor } = require('../session/executor.cjs');
const { createSessionChannelFactory } = require('../session/channel.cjs');
const { createSubagentRecorder } = require('../observability/subagent.cjs');
const { createObservability } = require('../observability/index.cjs');
const { createDecisionHandler } = require('../decision/handler.cjs');
const gateRules = require('../decision/gate.cjs');
const replanning = require('../replanning/index.cjs');

/**
 * @param {{ projectRoot: string, env?: object, sid?: string, tmuxFactory?: Function, RunLogger?: Function }} input
 */
function createProjectRuntime({ projectRoot, env, sid, tmuxFactory, RunLogger } = {}) {
  const ctx = createProjectContext({ projectRoot, env, sid, tmuxFactory, RunLogger });

  // ── 会话态：主槽一个 Session；每个 sid 一个（承接原 run-slot 的职责）──
  const sessions = new Map();
  const session = createSession({ sid: ctx.sid, decisionSeqGen: gateRules.createDecisionSeq() });
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

  const observability = createObservability({ ctx, session });
  const subagent = createSubagentRecorder({
    paths: { event: ctx.subagentEventPath, failed: ctx.subagentFailedPath, needsInput: ctx.subagentNeedsPath },
    stores: ctx.stores,
  });

  // ── run host 装配位（惰性）──
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
  });

  const channel = createSessionChannelFactory({ ctx, session, observability });

  // ── state 写原语（惰性装载；测试可经 __CC_RUN_HOST_DEPS__.stateApi 覆盖）──
  let runStateApi = null;
  let runStateApiReady = null;
  async function ensureRunStateApi() {
    if (runStateApiReady) return runStateApiReady;
    runStateApiReady = (async () => {
      const override = global.__CC_RUN_HOST_DEPS__?.stateApi;
      if (override) {
        runStateApi = {
          saveState: override.saveState || (() => false),
          replaceStateIfUnchanged: override.replaceStateIfUnchanged || null,
          setWorkflowMode: override.setWorkflowMode || (() => false),
          markTaskActive: override.markTaskActive || (() => false),
          backupState: override.backupState || (() => undefined),
        };
        return runStateApi;
      }
      const state = await import('../core/state.js');
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
    const bridge = await import('../core/prompts.js');
    const { waitWhilePaused } = await import('../core/pause.js');
    const { createBatchTransport } = require('../run/transport.cjs');
    return createBatchTransport({
      send: async (text, label = 'batch-send') => {
        await waitWhilePaused(ctx.projectRoot, { label, log: observability.pauseNoticeLog() });
        // 派发不能静默丢失：主会话不就绪/未收尾 → 抛错让 run 显式失败，而不是让任务悬着等超时
        const ok = await channel.sendPromptAndWait(text);
        if (!ok) throw new Error(`派发未送达（主会话未在超时内就绪/收尾）：${String(text).slice(0, 60)}…`);
      },
      prompts: { subagentDispatch: bridge.subagentDispatch, resend: bridge.subagentResend },
      markActive: (id) => stateApi.markTaskActive(ctx.projectRoot, id),
      releaseActive: (id) => stateApi.requeueTaskIfActive?.(ctx.projectRoot, id) ?? false,
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
        stateApi = override.stateApi;
        cfg = override.cfg;
        chain = override.chain;
        schedulerFn = override.scheduler;
        gateFix = override.handleGateCompletion;
        executor = override.executor;
        batch = override.batch;
      } else {
        const state = await import('../core/state.js');
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
        const gf = await import('../run/gate-fix.js');
        gateFix = gf.handleGateCompletion;
        chain = require('../run/driver.cjs');
        executor = createSingleExecutor({ ctx, session, channel, observability });
        batch = await batchTransportFor(stateApi);
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
      host.start();
      runHost = host;
      return host;
    })().catch((err) => {
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

  /** 把本项目的一切运行态收干净（测试复位 / shutdown） */
  function reset() {
    session.clearFallbackTimer();
    session.reset();
    for (const s of sessions.values()) {
      s.clearFallbackTimer();
      s.reset();
    }
    sessions.clear();
    observability.reset();
    if (runHost) { try { runHost.stop(); } catch { /* ignore */ } }
    runHost = null;
    runHostReady = null;
    runHostBootErr = null;
    runStateApi = null;
    runStateApiReady = null;
    dynamicPlanning = null;
  }

  return {
    ctx,
    session,
    sessions,
    sessionFor,
    subagent,
    decision,
    observability,
    channel,
    ensureRunHost,
    ensureRunStateApi,
    batchTransportFor,
    publishEvent,
    dynamicPlanning: dynamicPlanningService,
    reset,
    get runHost() { return runHost; },
    get runHostBootErr() { return runHostBootErr; },
    get runStateApi() { return runStateApi; },
  };
}

module.exports = { createProjectRuntime };
