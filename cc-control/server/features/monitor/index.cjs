'use strict';
/**
 * monitor/index.cjs — 编排异常时的**介入**：诊断（拉起一次隔离的独立 claude 分析现场）
 *
 * 准入（features/ 判据「SDD 正常流程之外的处理」）：只有编排卡住/异常时才会走上的路径。
 *
 * ## 与前后两块的分工
 *   - **检测** → probe 端口（`adapters/cc/probe.cjs`；会话现场经 `GET /probe` 出给外部 w-monitor
 *     经 MCP 取用）+ `observability.metricsSnapshot()`（工作流进展）。本模块不做检测 ——
 *     它是「探到异常之后怎么办」。
 *   - **观测** → `observability/`（metrics / run-meta / agents / logger；横切只读）。
 *     诊断**不属于**观测：它会拉起一个 claude 进程、写快照、并在重启后改 `session.mainSessionId`。
 *     那是编排动作，所以归 features。
 *
 * ## 协议（这是它区别于「一段顺序代码」的地方）
 *   1. **互斥** —— 一次只允许一个诊断在跑（`inFlight`）；重复请求返 409（见 web/api/state.cjs）。
 *   2. **两拍写** —— 先写 `status:'running'` 占位快照立刻返回给调用方展示，结束后覆盖为 complete/failed。
 *   3. **隔离** —— 诊断进程用 `--safe-mode --no-session-persistence`（见 diagnosis.cjs），
 *      否则会被本项目 hooks 反过来影响。期间还要忽略隔离会话的 SessionStart（见 web/api/hook.cjs）。
 *   4. **上限** —— 单次 5 分钟（diagnosis.cjs 的 DIAGNOSIS_TIMEOUT_MS）。
 *   5. **后效对齐** —— 诊断起的是独立 claude，cc 可能换主会话 id。`reconcile()` 以快照为准
 *      对齐 `session.mainSessionId` 与 run-meta，否则 CLI 会按旧 id 认错会话。
 *      触发时机归观测（每次指标采集前回调），策略归这里。
 *
 * 机制层（prompt 拼装 / 快照读写 / 起进程）在 ./diagnosis.cjs。
 */

const path = require('node:path');
const { readRunMeta, updateRunMeta } = require('../../observability/metrics.cjs');
const { buildDiagnosisPrompt, diagnoseWithClaude, readDiagnosis, writeDiagnosis } = require('./diagnosis.cjs');
const { oneshot: oneshotPort } = require('../../adapters/ports.cjs');

/**
 * @param {object} deps
 * @param {object} deps.ctx            项目上下文（读 projectRoot / stores）
 * @param {object} deps.session        会话态（读写 mainSessionId —— 后效对齐的落点）
 * @param {object} deps.observability  观测面（metricsSnapshot / readProjectState / invalidateMetrics）
 * @param {object} [deps.oneshot]      cc oneshot 端口（诊断调用；缺省经 adapters 的 ports）
 * @returns {{ diagnose, reconcile, reset, inspect, readonly inFlight }}
 */
function createMonitor({ ctx, session, observability, oneshot = oneshotPort } = {}) {
  let inFlight = false; // 诊断互斥闩：一次只允许一个诊断在跑

  /**
   * 诊断后效：重启后会话 id 变了就把 mainSessionId / run-meta 对齐到诊断快照（否则 CLI 会认错会话）。
   * 同时把快照里记录的子 agent transcript 还原进 run-meta（它们已经不在了）。
   *
   * 只认 `status==='running'` 的快照 —— 进行中的诊断才会带来新会话事实。
   * 幂等：会话 id 一致时直接返回，重复调用无副作用。
   */
  function reconcile() {
    const record = readDiagnosis(ctx.projectRoot);
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
    observability.invalidateMetrics(); // 会话换了，指标缓存作废，强制重采
    console.log('[diagnosis] restored main session from diagnostic snapshot');
  }

  /**
   * 触发一次诊断（异步跑 claude -p；进行中重复调用返回错误，调用方据此回 409）。
   * @returns {Promise<{ ok: true, diagnosis: object } | { ok: false, error: string }>}
   */
  async function diagnose() {
    if (inFlight) return { ok: false, error: 'diagnosis already running' };

    const metrics = observability.metricsSnapshot();
    const stateSnapshot = observability.readProjectState();
    const pending = writeDiagnosis(ctx.projectRoot, {
      status: 'running',
      requestedAt: new Date().toISOString(),
      metrics,
      state: stateSnapshot,
      runMeta: readRunMeta(ctx.projectRoot),
    });
    inFlight = true;

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
      .finally(() => { inFlight = false; });

    return { ok: true, diagnosis: pending };
  }

  /** 读最近一次诊断快照（缺失/坏 JSON → null） */
  function inspect() {
    return readDiagnosis(ctx.projectRoot);
  }

  /** 收干净介入态（测试复位 / shutdown） */
  function reset() {
    inFlight = false;
  }

  return {
    diagnose,
    reconcile,
    inspect,
    reset,
    get inFlight() { return inFlight; },
    // 测试用：模拟「诊断进行中」而不真的起进程
    set inFlight(v) { inFlight = !!v; },
  };
}

module.exports = { createMonitor };
