'use strict';
/**
 * observability/index.cjs — 观测面：指标 / 运行通知 / 子 agent 观测
 *
 * 抽象动机：原 server.cjs 里 `metricsCache` / `agents` 是贴在共享 pcx 上的可变量，读写散在
 * hook 处理、/status、/awf/metrics 各处。这里收敛为一个对象：**观测状态有归属**。
 *
 * 边界：只读地观察（读 state / 读 transcript / 读 meta），**不参与编排决策**；
 * 唯一的写动作是 run-meta（观测产物，不是业务状态）。
 *
 * 诊断（拉起独立 claude 分析现场、写快照、改 session.mainSessionId）**不在这里** ——
 * 那是编排动作，归 `features/monitor/`。观测与它的耦合只有一处：指标采集前要先把
 * 「诊断后效」对齐掉（会话可能被诊断换过 id），这个时机由本模块通过注入的
 * `onBeforeSnapshot` 回调触发，策略在 monitor 侧 —— 两边不互相 require。
 */

const { readRunMetrics, readRunMeta, updateRunMeta } = require('./metrics.cjs');

/**
 * @param {{ ctx: object, session: object, onBeforeSnapshot?: Function }} deps
 *   ctx               项目上下文（读 projectRoot / stores / logger）
 *   session           会话态（读 mainSessionId —— 指标按主会话 transcript 采）
 *   onBeforeSnapshot  每次指标采集**之前**的钩子（装配根注入 monitor.reconcile；缺省不做事）。
 *                     放在缓存判断之前 —— 诊断换过会话时不能被缓存跳过。
 */
function createObservability({ ctx, session, onBeforeSnapshot } = {}) {
  const agents = new Map();              // 子 agent 观测（按 session/agent id）
  let metricsCache = { at: 0, value: null }; // 指标 1s 缓存：{ at: 上次采集时刻, value: 上次结果 }

  /** 指标缓存作废，强制下次重采（会话换了 / 新会话启动 / 诊断改过会话） */
  function invalidateMetrics() {
    metricsCache = { at: 0, value: null };
  }

  /**
   * 运行指标快照（1s 缓存；会话/子 agent 数作为入参参与计算）。
   * 缓存命中直接返回上一份；否则 readRunMetrics 重新采集（要遍历解析 transcript，比较贵）。
   */
  function metricsSnapshot() {
    if (typeof onBeforeSnapshot === 'function') onBeforeSnapshot();
    if (Date.now() - metricsCache.at < 1000 && metricsCache.value) return metricsCache.value;
    metricsCache = {
      at: Date.now(),
      value: readRunMetrics(ctx.projectRoot, {
        mainSessionId: session.mainSessionId,
        activeAgents: [...agents.values()].filter((a) => a.status === 'running').length,
      }),
    };
    return metricsCache.value;
  }

  /** 本项目当前 state（只读便捷） */
  function readProjectState() {
    return ctx.stores.state.readSync() || {};
  }

  /**
   * 编排层运维通知：一份进**本项目运行日志**（人读、w-monitor 读），一份进 **console**。
   * 自 T1-112 起 server 的 stdout/stderr 被接到 `.awf/logs/server.log` —— 于是「宿主在等什么、等多久」
   * 既在 run 日志里也在 server 日志里，不必再靠 transcript 反推。
   */
  function notice(kind, level, msg) {
    ctx.logger?.logNotice?.(kind, `[${level}] ${msg}`);
    console.error(`[${kind}][${level}] ${msg}`);
  }

  /** pause 闩锁的日志出口：包成 (level, msg) => void，供 core/pause.waitWhilePaused 直接当 logger 用 */
  function pauseNoticeLog() {
    return (level, msg) => notice('pause', level, msg);
  }

  /** 子 agent 观测登记（hook 侧调用）：把 patch 合并进该 key 的既有记录（同一 agent 会多次上报，如 Start/Stop） */
  function trackAgent(key, patch) {
    const prev = agents.get(key) || {};
    agents.set(key, { ...prev, ...patch });
    return agents.get(key);
  }

  /** 当前活跃（status==='running'）子 agent 数（供 /status 与指标采集） */
  function activeAgentCount() {
    return [...agents.values()].filter((a) => a.status === 'running').length;
  }

  /** 收干净观测态（测试复位 / shutdown）：清 agents、作废缓存 */
  function reset() {
    agents.clear();
    invalidateMetrics();
  }

  return {
    agents,
    trackAgent,
    activeAgentCount,
    metricsSnapshot,
    invalidateMetrics,
    readProjectState,
    notice,
    pauseNoticeLog,
    reset,
    // 测试用：直接替换指标缓存（模拟「刚采过」等）
    set metricsCache(v) { metricsCache = v; },
  };
}

module.exports = { createObservability };
