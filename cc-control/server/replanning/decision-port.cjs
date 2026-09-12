'use strict';

/**
 * 动态规划 → decision 的适配端口。
 *
 * dynamic-planning 只依赖 request/complete 语义，不依赖 Stop hook、tmux 或
 * decisionGate 的会话状态机；适配器把正式生命周期写入既有 DecisionStore，
 * 供 Review/API 与未来其他 decision workflow 共同消费。
 *
 * ## 为什么需要这层
 * 高风险动态规划（analysis.requiresDecision）要借用「人工决策」这一外部机制做审批，但决策
 * 能力本身是用 Stop hook + tmux 会话态实现的。若让 replanning 直接依赖那套会话状态机，二者会
 * 强耦合。适配器把差异收敛成 request（发起待审）与 complete（回填结论）两个纯语义方法，
 * replanning 侧对决策的实现细节零感知。
 *
 * ## decision_id 约定
 * 一个 proposal 对应一个决策，id 由 proposalId 派生（`D-<proposalId>`），双向可推导，
 * 从而无需额外索引即可由任一侧找到另一侧。
 */

/** proposalId → 决策 id（D- 前缀）；空串/非字符串直接抛错（id 会拼进落盘记录，不能是脏值） */
function decisionIdForProposal(proposalId) {
  if (typeof proposalId !== 'string' || proposalId.length === 0) {
    throw new Error('proposalId must be a non-empty string');
  }
  return `D-${proposalId}`;
}

/**
 * 构造决策端口。
 * @param {{ storeFactory: () => object }} deps - storeFactory 返回 DecisionStore 实例
 *   （每次调用取新实例，避免跨请求共用带内部状态的 store）
 * @returns {{ request: Function, complete: Function }}
 */
function createDynamicPlanningDecisionPort({ storeFactory }) {
  if (typeof storeFactory !== 'function') throw new Error('decision port requires storeFactory');

  /** 发起待审决策：写 decision_requested 事件，状态 awaiting_human */
  function request({ decisionId, proposal, currentState }) {
    const id = decisionId || decisionIdForProposal(proposal?.proposalId);
    const reasons = proposal?.analysis?.decisionReasons || [];
    const record = {
      event: 'decision_requested',
      decision_id: id,
      status: 'awaiting_human',
      source: 'dynamic_planning',
      created_at: new Date().toISOString(),
      subject: {
        capability: 'dynamic_planning',
        proposal_id: proposal.proposalId,
      },
      // request 段是把决策所需上下文一次带全：问题、目标、选项、约束、操作、受影响任务。
      // 决策内核据此产出结果，无需回读 proposal。
      request: {
        decision_id: id,
        question: `是否批准动态任务规划提案 ${proposal.proposalId}？`,
        task_goal: currentState?.plan?.summary || '保持既定任务规划目标与验收标准',
        context: proposal.reason,
        options: ['approve', 'reject'],
        constraints: currentState?.plan?.acceptanceCriteria || [],
        related_decisions: [],
        decision_reasons: reasons,
        operations: proposal.operations,
        affected_task_ids: proposal?.analysis?.affectedTaskIds || [],
      },
    };
    const decisionStore = storeFactory();
    const persisted = decisionStore.appendEvent(record);
    // appendEvent 幂等去重：若返回未追加，需确认是「已存在同事件」而非真失败；只有确认不存在才抛。
    if (!persisted.appended) {
      const existing = decisionStore.eventsFor(id);
      const hasRequest = existing?.entries?.some((entry) => entry.event === 'decision_requested');
      if (!hasRequest) throw new Error(`decision request could not be persisted: ${id}`);
    }
    return { decisionId: id, status: 'awaiting_human', ...persisted };
  }

  /**
   * 回填人工决策结论：写 decision_completed 事件，状态 reviewed。
   *
   * answer/type/finality 按「批准是否真正落地」分支：
   *   - 批准且已应用 → resolved / final；
   *   - 批准但 state 已变未应用（conflicted）→ validation_required / provisional（需重新提案）；
   *   - 拒绝 → no_action / final。
   * 这样 Review 侧只看 result 就能区分「执行了」「没执行但需跟进」「明确否决」三态。
   */
  function complete({ decisionId, proposal, outcome, reviewer, note, applicationStatus }) {
    const applied = outcome === 'approve' && applicationStatus === 'applied';
    const conflicted = outcome === 'approve' && applicationStatus === 'conflicted';
    const answer = applied
      ? `批准并应用动态任务规划提案 ${proposal.proposalId}`
      : conflicted
        ? `批准提案 ${proposal.proposalId}，但 state 已变化，未应用；需要重新提案`
        : `拒绝动态任务规划提案 ${proposal.proposalId}，保持现有任务计划`;
    const result = {
      decision_id: decisionId,
      answer,
      type: applied ? 'resolved' : (conflicted ? 'validation_required' : 'no_action'),
      finality: conflicted ? 'provisional' : 'final',
      impact: 'high',
      real_question: `是否允许提案 ${proposal.proposalId} 改变既定任务计划中的高风险字段或任务结构？`,
      decisive_factors: [...new Set([
        ...(proposal?.analysis?.decisionReasons || []),
        ...(note ? [`人工说明：${note}`] : []),
      ])].slice(0, 5),
      causal_chain: [
        '动态规划分析识别高风险变更',
        'execution hold 阻止受影响任务继续执行',
        `人工选择 ${outcome}`,
        `proposal 结果为 ${applicationStatus}`,
      ],
      facts: [
        `proposal=${proposal.proposalId}`,
        `affected=${(proposal?.analysis?.affectedTaskIds || []).join(',')}`,
      ],
      assumptions: [],
      unknowns: conflicted ? ['state 在审批前发生变化，旧 proposal 不再可安全应用'] : [],
      risks: proposal?.analysis?.decisionReasons || [],
      reversible: outcome === 'reject',
      reconsider_when: conflicted
        ? ['基于最新 state 重新生成动态规划 proposal']
        : ['任务目标、验收标准或关键约束再次变化时'],
      confidence: 'high',
      fallback: false,
      outcome,
      application_status: applicationStatus,
    };
    const record = {
      event: 'decision_completed',
      decision_id: decisionId,
      status: 'reviewed',
      source: 'human',
      created_at: new Date().toISOString(),
      reviewed_by: reviewer,
      subject: {
        capability: 'dynamic_planning',
        proposal_id: proposal.proposalId,
      },
      result,
    };
    const decisionStore = storeFactory();
    // 结论必须写回 proposal 当初发起决策时的那个 run 文件（runStamp 取自 proposal.decision），
    // 否则跨 run 时完成事件会落到别的 run，与 requested 事件分家、生命周期断链。
    const persisted = decisionStore.appendEvent(record, { runStamp: proposal?.decision?.runStamp || null });
    if (!persisted.appended) {
      const existing = decisionStore.eventsFor(decisionId);
      const hasCompletion = existing?.entries?.some((entry) => entry.event === 'decision_completed');
      if (!hasCompletion) throw new Error(`decision completion could not be persisted: ${decisionId}`);
    }
    return { decisionId, result, ...persisted };
  }

  return { request, complete };
}

module.exports = { decisionIdForProposal, createDynamicPlanningDecisionPort };
