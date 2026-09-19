/**
 * approval.js — 批准请求的应答者缝（U16）
 *
 * DSH 的 `approval/request` 是 waterfall：返回 `'allowed-once'` 即认领，`next()` 委派给下一个
 * 应答者（UI / 人工；无应答者时平台 fail closed = 拒绝）。
 *
 * **当前策略：只记录 + 委派，不自动批准。**
 * 理由：实测（P2-5e）表明 `workspace-write` 预设下**项目内**操作由沙箱 auto-allow、不会请求批准，
 * 只有越出沙箱才问；在没有把「什么会触发批准」测全之前自动批准，可能把沙箱边界一起放开。
 * 记录下来的事实（toolName / reason / sessionId / 是否 AWF 会话）经事件上报给 AWF，
 * 作为将来定策略（受控自动批准 vs 接入 AWF 介入机制）的依据。
 */

/**
 * @param {{createdByAwf: Set<string>, noteApproval: Function, emit: Function, log: Function}} deps
 * @returns {(req: object, next: Function) => any} Cordis waterfall 处理器
 */
export function createApprovalResponder({ createdByAwf, noteApproval, emit, log }) {
  return (req, next) => {
    const sessionId = req?.agent?.session?.header?.id ?? null;
    const ours = sessionId !== null && createdByAwf.has(sessionId);
    noteApproval(req, { sessionId, ours });
    emit({
      type: 'approval.requested',
      sessionId,
      ours,
      toolName: req?.toolName ?? null,
      reason: req?.reason ?? null,
    });
    log('info', `批准请求（${ours ? 'AWF 会话' : '非 AWF 会话'}）：tool=${req?.toolName ?? '?'} reason=${String(req?.reason ?? '').slice(0, 120)}`);
    return next();
  };
}
