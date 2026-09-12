'use strict';
/**
 * service.cjs — 动态任务规划能力服务（replanning 的核心编排）。
 *
 * ## 一条 proposal 的生命周期
 *   propose → （可选）decision_required → awaiting_approval → approve/reject → applied / rejected
 *                          ↘ decision_link_failed（决策端口写入失败，可 reject 收口）
 * 每条状态转换都：写 proposal 文件 + 追加事件 + 维护 state.dynamicPlanning.holds。
 *
 * ## 三个关键设计
 *   1. **hold（挡调度）**：proposal 一旦挂起（待审批/待决策），把它波及的 pending/blocked 任务登记
 *      进 state.dynamicPlanning.holds。调度器读 readyTaskIds 时会排除被 hold 的任务，从而「锁住」
 *      受影响面、不让 run 继续推进它们——直到命题被批准/拒绝/冲突而释放（clearHold）。
 *      hold 存在 state 里（不是内存），保证跨进程/重启仍生效。
 *   2. **CAS（乐观并发）**：批准时用 prepareApply 做「指纹 + 重放」双检（详见其注释）。核心是
 *      批准不是照抄创建时的 proposedState 快照，而是在锁内用原始 operations 对最新 state 重放，
 *      以免把 run 在等待审批期间产生的新进展回退掉。
 *   3. **人工批准**：默认 approve_then_apply 模式下，改动 state 的唯一入口是 approve / resolveDecision，
 *      均强制 reviewer，且全程在 withFileLock 临界区内完成读改写。
 *
 * ## 边界
 * 编排 + 持久化；纯图变更逻辑在 planner.cjs，落盘原语在 store.cjs / core，决策能力经 decision-port 适配。
 */
const crypto = require('node:crypto');
const path = require('node:path');
const storeCore = require('../../shared/store-core.cjs');
const { MODES, loadDynamicPlanningConfig } = require('./config.cjs');
const { DynamicPlanningStore } = require('./store.cjs');
const { planAdjustment } = require('./planner.cjs');

/** 整份 state 的 sha256（诊断/审计用；不再单独作批准判据） */
function fingerprint(state) {
  return crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

// 批准判据的口径（2026-09-11 修正）。
// 旧口径拿**整份 state** 的哈希做 CAS，而 approve_then_apply 的设计前提恰恰是「未受影响的并行任务
// 仍可继续」（capability.md §4）—— 只要 run 在动（别的任务结算、markActive、阶段与 mode 切换），
// 哈希必变，于是运行中发出的提案永远批不过（真机 case `dynamic-planning-run` 实测踩到）。
// 新口径分两步：
//   1) 只比**受影响闭包的结构指纹 + plan.acceptanceCriteria**：不相关的前进不再误伤，
//      `conflicted` 恢复为「相关前提真的变了」；
//   2) 通过后不是照抄提案创建时的快照，而是在锁内用**当初的 operations 对最新 state 重放**，
//      写出去的是重放结果。少了这一步，即使不判冲突，写回旧快照也会把 run 的新进展回退掉。
// 结构快照要剔除的「易变」字段：exec（执行起止时间戳/进度）与 commits（提交哈希）会随 run
// 正常推进而变，却与「任务结构是否被前提变化牵连」无关。若不剔除，任何一次任务结算都会误判 scope 漂移。
const VOLATILE_TASK_FIELDS = ['exec', 'commits'];

/**
 * 受影响任务在**当前 state** 中的结构快照（提案新插入的任务此刻还不存在，两侧都不计入）。
 *
 * 返回按 id 排序的数组，逐任务去掉易变字段后保留其余全部字段——这是「结构相等」的比较基准。
 * 排序保证同一集合无论遍历顺序如何都得到相同指纹。
 * @returns {Array<object>} 排序后的结构快照数组
 */
function scopeSnapshot(state, taskIds) {
  const byId = new Map((state?.tasks || []).map((task) => [task.id, task]));
  return (taskIds || [])
    .filter((id) => byId.has(id))
    .sort()
    .map((id) => {
      const structural = { ...byId.get(id) };
      for (const field of VOLATILE_TASK_FIELDS) delete structural[field];
      return structural;
    });
}

/**
 * 批准判据指纹：只覆盖「受影响闭包的结构 + plan.acceptanceCriteria」。
 *
 * 为什么不是整份 state 哈希：见文件上方 VOLATILE_TASK_FIELDS 处的说明——整份哈希会被无关的并行
 * 推进打乱，导致运行中发出的提案永远批不过。此指纹只对「相关前提」敏感：受影响任务的结构若
 * 变了（被别处改过/删过）或验收标准被改，才算冲突。
 */
function scopeFingerprint(state, taskIds) {
  return crypto.createHash('sha256').update(JSON.stringify({
    affectedTasks: scopeSnapshot(state, taskIds),
    acceptanceCriteria: state?.plan?.acceptanceCriteria ?? null,
  })).digest('hex');
}

/**
 * 应用前的双检：先比受影响闭包指纹，再基于最新 state 重放 operations。
 * @returns {{ok: true, nextState: object, analysis: object}|{ok: false, conflict: object}}
 */
function prepareApply(currentState, proposal) {
  const affected = proposal.analysis?.affectedTaskIds || [];
  const expectedScope = proposal.approvalBase?.scopeFingerprint;
  if (expectedScope) {
    // 主判据：相关前提（受影响闭包结构 + 验收标准）是否变化。
    const actualScope = scopeFingerprint(currentState, affected);
    if (actualScope !== expectedScope) {
      return {
        ok: false,
        conflict: {
          kind: 'scope_changed',
          expectedScopeFingerprint: expectedScope,
          actualScopeFingerprint: actualScope,
        },
      };
    }
  } else {
    // 旧记录（没有 scope 指纹）退回整份 state 的哈希判据
    const expected = proposal.approvalBase?.fingerprint || proposal.base.fingerprint;
    const actual = fingerprint(currentState);
    if (actual !== expected) {
      return { ok: false, conflict: { kind: 'state_changed', expectedFingerprint: expected, actualFingerprint: actual } };
    }
  }
  try {
    // 关键：不是写回 proposal.proposedState（创建时快照），而是用原始 operations 对 currentState
    // 重放——写出去的是「最新 state + 本次变更」，run 在等待审批期间的新进展得以保留。
    const { nextState, analysis } = planAdjustment(currentState, {
      reason: proposal.reason,
      operations: proposal.operations,
    });
    return { ok: true, nextState, analysis };
  } catch (error) {
    // 结构前提已经变了（目标不再 pending/blocked、下游已 active/done、图不再合法……）：
    // 与指纹漂移同属「相关前提变了」，按冲突处理，不外抛也不留半次应用。
    return { ok: false, conflict: { kind: 'replay_failed', error: error.message } };
  }
}

/** 生成 proposalId：DP-<ISO 去分隔符前 17 位>-<8 位随机>；时间前缀便于排序，随机后缀防同刻碰撞 */
function proposalId() {
  return `DP-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17)}-${crypto.randomUUID().slice(0, 8)}`;
}

/** 对外投影：剥掉 proposedState（可能很大且含完整任务快照），只暴露稳定的元数据与分析结果 */
function publicProposal(proposal) {
  if (!proposal) return null;
  const { proposedState, ...safe } = proposal;
  return safe;
}

/**
 * 构造动态规划服务。
 * @param {object} deps
 * @param {string} deps.projectRoot - 目标项目根（读写 .awf/state.json 与 .awf/dynamic-planning/）
 * @param {Function} [deps.configLoader] - 配置加载器，缺省读 .awf/config.json
 * @param {object} [deps.extensions] - 扩展钩子：afterAnalysis / beforeApply / afterApply（生命周期注入点）
 * @param {object|null} [deps.decisionPort] - 高风险 proposal 的决策端口（request/complete）
 * @returns {{ propose, approve, reject, resolveDecision, get, list }}
 */
function createDynamicPlanningService({ projectRoot, configLoader, extensions = {}, decisionPort = null }) {
  const statePath = path.join(projectRoot, '.awf', 'state.json');
  const lockPath = path.join(projectRoot, '.awf', 'state.lock');
  const records = new DynamicPlanningStore(projectRoot);
  const loadConfig = configLoader || (() => loadDynamicPlanningConfig(projectRoot));

  /** 追加一条 proposal 事件（带通用头字段，extra 覆盖/补充） */
  function recordEvent(proposal, event, extra = {}) {
    records.appendEvent({
      at: new Date().toISOString(),
      event,
      proposalId: proposal.proposalId,
      capability: 'dynamic_planning',
      executionMode: proposal.executionMode,
      status: proposal.status,
      ...extra,
    });
  }

  /** 统一的「存 proposal + 记事件」组合，返回对外投影；调用方拿到的即 publicProposal 结果 */
  function save(proposal, event, extra) {
    proposal.updatedAt = new Date().toISOString();
    records.writeProposal(proposal);
    recordEvent(proposal, event, extra);
    return publicProposal(proposal);
  }

  /**
   * 安装 hold：把 proposal 波及的 pending/blocked 任务登记进 state.dynamicPlanning.holds。
   *
   * 只 hold「未开工」的任务（active/done 不会被调度，无需 hold；改它们本身也会被 planner 拒绝）。
   * 同时把当前 state 的三样东西固化进 proposal.approvalBase：lastUpdated（诊断）、整份 fingerprint
   * （诊断/审计）、scopeFingerprint（**真正的批准判据**）。这些是批准时 CAS 的比较基准。
   * 副作用：就地写 state.json（这是挂起动作的一部分，必须落盘才能跨进程挡调度）。
   */
  function installHold(state, proposal) {
    const byId = new Map((state.tasks || []).map((task) => [task.id, task]));
    const taskIds = proposal.analysis.affectedTaskIds
      .filter((id) => ['pending', 'blocked'].includes(byId.get(id)?.status));
    state.dynamicPlanning = state.dynamicPlanning || {};
    state.dynamicPlanning.holds = state.dynamicPlanning.holds || {};
    state.dynamicPlanning.holds[proposal.proposalId] = {
      taskIds,
      reason: proposal.reason,
      createdAt: proposal.createdAt,
    };
    state.lastUpdated = new Date().toISOString();
    storeCore.writeJsonAtomicSync(statePath, state);
    proposal.hold = { taskIds };
    proposal.approvalBase = {
      lastUpdated: state.lastUpdated,
      // 保留整份指纹作诊断/审计，但**不再是批准判据**（见 prepareApply 注释）
      fingerprint: fingerprint(state),
      scopeFingerprint: scopeFingerprint(state, proposal.analysis.affectedTaskIds),
      affectedTaskIds: [...proposal.analysis.affectedTaskIds],
    };
  }

  /** 只清 hold，不落盘（应用路径要在写 nextState 前先摘掉自己那把锁） */
  function clearHold(state, id) {
    if (!state?.dynamicPlanning?.holds?.[id]) return false;
    delete state.dynamicPlanning.holds[id];
    // 反向清理空壳：holds 空了删 holds，dynamicPlanning 空了删 dynamicPlanning，
    // 避免 state 里留下无意义的空对象（也让「是否仍有挂起」的判断只看键存在与否即可）。
    if (Object.keys(state.dynamicPlanning.holds).length === 0) delete state.dynamicPlanning.holds;
    if (Object.keys(state.dynamicPlanning).length === 0) delete state.dynamicPlanning;
    return true;
  }

  /** 清 hold 并落盘（拒绝/冲突路径用；返回是否真的清掉了） */
  function releaseHold(state, proposalId) {
    if (!clearHold(state, proposalId)) return false;
    state.lastUpdated = new Date().toISOString();
    storeCore.writeJsonAtomicSync(statePath, state);
    return true;
  }

  /**
   * 发起一次动态规划提案。整体在 state 文件锁内完成「读最新 state → 分析 → 落 proposal + hold」。
   *
   * 三条去向由 analysis.requiresDecision 与执行模式共同决定：
   *   - requiresDecision（有高风险理由）→ 必须经决策端口走人工 => decision_required；
   *   - approve_then_apply → 挂起等待人工批准 => awaiting_approval；
   *   - auto_then_review → 直接应用既定 nextState，事后 Review => applied_review_pending。
   * 同一时刻只允许一个未决提案（否则改动互相冲突）——有挂起 hold 即拒绝新提案。
   * @returns {object} 对外投影的 proposal
   */
  function propose(request) {
    const config = loadConfig();
    const mode = config.mode;
    let response;
    storeCore.withFileLock(lockPath, () => {
      const currentState = storeCore.readJsonSync(statePath);
      if (!currentState) throw new Error(`state.json unreadable: ${statePath}`);
      // 已有未决提案（holds 非空）时拒绝：并发提案会争抢同一任务图，无法保证语义。
      const openProposalIds = Object.keys(currentState.dynamicPlanning?.holds || {});
      if (openProposalIds.length > 0) {
        throw new Error(`dynamic planning proposal already awaiting resolution: ${openProposalIds.join(', ')}`);
      }
      const baseFingerprint = fingerprint(currentState);
      const { nextState, analysis } = planAdjustment(currentState, request);
      const now = new Date().toISOString();
      const proposal = {
        schemaVersion: 1,
        proposalId: proposalId(),
        capability: 'dynamic_planning',
        status: 'proposed',
        executionMode: mode,
        trigger: request.trigger || 'ai_runtime',
        requestedBy: request.requestedBy || 'ai',
        reason: request.reason,
        operations: request.operations,   // 原始操作留存：批准时据此对最新 state 重放（不抄快照）
        analysis,
        base: { lastUpdated: currentState.lastUpdated ?? null, fingerprint: baseFingerprint },
        createdAt: now,
        updatedAt: now,
        extensionContext: config.extensions,
        proposedState: nextState,         // 创建时快照，仅供人工审阅；批准时不会被直接写回
      };

      if (typeof extensions.afterAnalysis === 'function') extensions.afterAnalysis({ proposal, currentState });

      // 分支一：高风险 → 必须走正式决策，人工结论是唯一执行入口。
      if (analysis.requiresDecision) {
        if (typeof decisionPort?.request !== 'function') {
          throw new Error('dynamic planning decision port is not configured');
        }
        proposal.status = 'decision_required';
        const decisionId = `D-${proposal.proposalId}`;
        proposal.decision = { decisionId, status: 'awaiting_human' };
        proposal.nextAction = {
          type: 'decision',
          capability: 'decision',
          decisionId,
          reasons: [...analysis.decisionReasons],
        };
        installHold(currentState, proposal);
        // 先把 proposal + hold 形成安全现场，再写正式 decision request。decision 端口
        // 失败时保持 hold 并显式进入 link_failed，不能静默退回直接审批。
        save(proposal, 'proposal.decision_required', { reasons: analysis.decisionReasons });
        try {
          const linked = decisionPort.request({ decisionId, proposal, currentState });
          proposal.decision = { ...proposal.decision, ...linked };
          response = save(proposal, 'proposal.decision_linked', { decisionId });
        } catch (error) {
          proposal.status = 'decision_link_failed';
          proposal.decision = { ...proposal.decision, status: 'link_failed', error: error.message };
          proposal.nextAction = { type: 'manual_recovery', capability: 'decision', decisionId };
          response = save(proposal, 'proposal.decision_link_failed', { decisionId, error: error.message });
        }
        return;
      }
      // 分支二：默认模式 → 挂起等人工批准（hold 已装，state 被锁住不受影响的部分继续跑）。
      if (mode === MODES.APPROVE_THEN_APPLY) {
        proposal.status = 'awaiting_approval';
        proposal.nextAction = { type: 'human_approval' };
        installHold(currentState, proposal);
        response = save(proposal, 'proposal.awaiting_approval');
        return;
      }

      // 分支三：auto_then_review → 直接应用 nextState，不装 hold（无需等待）。
      if (typeof extensions.beforeApply === 'function') extensions.beforeApply({ proposal, currentState });
      proposal.proposedState.lastUpdated = new Date().toISOString();
      storeCore.writeJsonAtomicSync(statePath, proposal.proposedState);
      proposal.status = 'applied_review_pending';
      proposal.nextAction = { type: 'post_review', capability: 'dynamic_planning_review' };
      proposal.review = { status: 'pending' };
      proposal.appliedAt = new Date().toISOString();
      proposal.result = {
        stateFingerprint: fingerprint(proposal.proposedState),
        readyTaskIds: proposal.analysis.readyAfter,
      };
      response = save(proposal, 'proposal.applied', { reviewRequired: true });
      if (typeof extensions.afterApply === 'function') extensions.afterApply({ proposal, state: proposal.proposedState });
    });
    return response;
  }

  /**
   * 人工批准一个 awaiting_approval 的 proposal：CAS 双检通过则重放并写回 state，否则判 conflicted。
   *
   * 全程在文件锁内：proposal 与 state 必须同临界区重读，防止 approve/reject 并发各自拿旧快照覆盖终态。
   * 冲突（conflicted）时释放 hold，让被锁住的任务恢复调度（前提已变，旧提案不再适用，交给重新提案）。
   * @param {string} id - proposalId
   * @param {{ reviewer: string, note?: string }} opts
   * @returns {object} 对外投影的 proposal
   */
  function approve(id, { reviewer, note } = {}) {
    assertReviewer(reviewer);
    let response;
    storeCore.withFileLock(lockPath, () => {
      // proposal 状态与 state 必须在同一临界区重读，防止 approve/reject 并发
      // 各自拿着旧 proposal 快照覆盖已经形成的终态。
      const proposal = records.readProposal(id);
      if (!proposal) throw new Error(`dynamic planning proposal not found: ${id}`);
      // 高风险提案不能走普通审批入口——必须先闭合它的正式决策。
      if (proposal.status === 'decision_required') {
        throw new Error(`proposal ${id} requires formal decision ${proposal.decision?.decisionId}; resolve the decision instead`);
      }
      if (proposal.status !== 'awaiting_approval') {
        throw new Error(`proposal ${id} cannot be approved while status=${proposal.status}`);
      }
      const currentState = storeCore.readJsonSync(statePath);
      const prepared = prepareApply(currentState, proposal);
      if (!prepared.ok) {
        proposal.status = 'conflicted';
        proposal.nextAction = null;
        proposal.conflict = prepared.conflict;
        releaseHold(currentState, proposal.proposalId);
        response = save(proposal, 'proposal.conflicted');
        return;
      }
      if (typeof extensions.beforeApply === 'function') extensions.beforeApply({ proposal, currentState });
      const nextState = prepared.nextState;
      clearHold(nextState, proposal.proposalId); // 重放基于含 hold 的最新 state，写回前必须摘掉自己那把锁
      nextState.lastUpdated = new Date().toISOString();
      storeCore.writeJsonAtomicSync(statePath, nextState);
      proposal.status = 'applied';
      proposal.nextAction = null;
      proposal.approvedBy = reviewer;
      proposal.approvalNote = note || null;
      proposal.appliedAt = new Date().toISOString();
      proposal.applied = {
        basis: 'replay',  // 标记：本次应用是「重放 operations」而非「抄快照」
        affectedTaskIds: prepared.analysis.affectedTaskIds,
      };
      proposal.result = {
        stateFingerprint: fingerprint(nextState),
        readyTaskIds: prepared.analysis.readyAfter,
      };
      response = save(proposal, 'proposal.approved_and_applied');
      if (typeof extensions.afterApply === 'function') extensions.afterApply({ proposal, state: nextState });
    });
    return response;
  }

  /**
   * 人工拒绝一个待决 proposal：置 rejected + 释放 hold（放行被锁任务），不改动任务图。
   * 可拒绝的状态含 decision_link_failed（决策端口写入失败时用拒绝收口）。
   */
  function reject(id, { reviewer, note } = {}) {
    assertReviewer(reviewer);
    let response;
    storeCore.withFileLock(lockPath, () => {
      const proposal = records.readProposal(id);
      if (!proposal) throw new Error(`dynamic planning proposal not found: ${id}`);
      if (proposal.status === 'decision_required') {
        throw new Error(`proposal ${id} requires formal decision ${proposal.decision?.decisionId}; resolve the decision instead`);
      }
      if (!['awaiting_approval', 'decision_link_failed'].includes(proposal.status)) {
        throw new Error(`proposal ${id} cannot be rejected while status=${proposal.status}`);
      }
      proposal.status = 'rejected';
      proposal.nextAction = null;
      proposal.rejectedBy = reviewer;
      proposal.rejectionNote = note || null;
      proposal.rejectedAt = new Date().toISOString();
      const currentState = storeCore.readJsonSync(statePath);
      releaseHold(currentState, proposal.proposalId);
      response = save(proposal, 'proposal.rejected');
    });
    return response;
  }

  /**
   * 正式 decision 的人工结论是高风险 proposal 唯一执行入口。
   *
   * 分两段（关键设计）：
   *   段一（锁内）：重读 proposal/state → 记录 decision 结论并就地应用（approve 走 prepareApply 重放，
   *     reject 走 releaseHold）→ 落盘。此段结束时 state 已是终态，proposal.decision.recordStatus='pending'。
   *   段二（锁外）：调用 decisionPort.complete 把结论写入决策存储（可能涉及别的文件/端口，不应占锁）；
   *     成功后再回锁内把 recordStatus 置 'completed'，失败则置 'completion_failed' 并抛出。
   *
   * **可重试**：若 state/proposal 已落盘但 complete 中断（recordStatus !== 'completed'），允许以同一
   * outcome 重入补记；重入时校验 outcome 一致，绝不重复应用 state，也不接受用重试偷换原结论。
   * @param {string} decisionId - 形如 D-<proposalId>
   * @param {{ outcome: 'approve'|'reject', reviewer: string, note?: string }} opts
   * @returns {{ proposal: object, decision: object }}
   */
  function resolveDecision(decisionId, { outcome, reviewer, note } = {}) {
    assertReviewer(reviewer);
    if (!['approve', 'reject'].includes(outcome)) {
      throw new Error('decision outcome must be approve or reject');
    }
    if (typeof decisionPort?.complete !== 'function') {
      throw new Error('dynamic planning decision port is not configured');
    }
    // 先用 listProposals 由 decisionId 反查 proposalId（decision_id = D-<proposalId> 的双向可推导约定）。
    const indexed = records.listProposals()
      .find((proposal) => proposal?.decision?.decisionId === decisionId);
    if (!indexed) throw new Error(`dynamic planning decision not found: ${decisionId}`);

    let response;
    let resolvedProposal;
    let completionInput;
    storeCore.withFileLock(lockPath, () => {
      const proposal = records.readProposal(indexed.proposalId);
      if (!proposal || proposal?.decision?.decisionId !== decisionId) {
        throw new Error(`dynamic planning decision not found: ${decisionId}`);
      }
      // state/proposal 已落盘但 decision_completed 记录中断时，允许同一 outcome
      // 重试补记；绝不重复应用，也不接受用重试偷换人的原结论。
      const recordPending = proposal.decision?.status === 'resolved'
        && proposal.decision?.recordStatus !== 'completed';
      if (proposal.status !== 'decision_required' && !recordPending) {
        throw new Error(`decision ${decisionId} cannot be resolved while proposal status=${proposal.status}`);
      }
      // 补记分支：跳过应用，直接用已存结论走 complete（outcome 必须是原结论）。
      if (recordPending) {
        if (proposal.decision.outcome !== outcome) {
          throw new Error(`decision ${decisionId} was already resolved as ${proposal.decision.outcome}`);
        }
        resolvedProposal = proposal;
        response = publicProposal(proposal);
        completionInput = {
          decisionId,
          proposal,
          outcome: proposal.decision.outcome,
          reviewer: proposal.decision.reviewer,
          note: proposal.decision.note,
          applicationStatus: proposal.status,
        };
        return;
      }
      proposal.decision = {
        ...proposal.decision,
        status: 'resolved',
        recordStatus: 'pending',   // 先记 pending，段二写决策存储成功后才置 completed
        outcome,
        reviewer,
        note: note || null,
        resolvedAt: new Date().toISOString(),
      };
      const currentState = storeCore.readJsonSync(statePath);
      if (outcome === 'reject') {
        proposal.status = 'rejected';
        proposal.nextAction = null;
        proposal.rejectedBy = reviewer;
        proposal.rejectionNote = note || null;
        proposal.rejectedAt = new Date().toISOString();
        releaseHold(currentState, proposal.proposalId);
        response = save(proposal, 'proposal.decision_rejected', { decisionId });
      } else {
        // approve：与普通审批同样的 CAS 双检 + 重放。冲突则 conflicted 并释放 hold。
        const prepared = prepareApply(currentState, proposal);
        if (!prepared.ok) {
          proposal.status = 'conflicted';
          proposal.nextAction = null;
          proposal.conflict = prepared.conflict;
          releaseHold(currentState, proposal.proposalId);
          response = save(proposal, 'proposal.decision_approved_but_conflicted', { decisionId });
        } else {
          if (typeof extensions.beforeApply === 'function') extensions.beforeApply({ proposal, currentState });
          const nextState = prepared.nextState;
          clearHold(nextState, proposal.proposalId);
          nextState.lastUpdated = new Date().toISOString();
          storeCore.writeJsonAtomicSync(statePath, nextState);
          proposal.status = 'applied';
          proposal.nextAction = null;
          proposal.approvedBy = reviewer;
          proposal.approvalNote = note || null;
          proposal.appliedAt = new Date().toISOString();
          proposal.applied = {
            basis: 'replay',
            affectedTaskIds: prepared.analysis.affectedTaskIds,
          };
          proposal.result = {
            stateFingerprint: fingerprint(nextState),
            readyTaskIds: prepared.analysis.readyAfter,
          };
          response = save(proposal, 'proposal.decision_approved_and_applied', { decisionId });
          if (typeof extensions.afterApply === 'function') extensions.afterApply({ proposal, state: proposal.proposedState });
        }
      }
      resolvedProposal = proposal;
      completionInput = {
        decisionId,
        proposal,
        outcome,
        reviewer,
        note,
        applicationStatus: response.status,
      };
    });

    // 段二：锁外写决策存储（可能跨文件/端口）。失败则回锁内标 completion_failed 并抛出，
    // 保留 recordStatus=pending 以便后续用同一 outcome 重试补记。
    let decision;
    try {
      decision = decisionPort.complete(completionInput);
    } catch (error) {
      storeCore.withFileLock(lockPath, () => {
        const proposal = records.readProposal(resolvedProposal.proposalId);
        if (proposal?.decision?.decisionId === decisionId) {
          proposal.decision.recordStatus = 'completion_failed';
          proposal.decision.recordError = error.message;
          save(proposal, 'proposal.decision_completion_failed', { decisionId, error: error.message });
        }
      });
      throw new Error(`proposal ${resolvedProposal.proposalId} is ${response.status}, but decision completion recording failed: ${error.message}`);
    }

    // 补记成功：回锁内把 recordStatus 置 completed，并回填决策存储解析出的 runStamp。
    storeCore.withFileLock(lockPath, () => {
      const proposal = records.readProposal(resolvedProposal.proposalId);
      if (proposal?.decision?.decisionId === decisionId) {
        proposal.decision.recordStatus = 'completed';
        proposal.decision.recordError = null;
        proposal.decision.runStamp = decision.runStamp || proposal.decision.runStamp || null;
        response = save(proposal, 'proposal.decision_completed', { decisionId });
      }
    });
    return { proposal: response, decision };
  }

  /** 读单个 proposal 的对外投影 */
  function get(id) {
    return publicProposal(records.readProposal(id));
  }

  /** 列出全部 proposal 的对外投影（最新在前） */
  function list() {
    return records.listProposals().map(publicProposal);
  }

  return { propose, approve, reject, resolveDecision, get, list };
}

/** reviewer 必填校验：人工批准/拒绝/决议都必须署名（非空字符串），保证审计可追责 */
function assertReviewer(reviewer) {
  if (typeof reviewer !== 'string' || reviewer.trim() === '') {
    throw new Error('reviewer must be a non-empty string');
  }
}

module.exports = { fingerprint, publicProposal, createDynamicPlanningService };
