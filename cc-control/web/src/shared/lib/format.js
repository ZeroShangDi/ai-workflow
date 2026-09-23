// Adapt current server records only; no product fields or persisted state are invented.
// 任务状态只有这五个（`awf_task_status` 的 enum：pending|active|done|blocked，error 由前端先支持）。
// 顺序即筛选下拉的展示顺序，与数据顺序无关。
export const TASK_STATUSES = ['active', 'pending', 'blocked', 'error', 'done'];
export const label = value =>
  ({
    failed: '失败',
    cancelled: '已取消',
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
    overridden: '已调整',
  })[value] ||
  value ||
  '—';
export const display = value =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2);
export function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
}
const pad2 = value => String(value).padStart(2, '0');
/** 解析时间戳；解析不出来时返回 null（调用方决定退回原文还是留空） */
function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
/** `2026-09-22 14:32` —— 弹窗等有充裕宽度的地方用完整形式 */
export function formatDateTime(value) {
  const date = toDate(value);
  if (!date) return value ? String(value) : '';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}
/** `09-22 14:32` —— 详情面板里的行内元信息用短式，省掉不增信息的年份 */
export function formatShortDateTime(value) {
  const date = toDate(value);
  if (!date) return value ? String(value) : '';
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}
