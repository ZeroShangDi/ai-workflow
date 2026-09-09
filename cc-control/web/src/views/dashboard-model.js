// web/src/views/dashboard-model.js — Dashboard 视图模型（纯函数：server payload → 展示模型）。
// T1-087：把 server 托管 dashboard 的展示逻辑迁到 web（可单测），组件经此模型渲染。

/**
 * 归一化 Dashboard 快照。
 * @param {{ runStatus?: object, status?: object, metrics?: object }} src
 *   runStatus: GET /run/status 响应 { ok, runs: [...] }（或 { ok, run }）
 *   status:    GET /status 响应 { state, projectRoot, decisionPending, contextReady, ... }
 *   metrics:   GET /awf/metrics 响应 { ok, metrics: {...} }
 * @returns {object} 展示模型
 */
export function toDashboardModel({ runStatus, status, metrics } = {}) {
  const runs = Array.isArray(runStatus?.runs) ? runStatus.runs : (runStatus?.run ? [runStatus.run] : []);
  const run = runs.find((r) => r.status === 'running' || r.status === 'queued') || runs[0] || null;
  const counts = run?.counts || {};
  return {
    projectRoot: status?.projectRoot || null,
    sessionState: status?.state || 'unknown',
    decisionPending: status?.decisionPending || null,
    contextReady: !!status?.contextReady,
    runId: run?.runId || null,
    runStatus: run?.status || 'idle',
    mode: run?.mode || 'single',
    counts,
    progress: counts.total ? `${counts.done}/${counts.total}` : '0/0',
    currentTaskTitle: run?.currentTaskTitle || run?.currentTaskId || null,
    currentStage: run?.currentStage || null,
    runs,
    metrics: metrics?.metrics && typeof metrics.metrics === 'object' ? metrics.metrics : {},
    activeAgents: status?.activeAgents ?? 0,
    decisionResume: status?.decisionResume || null,
  };
}

/** 阶段链标签（由 currentState/phase 派生展示文案） */
export function phaseLabel(currentState) {
  const map = {
    PLAN: '规划', DESIGN: '设计', CODE: '编码', REVIEW: '审查', TEST: '测试', FINISH: '完成', IDLE: '空闲',
  };
  return map[currentState] || currentState || '—';
}

/** 事件 → 模型字段级更新（WS 增量；返回新 partial，组件 merge） */
export function applyRunEvent(model, event) {
  if (!event) return model;
  const p = event.payload || {};
  switch (event.type) {
    case 'task.done':
    case 'task.blocked':
    case 'task.started':
      return { ...model, currentTaskId: p.taskId, lastEvent: event.type };
    case 'run.stopped':
      return { ...model, runStatus: p.status || 'done', lastEvent: event.type };
    default:
      return { ...model, lastEvent: event.type };
  }
}
