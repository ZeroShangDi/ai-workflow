'use strict';
/**
 * decision-gate.cjs — 决策闸门规则归位（单 agent）
 *
 * 把散在 server.cjs 的决策闸门「规则层」收敛到本模块：标记检测、Stop 三分支分类、
 * AskUserQuestion 决策化分类、deferred fallback / 完成记录构造。server.cjs 只保留
 * 副作用编排（decisionPending/decisionGate/decisionResume/ready/logger/store 等闭包），
 * 分支判定经本模块返回——为后续按 sid 实例化（W1-032/071）提供纯逻辑。
 *
 * 分类约定（与 v0.2.0 单 agent 语义一致）：
 *   classifyStop：gate 关 → complete；gate 开 & 非 deciding：
 *       结束文本以 <AWF_DECISION_REQUIRED> 结尾 & 非 stop_hook_active → deciding(②)
 *       否则 → complete(①)；gate 开 & deciding → resolve(③)
 *   classifyAskQuestion：gate 关 → capture（维持现状上抛）；gate 开 & deciding → deny(重复提问)；
 *       gate 开 & 非 deciding → deny(指引改以决策标签收尾)
 */

/** 决策必需标签 <AWF_DECISION_REQUIRED>…</…> 且位于文本结尾 */
const DECISION_REQUIRED_RE = /<\s*AWF_DECISION_REQUIRED\s*>[\s\S]*?<\s*\/\s*AWF_DECISION_REQUIRED\s*>\s*$/;

/** 结束文本是否以决策必需标记结尾 */
function endsWithDecisionRequired(text) {
  return DECISION_REQUIRED_RE.test(text);
}

/** 无有效结果兜底：构造 deferred fallback（不悬空），与正式结果同样落盘进 Review */
function deferredFallbackResult() {
  return {
    answer: '当前无法可靠完成该决策，延后处理。继续执行所有不依赖该决策的工作；如果当前分支必须依赖该决策，则停止继续扩展该分支并留待审查或后续任务处理。',
    type: 'deferred',
    finality: 'provisional',
    impact: 'medium',
    real_question: '沿用原决策问题',
    decisive_factors: ['决策过程未能可靠完成'],
    causal_chain: [],
    facts: [],
    assumptions: [],
    unknowns: ['原决策仍未得到可靠解决'],
    risks: ['依赖该决策的分支可能无法继续'],
    reversible: true,
    reconsider_when: ['人工审查时', '后续任务重新处理该问题时'],
    confidence: 'low',
    fallback: true,
  };
}

/** decision_completed 记录构造（供 store 落盘与决策记忆） */
const { ccShapes } = require('../adapters/ports.cjs'); // 经端口契约取用（T1-117）
function buildCompletedRecord({ decisionId, result, source, createdAt }) {
  return {
    event: 'decision_completed',
    decision_id: decisionId,
    status: 'pending_review',
    fallback: result?.fallback === true,
    source,
    created_at: createdAt,
    result,
  };
}

/** 决策 id 生成器（base36 时间戳 + 自增）；reset() 供测试/run 重置 */
function createDecisionSeq() {
  let seq = 0;
  return {
    nextId() {
      seq += 1;
      return `D-${Date.now().toString(36)}-${seq.toString(36)}`;
    },
    reset() {
      seq = 0;
    },
  };
}

/**
 * Stop 闸门分支分类（纯规则）。
 * @returns {{ branch: 'complete'|'deciding'|'resolve' }}
 */
function classifyStop({ enabled, text, deciding, stopHookActive }) {
  if (!enabled) return { branch: 'complete' };
  if (deciding) return { branch: 'resolve' };
  if (endsWithDecisionRequired(text) && stopHookActive !== true) return { branch: 'deciding' };
  return { branch: 'complete' };
}

/** deny ccOutput 构造（permissionDecision）——cc 回写形状归 cc-shapes */
function denyOutput(reason) {
  return ccShapes.denyPermission(reason);
}

/**
 * AskUserQuestion PreToolUse 决策化分类（纯规则）。
 * @returns {{ kind: 'capture'|'deny_deciding'|'deny_gate', question?: object, output?: object }}
 */
function classifyAskQuestion({ enabled, deciding, questions }) {
  const question = questions?.[0] || null;
  if (!question) return { kind: 'capture', question: null };
  if (!enabled) return { kind: 'capture', question };
  if (deciding) {
    return {
      kind: 'deny_deciding',
      question,
      output: denyOutput('当前决策闭合前禁止再次发起用户提问：请按决策模式产出 <AWF_DECISION_RESULT> 收尾本回合。'),
    };
  }
  return {
    kind: 'deny_gate',
    question,
    output: denyOutput('提问工具已被拦截：禁止再向用户提问，也不要继续输出。请把需要决策的问题以 <AWF_DECISION_REQUIRED>…</AWF_DECISION_REQUIRED> 包裹放在本回合最后一行，然后结束本回合。'),
  };
}

module.exports = {
  DECISION_REQUIRED_RE,
  endsWithDecisionRequired,
  deferredFallbackResult,
  buildCompletedRecord,
  createDecisionSeq,
  classifyStop,
  classifyAskQuestion,
  denyOutput,
};
