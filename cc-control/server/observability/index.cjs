'use strict';
/**
 * observability/index.cjs — 观测面：指标 / 诊断 / 运行通知 / 子 agent 观测
 *
 * 抽象动机：原 server.cjs 里 `metricsCache` / `diagnosisInFlight` / `agents` 是贴在共享 pcx 上的三个
 * 可变字段，读写散在 hook 处理、/status、/awf/metrics 各处。这里收敛为一个对象：**观测状态有归属**。
 *
 * 边界：只读地观察（读 state / 读 transcript / 读 meta），**不参与编排决策**；
 * 唯一写动作是诊断记录与 run-meta（都是观测产物，不是业务状态）。
 */

const path = require('node:path');
const { readRunMetrics, readRunMeta, updateRunMeta } = require('./metrics.cjs');
const { buildDiagnosisPrompt, diagnoseWithClaude, readDiagnosis, writeDiagnosis } = require('./diagnosis.cjs');
const { oneshot: oneshotPort } = require('../adapters/ports.cjs');

/**
 * @param {{ ctx: object, session: object, oneshot?: object }} deps
 *   ctx     项目上下文（读 projectRoot / stores / logger）
 *   session 会话态（读 mainSessionId —— 诊断快照要比对它判断「是不是换了会话」）
 *   oneshot cc oneshot 端口（诊断调用；缺省经 adapters 的 ports）
 */
function createObservability({ ctx, session, oneshot = oneshotPort }) {
  const agents = new Map();              // 子 agent 观测（按 session/agent id）
  let metricsCache = { at: 0, value: null }; // 指标 1s 缓存：{ at: 上次采集时刻, value: 上次结果 }
  let diagnosisInFlight = false;         // 诊断互斥闩：一次只允许一个诊断在跑

  /**
   * 诊断重启后，会话 id 变了就把 mainSessionId / run-meta 对齐到诊断快照（否则 CLI 会认错会话）。
   * 同时把快照里记录的子 agent transcript 还原进 run-meta（它们已经不在了）。
   *
   * 背景：诊断会拉起一个独立的 claude 进程，cc 可能换了主会话 id；CLI 侧按 mainSessionId 认会话，
   * 不对齐就会出现「CLI 找的会话不是真正在跑的那个」。此函数每轮指标读取前都会跑（见 metricsSnapshot），
   * 一旦发现诊断快照里的会话 id 与当前不同，即以快照为准修正 session 与 run-meta（run-meta 是观测产物）。
   */
  function reconcileDiagnosisSession() {
    const record = readDiagnosis(ctx.projectRoot);
    // 只认 status==='running' 的快照（进行中的诊断才会带来新会话事实）
    const snapshot = record?.status === 'running' ? record.metrics : null;
    const snapshotSessionId = snapshot?.sources?.mainSessionId;
    if (!snapshotSessionId || snapshotSessionId === session.mainSessionId) return;

    const meta = readRunMeta(ctx.projectRoot);
    const existingSubagents = meta.subagents || {};
    // run-meta 已有子 agent 就保留；否则从快照记录的 transcript 路径反推子 agent 清单
    // （排除主会话 transcript，用文件名去扩展名当 agentId）
    const restoredSubagents = Object.keys(existingSubagents).length > 0 ? existingSubagents : Object.fromEntries(
      (snapshot.sources.transcriptPaths || [])
        .filter((transcriptPath) => transcriptPath !== snapshot.sources.mainTranscriptPath)
        .map((transcriptPath) => {
          const agentId = path.basename(transcriptPath, '.jsonl');
          return [agentId, { agentId, status: 'unknown', transcriptPath }];
        }),
    );
    session.mainSessionId = snapshotSessionId;
    updateRunMeta(ctx.projectRoot, (current) => ({
      ...current,
      projectRoot: ctx.projectRoot,
      startedAt: snapshot.startedAt || current.startedAt || null,
      mainSessionId: snapshotSessionId,
      subagents: restoredSubagents,
      updatedAt: new Date().toISOString(),
    }));
    metricsCache = { at: 0, value: null }; // 会话换了，缓存作废，强制重采
    console.log('[diagnosis] restored main session from diagnostic snapshot');
  }

  /**
   * 运行指标快照（1s 缓存；会话/子 agent 数作为入参参与计算）。
   * 缓存命中直接返回上一份；否则 readRunMetrics 重新采集（要遍历解析 transcript，比较贵）。
   * 注意 reconcile 放在缓存判断**之前**：会话对齐不能被缓存跳过。
   */
  function metricsSnapshot() {
    reconcileDiagnosisSession();
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
   * 触发一次诊断（异步跑 claude -p；进行中重复调用返回错误）。
   * 写入分两拍：先写 status:'running' 占位快照（立即返回给调用方展示），
   * 诊断结束后用最终结果（complete/failed）覆盖同一文件。diagnosisInFlight 保证互斥。
   * @returns {{ ok: true, diagnosis: object } | { ok: false, error: string }}
   */
  async function startDiagnosis() {
    if (diagnosisInFlight) return { ok: false, error: 'diagnosis already running' };

    const metrics = metricsSnapshot();
    const stateSnapshot = readProjectState();
    const pending = writeDiagnosis(ctx.projectRoot, {
      status: 'running',
      requestedAt: new Date().toISOString(),
      metrics,
      state: stateSnapshot,
      runMeta: readRunMeta(ctx.projectRoot),
    });
    diagnosisInFlight = true;

    Promise.resolve(diagnoseWithClaude(buildDiagnosisPrompt(metrics, stateSnapshot), ctx.projectRoot, { oneshot }))
      .then((result) => {
        writeDiagnosis(ctx.projectRoot, {
          ...pending,
          status: result.ok ? 'complete' : 'failed',
          completedAt: new Date().toISOString(),
          diagnosis: result.diagnosis || null,
          error: result.ok ? null : result.error || 'unknown diagnosis error',
        });
      })
      .catch((error) => {
        writeDiagnosis(ctx.projectRoot, {
          ...pending,
          status: 'failed',
          completedAt: new Date().toISOString(),
          diagnosis: null,
          error: error.message,
        });
      })
      .finally(() => { diagnosisInFlight = false; });

    return { ok: true, diagnosis: pending };
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

  /** 收干净观测态（测试复位 / shutdown）：清 agents、作废缓存、解除诊断闩 */
  function reset() {
    agents.clear();
    metricsCache = { at: 0, value: null };
    diagnosisInFlight = false;
  }

  return {
    agents,
    trackAgent,
    activeAgentCount,
    metricsSnapshot,
    readProjectState,
    startDiagnosis,
    notice,
    pauseNoticeLog,
    reset,
    // 以下 getter/setter 供测试与外部复位读写观测内部态（如强制作废缓存、模拟诊断进行中）
    get diagnosisInFlight() { return diagnosisInFlight; },
    set diagnosisInFlight(v) { diagnosisInFlight = v; },
    set metricsCache(v) { metricsCache = v; },
  };
}

module.exports = { createObservability };
