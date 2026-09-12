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
 *
 * 注意边界：本模块是**纯函数 + 局部状态**，不 import 任何能力层（tmux/decision/stores）；
 * 需要落盘时只经 store-core 的原子写。因此可被 api 直接调用而不引入耦合。
 *
 * 使用现状：生产侧只用到 `validateDecisionRequest`（server/api/index.cjs 的 /choice、/ask）。
 * 其余导出（isAwaitDecision / createReadyLatch / handoff 三件）目前由单测直接覆盖，
 * 是给「上下文接力」与「client/server 分离」预留的原语 —— 改它们前先确认没有别的消费方。
 */

const fs = require('node:fs');
const path = require('node:path');
const storeCore = require('./core/store-core.cjs');

/**
 * 校验并构造决策模型。
 * 只做「形状校验 + 归一化」，不落任何状态 —— 置 decisionPending 由调用方（api）负责。
 * @param {'choice'|'text'} kind   choice：选择题（带 options）；text：自由输入
 * @param {{ question?: string, options?: string[], context?: string }} body
 * @returns {{ ok: true, decision: object } | { ok: false, error: string }}
 */
function validateDecisionRequest(kind, body) {
  if (!body || typeof body.question !== 'string') {
    return { ok: false, error: `body must be {question: string${kind === 'choice' ? ', options?: string[]' : ''}}` };
  }
  const decision = { type: kind, question: body.question, context: body.context || null };
  // 仅 choice 带 options；text 不带（保持形状最小，消费方按 type 分支）
  if (kind === 'choice') decision.options = body.options || [];
  return { ok: true, decision };
}

/** 决策是否在等人回应（await 语义：choice/text）；null/undefined → false */
function isAwaitDecision(decision) {
  return !!decision && (decision.type === 'choice' || decision.type === 'text');
}

/** 上下文快照就绪闩锁（POST mark / GET 一次性 consume；reset 供 run 启动/测试重置） */
function createReadyLatch() {
  let ready = false;
  return {
    get: () => ready,
    mark: () => { ready = true; return ready; },      // 置位（可重复置，幂等）
    consume: () => { const r = ready; ready = false; return r; }, // 读取并清位（一次性）
    reset: () => { ready = false; },
  };
}

/** handoff 文件路径（.awf/context/handoff.md）—— 固定的项目内相对位置 */
function handoffPath(projectRoot) {
  return path.join(projectRoot, '.awf', 'context', 'handoff.md');
}

/** 读 handoff 快照；缺失 → null（不抛 —— 无快照是正常态，调用方按 null 走冷启动） */
function readHandoff(projectRoot) {
  try {
    return fs.readFileSync(handoffPath(projectRoot), 'utf8');
  } catch {
    return null;
  }
}

/** 写 handoff 快照（原子写），供上下文接力任务落盘 —— 用原子写避免半截文件被读走 */
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
