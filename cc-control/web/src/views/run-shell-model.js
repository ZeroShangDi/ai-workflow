// web/src/views/run-shell-model.js — 多 run 列表壳模型（纯函数）。
// T1-092：把 T1-074 hosted dashboard runShell 的「宿主 /run/status → 多 run 列表」逻辑迁到 web（可单测）。
// 数据源：GET /run/status → { ok, runs: [...] }；前端壳据此渲染 run 切换 + 视图 ?view&?sid 导航。

/** 归一单条 run（缺字段安全兜底；counts 聚合 progress） */
export function normalizeRun(r = {}) {
  const counts = r.counts && typeof r.counts === 'object' ? r.counts : {};
  const done = counts.done ?? 0;
  const total = counts.total ?? 0;
  return {
    runId: r.runId || null,
    status: r.status || 'unknown',
    mode: r.mode || null,
    error: r.error || null,
    progress: total ? `${done}/${total}` : '0/0',
    counts: {
      done, total, blocked: counts.blocked ?? 0,
      active: counts.active ?? 0, pending: counts.pending ?? 0,
    },
    currentTaskTitle: r.currentTaskTitle || r.currentTaskId || null,
    startedAt: r.startedAt || null,
  };
}

/**
 * 归一 run 列表壳模型。
 * @param {{ runs?: object[], ok?: boolean }} resp  GET /run/status 响应
 * @returns {{ runs: object[], active: object|null, total: number, isEmpty: boolean }}
 *   active：running/queued 优先，否则第一个；无 run → null
 */
export function toRunShellModel(resp = {}) {
  const raw = Array.isArray(resp?.runs) ? resp.runs : [];
  const runs = raw.map(normalizeRun);
  // active：running 优先，其次 queued，再首条（宿主单 active run，实际只有其一）
  const active = runs.find((r) => r.status === 'running')
    || runs.find((r) => r.status === 'queued')
    || runs[0] || null;
  return { runs, active, total: runs.length, isEmpty: runs.length === 0 };
}

/** run 摘要文案（列表行展示；字段缺省回退） */
export function runSummary(r) {
  if (!r || !r.runId) return '(无 run)';
  const head = r.runId;
  const state = r.status || '';
  const progress = r.progress ? ` · ${r.progress}` : '';
  const task = r.currentTaskTitle ? ` · ${r.currentTaskTitle}` : '';
  return `${head} [${state}]${progress}${task}`;
}
