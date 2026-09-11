'use strict';

/** 动态任务规划能力服务：proposal、执行策略、CAS 原子应用和审计记录。 */
const crypto = require('node:crypto');
const path = require('node:path');
const storeCore = require('../../lib/store-core.cjs');
const { MODES, loadDynamicPlanningConfig } = require('./config.cjs');
const { DynamicPlanningStore } = require('./store.cjs');
const { planAdjustment } = require('./planner.cjs');

function fingerprint(state) {
  return crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

function proposalId() {
  return `DP-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17)}-${crypto.randomUUID().slice(0, 8)}`;
}

function publicProposal(proposal) {
  if (!proposal) return null;
  const { proposedState, ...safe } = proposal;
  return safe;
}

function createDynamicPlanningService({ projectRoot, configLoader, extensions = {}, decisionPort = null }) {
  const statePath = path.join(projectRoot, '.awf', 'state.json');
  const lockPath = path.join(projectRoot, '.awf', 'state.lock');
  const records = new DynamicPlanningStore(projectRoot);
  const loadConfig = configLoader || (() => loadDynamicPlanningConfig(projectRoot));

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

  function save(proposal, event, extra) {
    proposal.updatedAt = new Date().toISOString();
    records.writeProposal(proposal);
    recordEvent(proposal, event, extra);
    return publicProposal(proposal);
  }

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
      fingerprint: fingerprint(state),
    };
  }

  function releaseHold(state, proposalId) {
    if (!state?.dynamicPlanning?.holds?.[proposalId]) return false;
    delete state.dynamicPlanning.holds[proposalId];
    if (Object.keys(state.dynamicPlanning.holds).length === 0) delete state.dynamicPlanning.holds;
    if (Object.keys(state.dynamicPlanning).length === 0) delete state.dynamicPlanning;
    state.lastUpdated = new Date().toISOString();
    storeCore.writeJsonAtomicSync(statePath, state);
    return true;
  }

  function propose(request) {
    const config = loadConfig();
    const mode = config.mode;
    let response;
    storeCore.withFileLock(lockPath, () => {
      const currentState = storeCore.readJsonSync(statePath);
      if (!currentState) throw new Error(`state.json unreadable: ${statePath}`);
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
        operations: request.operations,
        analysis,
        base: { lastUpdated: currentState.lastUpdated ?? null, fingerprint: baseFingerprint },
        createdAt: now,
        updatedAt: now,
        extensionContext: config.extensions,
        proposedState: nextState,
      };

      if (typeof extensions.afterAnalysis === 'function') extensions.afterAnalysis({ proposal, currentState });

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
      if (mode === MODES.APPROVE_THEN_APPLY) {
        proposal.status = 'awaiting_approval';
        proposal.nextAction = { type: 'human_approval' };
        installHold(currentState, proposal);
        response = save(proposal, 'proposal.awaiting_approval');
        return;
      }

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

  function approve(id, { reviewer, note } = {}) {
    assertReviewer(reviewer);
    let response;
    storeCore.withFileLock(lockPath, () => {
      // proposal 状态与 state 必须在同一临界区重读，防止 approve/reject 并发
      // 各自拿着旧 proposal 快照覆盖已经形成的终态。
      const proposal = records.readProposal(id);
      if (!proposal) throw new Error(`dynamic planning proposal not found: ${id}`);
      if (proposal.status === 'decision_required') {
        throw new Error(`proposal ${id} requires formal decision ${proposal.decision?.decisionId}; resolve the decision instead`);
      }
      if (proposal.status !== 'awaiting_approval') {
        throw new Error(`proposal ${id} cannot be approved while status=${proposal.status}`);
      }
      const currentState = storeCore.readJsonSync(statePath);
      const actual = fingerprint(currentState);
      const expected = proposal.approvalBase?.fingerprint || proposal.base.fingerprint;
      if (actual !== expected) {
        proposal.status = 'conflicted';
        proposal.nextAction = null;
        proposal.conflict = { expectedFingerprint: expected, actualFingerprint: actual };
        releaseHold(currentState, proposal.proposalId);
        response = save(proposal, 'proposal.conflicted');
        return;
      }
      if (typeof extensions.beforeApply === 'function') extensions.beforeApply({ proposal, currentState });
      proposal.proposedState.lastUpdated = new Date().toISOString();
      storeCore.writeJsonAtomicSync(statePath, proposal.proposedState);
      proposal.status = 'applied';
      proposal.nextAction = null;
      proposal.approvedBy = reviewer;
      proposal.approvalNote = note || null;
      proposal.appliedAt = new Date().toISOString();
      proposal.result = {
        stateFingerprint: fingerprint(proposal.proposedState),
        readyTaskIds: proposal.analysis.readyAfter,
      };
      response = save(proposal, 'proposal.approved_and_applied');
      if (typeof extensions.afterApply === 'function') extensions.afterApply({ proposal, state: proposal.proposedState });
    });
    return response;
  }

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

  /** 正式 decision 的人工结论是高风险 proposal 唯一执行入口。 */
  function resolveDecision(decisionId, { outcome, reviewer, note } = {}) {
    assertReviewer(reviewer);
    if (!['approve', 'reject'].includes(outcome)) {
      throw new Error('decision outcome must be approve or reject');
    }
    if (typeof decisionPort?.complete !== 'function') {
      throw new Error('dynamic planning decision port is not configured');
    }
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
        recordStatus: 'pending',
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
        const actual = fingerprint(currentState);
        const expected = proposal.approvalBase?.fingerprint || proposal.base.fingerprint;
        if (actual !== expected) {
          proposal.status = 'conflicted';
          proposal.nextAction = null;
          proposal.conflict = { expectedFingerprint: expected, actualFingerprint: actual };
          releaseHold(currentState, proposal.proposalId);
          response = save(proposal, 'proposal.decision_approved_but_conflicted', { decisionId });
        } else {
          if (typeof extensions.beforeApply === 'function') extensions.beforeApply({ proposal, currentState });
          proposal.proposedState.lastUpdated = new Date().toISOString();
          storeCore.writeJsonAtomicSync(statePath, proposal.proposedState);
          proposal.status = 'applied';
          proposal.nextAction = null;
          proposal.approvedBy = reviewer;
          proposal.approvalNote = note || null;
          proposal.appliedAt = new Date().toISOString();
          proposal.result = {
            stateFingerprint: fingerprint(proposal.proposedState),
            readyTaskIds: proposal.analysis.readyAfter,
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

  function get(id) {
    return publicProposal(records.readProposal(id));
  }

  function list() {
    return records.listProposals().map(publicProposal);
  }

  return { propose, approve, reject, resolveDecision, get, list };
}

function assertReviewer(reviewer) {
  if (typeof reviewer !== 'string' || reviewer.trim() === '') {
    throw new Error('reviewer must be a non-empty string');
  }
}

module.exports = { fingerprint, publicProposal, createDynamicPlanningService };
