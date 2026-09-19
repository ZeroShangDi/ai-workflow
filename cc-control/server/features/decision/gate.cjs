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

// 决策必需标签 <AWF_DECISION_REQUIRED>…</…>，且**必须位于文本末尾**（`\s*$`）。
// 锚定结尾是与 core.cjs 的 RESULT_RE 的关键区别，也是本闸门的判据：只有「把问题放在本回合
// 最后一段」才算发出决策请求（见 CLAUDE.md 的 awf-run 约定）；正文里顺带提到该标签不算，
// 从而避免模型在解释协议时误触发闸门。
const DECISION_REQUIRED_RE = /<\s*AWF_DECISION_REQUIRED\s*>[\s\S]*?<\s*\/\s*AWF_DECISION_REQUIRED\s*>\s*$/;

/** 结束文本是否以决策必需标记结尾 */
function endsWithDecisionRequired(text) {
  return DECISION_REQUIRED_RE.test(text);
}

/**
 * 无有效结果兜底：构造 deferred fallback（不悬空），与正式结果同样落盘进 Review。
 *
 * 为什么需要它：Stop 闸门一旦进入 deciding 就拦住了回合，若模型没能产出合法 Decision Result，
 * 直接放行会让「决策已发起」这件事凭空消失（既无记录也无续跑位）。因此用一个**显式声明自己
 * 不可靠**的结果（type=deferred / confidence=low / fallback=true）走完整落盘链路，让 Review
 * 阶段必然看到这条待人工处理的历史。fallback=true 也是 handler 判日志文案与记录标记的依据。
 */
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
// status 固定 pending_review：决策一旦落盘即进入待人工复查态，本模块只负责「记录 + 置续跑位」，
// 是否认可由 Review 侧消费，不在闸门内做终审。
const { shapes } = require('../../adapters/ports.cjs'); // 经端口契约取用（T1-117；T-P1-01 去 CLI 化改名）
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
// 时间戳保证跨会话/跨进程不撞；自增序号兜住「同一毫秒内连续产出多个决策」的碰撞。
// 序号状态由会话持有（handler 从 session.decisionSeqGen 取），故同一会话内单调递增。
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
 *
 * 三分支优先级（决定本回合如何收尾）：
 *   1) gate 关 → complete（不干预）；
 *   2) 已在 deciding 中 → resolve（本回合是决策的产出回合，去解析并落盘）；
 *   3) 未在 deciding，且文本以决策标签结尾 → deciding（首次进入，拦截并注入指令）。
 *
 * `stopHookActive !== true` 是防死循环的必要条件：Stop hook 拦截后会再次触发 Stop，
 * 此时 Claude Code 会带上 stop_hook_active=true 标记，必须放行为 complete，否则闸门会
 * 反复自我触发、永不收口。
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
  return shapes.denyPermission(reason);
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
