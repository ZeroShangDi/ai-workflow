// web/src/views/diagnostics-model.js — Diagnostics 视图模型（纯函数）。
// T1-089：把 server 托管 diagnostics 的「指标快照 + AI 诊断记录 + 触发」展示逻辑迁到 web（可单测），
// 组件经此模型渲染。数据源：GET /awf/metrics { ok, metrics } + GET /awf/diagnostics { ok, diagnosis }。

/** 数值格式化（>=1000 → k 紧凑、小数 .0 修剪；非有限数值 → '—'） */
export function fmtTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(Math.round(value));
}

/** 时长格式化（ms → '9s'/'1m 05s'/'1h 01m 05s'；非有限数值 → '—'） */
export function fmtDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** 诊断记录状态标签（none=running/failed/complete 之外即未生成） */
export function statusLabel(s) {
  const map = { none: '未诊断', running: '分析中', complete: '已完成', failed: '失败' };
  return map[s] || s || '—';
}

/** 诊断严重度标签 */
export function severityLabel(s) {
  const map = { healthy: '健康', watch: '关注', attention: '需处理' };
  return map[s] || s || '—';
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 归一 Diagnostics 展示模型。
 * @param {{ metrics?: object, diagnosis?: object }} src
 *   metrics:   GET /awf/metrics 响应 { ok, metrics: {...} }
 *   diagnosis: GET /awf/diagnostics 响应 { ok, diagnosis: record|null }
 * @returns {object} 展示模型（诊断结论与指标缺失时安全兜底）
 */
export function toDiagnosticsModel({ metrics, diagnosis } = {}) {
  const snap = metrics && typeof metrics.metrics === 'object' ? metrics.metrics : {};
  const tk = snap.tokens && typeof snap.tokens === 'object' ? snap.tokens : {};
  const sp = snap.outputSpeed && typeof snap.outputSpeed === 'object' ? snap.outputSpeed : {};
  const ctx = snap.context && typeof snap.context === 'object' ? snap.context : null;

  const throughput = sp.currentTokensPerSecond !== undefined
    ? num(sp.currentTokensPerSecond)
    : sp.averageTokensPerSecond !== undefined ? num(sp.averageTokensPerSecond) : null;
  const throughputBasis = sp.basis === 'recent_60s'
    ? '最近 60s 端到端吞吐'
    : sp.basis === 'average' ? '全程端到端吞吐' : null;

  const rec = diagnosis && typeof diagnosis.diagnosis === 'object' && diagnosis.diagnosis !== null
    ? diagnosis.diagnosis
    : null;
  const done = rec && rec.status === 'complete' && rec.diagnosis && typeof rec.diagnosis === 'object';
  const d = done ? rec.diagnosis : null;

  return {
    hasMetrics: typeof snap.agentMode !== 'undefined' || typeof snap.elapsedMs !== 'undefined',
    agentModeLabel: snap.agentMode === 'multi' ? '多 Agent' : snap.agentMode === 'single' ? '单 Agent' : snap.agentMode || null,
    activeAgents: num(snap.activeAgents),
    maxAgents: num(snap.maxAgents),
    startedAt: snap.startedAt || null,
    endedAt: snap.endedAt || null,
    elapsedMs: num(snap.elapsedMs),
    tokens: {
      total: num(tk.total),
      input: num(tk.input),
      output: num(tk.output),
      cacheReadInput: num(tk.cacheReadInput),
      cacheCreationInput: num(tk.cacheCreationInput),
    },
    tokenCoverage: tk.coverage || null,
    coveredTranscripts: num(tk.coveredTranscripts),
    totalTranscripts: num(tk.totalTranscripts),
    missingSubagentTranscripts: num(tk.missingSubagentTranscripts),
    throughput,
    throughputBasis,
    context: ctx ? {
      usedPercentage: num(ctx.usedPercentage),
      totalInputTokens: num(ctx.totalInputTokens),
      contextWindowSize: num(ctx.contextWindowSize),
    } : null,
    diagnosisStatus: rec ? rec.status : 'none',
    diagnosisError: rec && rec.status === 'failed' ? (rec.error || null) : null,
    result: d ? {
      severity: d.severity || 'watch',
      summary: d.summary || null,
      findings: Array.isArray(d.findings) ? d.findings.slice(0, 6).map((item) => ({
        title: item?.title || '观察',
        evidence: item?.evidence || '未提供',
        impact: item?.impact || '待确认',
        recommendation: item?.recommendation || '继续观察',
      })) : [],
      dataGaps: Array.isArray(d.dataGaps) ? d.dataGaps.slice(0, 6).map(String) : [],
    } : null,
  };
}
