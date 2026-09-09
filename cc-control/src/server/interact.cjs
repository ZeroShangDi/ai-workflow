'use strict';
/**
 * interact.cjs — interact / context-ready / await 逻辑归位 + handoff（上下文接力）
 *
 * 把散在 server.cjs / CLI 的交互决策（choice/ask/respond）、上下文就绪闩锁、handoff 文件读写
 * 收敛为纯模块，供单 agent 现状委托与后续 client/server 分离复用：
 *   - validateDecisionRequest(kind, body) → { ok, decision? , error? }（kind: 'choice' | 'text'）
 *       决策模型统一 { type:'choice'|'text', question, options?, context? }
 *   - isAwaitDecision(decision)：决策是否在等人回应（choice/text）
 *   - createReadyLatch()：上下文快照就绪闩锁（POST mark / GET consume 一次性；reset 供 run 重置）
 *   - handoffPath / readHandoff / writeHandoff：.awf/context/handoff.md（code-context-onboard 接力）
 * 状态性副作用（decisionPending/setDecision/contextReady flag）仍由 server.cjs 编排（按 sid 实例化归 W1-071）。
 */

const fs = require('node:fs');
const path = require('node:path');
const storeCore = require('../lib/store-core.cjs');

/**
 * 校验并构造决策模型。
 * @param {'choice'|'text'} kind
 * @param {{ question?: string, options?: string[], context?: string }} body
 */
function validateDecisionRequest(kind, body) {
  if (!body || typeof body.question !== 'string') {
    return { ok: false, error: `body must be {question: string${kind === 'choice' ? ', options?: string[]' : ''}}` };
  }
  const decision = { type: kind, question: body.question, context: body.context || null };
  if (kind === 'choice') decision.options = body.options || [];
  return { ok: true, decision };
}

/** 决策是否在等人回应（await 语义：choice/text） */
function isAwaitDecision(decision) {
  return !!decision && (decision.type === 'choice' || decision.type === 'text');
}

/** 上下文快照就绪闩锁（POST mark / GET 一次性 consume；reset 供 run 启动/测试重置） */
function createReadyLatch() {
  let ready = false;
  return {
    get: () => ready,
    mark: () => { ready = true; return ready; },
    consume: () => { const r = ready; ready = false; return r; },
    reset: () => { ready = false; },
  };
}

/** handoff 文件路径（.awf/context/handoff.md） */
function handoffPath(projectRoot) {
  return path.join(projectRoot, '.awf', 'context', 'handoff.md');
}

/** 读 handoff 快照；缺失 → null */
function readHandoff(projectRoot) {
  try {
    return fs.readFileSync(handoffPath(projectRoot), 'utf8');
  } catch {
    return null;
  }
}

/** 写 handoff 快照（原子写），供上下文接力任务落盘 */
function writeHandoff(projectRoot, text) {
  storeCore.atomicWriteFileSync(handoffPath(projectRoot), text);
}

module.exports = {
  validateDecisionRequest,
  isAwaitDecision,
  createReadyLatch,
  handoffPath,
  readHandoff,
  writeHandoff,
};
