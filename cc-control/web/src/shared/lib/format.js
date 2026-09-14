// Adapt current server records only; no product fields or persisted state are invented.
export const label = value => ({
  running: '运行中',
  queued: '排队中',
  active: '执行中',
  pending: '待执行',
  blocked: '阻塞',
  done: '已完成',
  error: '错误',
  stopped: '已停止',
  pause: '已暂停',
  run: '运行',
  idle: '空闲',
  awaiting_approval: '待审批',
  decision_required: '待决策',
  applied_review_pending: '已应用 · 待复审',
  applied: '已应用',
  rejected: '已拒绝',
  conflicted: '变更冲突',
  pending_review: '待确认',
  reviewed: '已复审',
  awaiting_human: '等待人工',
  overridden: '已调整'
})[value] || value || '—';
export const display = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
export function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
