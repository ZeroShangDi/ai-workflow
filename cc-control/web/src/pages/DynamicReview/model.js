/**
 * 动态任务复审的展示口径。
 *
 * 审查状态（`proposal.status`）现在**就是**决策那一套取值（`pending_review` / `awaiting_human` /
 * `approved` / `adjusted`），由服务端直接写这个值 —— 之前那层「8 个内部状态 → 4 个审查状态」
 * 的映射是两个维度混装在一个字段里时的临时脚手架，字段拆开之后就不需要了。
 */
const ACTIONABLE = ['awaiting_human', 'pending_review'];

/**
 * 该审查状态是否可处理 —— 只有这两个状态下才出「批准和应用 / 提交其他方案」。
 * 已采纳是终态：自动模式下那是事后签收，不产生新动作。
 */
export const isActionable = status => ACTIONABLE.includes(status);
