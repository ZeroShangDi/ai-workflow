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
// 带捕获组（正文）是为了 extractDecisionRequiredText 复用同一个模式 —— 加组不改 `.test()` 语义。
const DECISION_REQUIRED_RE = /<\s*AWF_DECISION_REQUIRED\s*>([\s\S]*?)<\s*\/\s*AWF_DECISION_REQUIRED\s*>\s*$/;

/** 结束文本是否以决策必需标记结尾 */
function endsWithDecisionRequired(text) {
  return typeof text === 'string' && DECISION_REQUIRED_RE.test(text);
}

/**
 * 取出 `<AWF_DECISION_REQUIRED>…</…>` 的正文（未以该标记结尾时返回 null）。
 *
 * 用于「文本入口」把问题本身落盘：此前 decision_requested 只在 AskUserQuestion 捕获路径写，
 * 文本入口进的决策不问问题是什么 —— 复盘时只剩结论，问题原文无从追溯。
 * @returns {string|null} 去空白后的正文；空正文视作没取到
 */
function extractDecisionRequiredText(text) {
  if (typeof text !== 'string') return null;
  const matched = DECISION_REQUIRED_RE.exec(text);
  if (!matched) return null;
  return matched[1].trim() || null;
}

/**
 * 作答形态（统一的 form 取值）：多选 / 单选 / 问答。
 *
 * 单选与多选来自被拦截的提问（AskUserQuestion 的 multiSelect），问答来自文本入口 ——
 * 后者没有出题形态，AI 直接自答。与 schema 的 `type`（结论性质：resolved/deferred/…）
 * 是**两个维度**，不可混用。
 */
function formOfQuestion(question) {
  return question?.multiSelect ? 'multi' : 'single';
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

/**
 * decision_requested 记录构造 —— 决策的**问题侧**（问题 / 作答形态 / 选项）。
 *
 * 与 decision_completed（结论侧）分落两条事件，页面按 decision_id 聚合为一条：
 * append-only 多事件是既有不变量，两侧塞进同一条会破坏「历史不可改写」。
 *
 * status 两种来源：
 *   - `deciding`：文本入口 / 门阀开启时的提问捕获（AI 即将自决，没有人要答）
 *   - `awaiting_human`：闸门关时的提问捕获（旧语义，等人应答）
 */
function buildRequestedRecord({ decisionId, taskId = null, question, options = [], form, source, createdAt, status = 'deciding' }) {
  return {
    event: 'decision_requested',
    decision_id: decisionId,
    // 任务级归因（可在任务列表上把这批决策标出来）。允许为空是**语义诚实**：
    // 多 agent 下主会话在派发/收尾，它不属于任何单个任务，硬塞一个就是假数据。
    task_id: taskId,
    status,
    source,
    created_at: createdAt,
    subject: { capability: 'decision_gate' },
    request: {
      decision_id: decisionId,
      question,
      options,
      form,
    },
  };
}

/**
 * decision_reviewed 记录构造 —— 人工复审「已通过」。
 *
 * status 用 `approved` 而不是 `reviewed`：后者已被动态规划（replanning/decision-port）占用，
 * 两个域共用一个 store，取值撞车会让页面上分不清是谁的复审。
 */
function buildReviewedRecord({ decisionId, reviewer, createdAt, note = null }) {
  return {
    event: 'decision_reviewed',
    decision_id: decisionId,
    status: 'approved',
    source: 'human',
    reviewer,
    ...(note ? { note } : {}),
    created_at: createdAt,
    subject: { capability: 'decision_gate' },
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
  extractDecisionRequiredText,
  formOfQuestion,
  deferredFallbackResult,
  buildCompletedRecord,
  buildRequestedRecord,
  buildReviewedRecord,
  createDecisionSeq,
  classifyStop,
  classifyAskQuestion,
  denyOutput,
};
