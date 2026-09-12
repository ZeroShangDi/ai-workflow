import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import dynamicPlanning from '../../src/server/dynamic-planning/index.cjs';
import { DecisionStore } from '../../src/server/decision-store.cjs';

const {
  MODES,
  dynamicPlanningConfigFrom,
  planAdjustment,
  createDynamicPlanningService,
  createDynamicPlanningDecisionPort,
} = dynamicPlanning;

function baseState() {
  return {
    mode: 'run',
    version: '0.2.0',
    lastUpdated: '2026-09-11T00:00:00.000Z',
    plan: { acceptanceCriteria: ['保持模块化架构', '前端必须构建'] },
    tasks: [
      { id: 'A', title: '基础', status: 'done', deps: [], acceptance: 'A 完成' },
      { id: 'B', title: '模块实现', status: 'pending', deps: ['A'], wbsRef: 'W1', acceptance: '模块完成' },
      { id: 'G', title: '模块门禁', kind: 'review', status: 'pending', deps: ['B'], acceptance: '模块验收' },
    ],
    milestones: [{ id: 'M1', status: 'active', tasks: ['A', 'B', 'G'] }],
  };
}

function insertRequest() {
  return {
    reason: '模块实现缺少对接层，补齐原始模块化目标',
    operations: [{
      type: 'insert_task',
      relation: { type: 'prerequisite_for', targetTaskId: 'B' },
      task: {
        id: 'I', title: '模块对接', prompt: '实现模块之间的装配，不得回退单文件',
        acceptance: '模块通过对接层协作且原模块保持独立', plannedFiles: ['src/integration.js'],
      },
    }],
  };
}

describe('dynamic planning config', () => {
  it('默认人工批准；保留未来扩展配置但不解释', () => {
    expect(dynamicPlanningConfigFrom({}).mode).toBe(MODES.APPROVE_THEN_APPLY);
    expect(dynamicPlanningConfigFrom({
      run: { dynamicPlanning: { mode: 'auto_then_review', extensions: { reviewer: 'future-ui' } } },
    })).toEqual({ mode: MODES.AUTO_THEN_REVIEW, extensions: { reviewer: 'future-ui' } });
  });
});

describe('planAdjustment', () => {
  it('插入任务时自动确定位置、继承 WBS/依赖并处理 milestone 与 ready 副作用', () => {
    const current = baseState();
    const { nextState, analysis } = planAdjustment(current, insertRequest());

    expect(current.tasks.map((task) => task.id)).toEqual(['A', 'B', 'G']);
    expect(nextState.tasks.map((task) => task.id)).toEqual(['A', 'I', 'B', 'G']);
    expect(nextState.tasks.find((task) => task.id === 'I')).toMatchObject({ wbsRef: 'W1', deps: ['A'] });
    expect(nextState.tasks.find((task) => task.id === 'B').deps).toEqual(['A', 'I']);
    expect(nextState.milestones[0].tasks).toEqual(['A', 'I', 'B', 'G']);
    expect(analysis.readyBefore).toEqual(['B']);
    expect(analysis.readyAfter).toEqual(['I']);
    expect(analysis.requiresDecision).toBe(false);
    expect(analysis.affectedTaskIds).toEqual(expect.arrayContaining(['I', 'B', 'G']));
  });

  it('删除任务自动重连依赖与 milestone，但标记为需要决策', () => {
    const { nextState, analysis } = planAdjustment(baseState(), {
      reason: '删除错误拆出的临时任务',
      operations: [{ type: 'delete_task', taskId: 'B' }],
    });
    expect(nextState.tasks.map((task) => task.id)).toEqual(['A', 'G']);
    expect(nextState.tasks.find((task) => task.id === 'G').deps).toEqual(['A']);
    expect(nextState.milestones[0].tasks).toEqual(['A', 'G']);
    expect(analysis.requiresDecision).toBe(true);
    expect(analysis.decisionReasons[0]).toContain('delete planned task B');
  });

  it('不能通过局部调整重写 active/done 历史', () => {
    expect(() => planAdjustment(baseState(), {
      reason: '错误修改历史',
      operations: [{ type: 'edit_task', taskId: 'A', patch: { title: '改写' } }],
    })).toThrow(/status=done/);
  });

  it('不能通过编辑或删除上游 pending 任务使已 active/done 的传递下游历史失效', () => {
    const inconsistent = baseState();
    inconsistent.tasks.push({ id: 'D', title: '已执行下游', status: 'active', deps: ['G'], acceptance: '执行中' });
    expect(() => planAdjustment(inconsistent, {
      reason: '尝试改变已有执行历史的上游',
      operations: [{ type: 'edit_task', taskId: 'B', patch: { title: '改名' } }],
    })).toThrow(/active\/done downstream tasks.*D/);
    expect(() => planAdjustment(inconsistent, {
      reason: '尝试删除已有执行历史的上游',
      operations: [{ type: 'delete_task', taskId: 'B' }],
    })).toThrow(/active\/done dependents.*D/);
  });

  it('新增依赖属于可自动处理副作用，删依赖或改执行目标必须进入决策路径', () => {
    const inserted = planAdjustment(baseState(), insertRequest()).nextState;
    const safe = planAdjustment(inserted, {
      reason: '补充已有前置关系',
      operations: [{ type: 'edit_task', taskId: 'G', patch: { deps: ['B', 'I'] } }],
    });
    expect(safe.analysis.requiresDecision).toBe(false);

    const risky = planAdjustment(inserted, {
      reason: '尝试改写任务目标并移除依赖',
      operations: [{ type: 'edit_task', taskId: 'B', patch: { deps: ['A'], prompt: '退回单文件实现' } }],
    });
    expect(risky.analysis.requiresDecision).toBe(true);
    expect(risky.analysis.decisionReasons.join(' ')).toContain('removes dependencies: I');
    expect(risky.analysis.decisionReasons.join(' ')).toContain('goal-bearing field: prompt');
  });
});

describe('dynamic planning service', () => {
  let root;
  let statePath;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-dynamic-plan-'));
    fs.mkdirSync(path.join(root, '.awf'), { recursive: true });
    statePath = path.join(root, '.awf', 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(baseState(), null, 2));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function decisionPort() {
    return createDynamicPlanningDecisionPort({ storeFactory: () => new DecisionStore(root) });
  }

  it('auto_then_review 自动应用安全调整并留下可复审 proposal/event', () => {
    const calls = [];
    const service = createDynamicPlanningService({
      projectRoot: root,
      configLoader: () => ({ mode: MODES.AUTO_THEN_REVIEW, extensions: { reviewAdapter: 'future' } }),
      extensions: { afterApply: ({ proposal }) => calls.push(proposal.proposalId) },
    });
    const proposal = service.propose(insertRequest());

    expect(proposal.status).toBe('applied_review_pending');
    expect(proposal.proposedState).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).tasks.map((task) => task.id)).toEqual(['A', 'I', 'B', 'G']);
    expect(service.get(proposal.proposalId).extensionContext).toEqual({ reviewAdapter: 'future' });
    expect(calls).toEqual([proposal.proposalId]);
    const events = fs.readFileSync(path.join(root, '.awf', 'dynamic-planning', 'events.jsonl'), 'utf8');
    expect(events).toContain('proposal.applied');
  });

  it('approve_then_apply 只保存 proposal，人工批准后才原子应用', () => {
    const service = createDynamicPlanningService({
      projectRoot: root,
      configLoader: () => ({ mode: MODES.APPROVE_THEN_APPLY, extensions: {} }),
    });
    const proposal = service.propose(insertRequest());
    expect(proposal.status).toBe('awaiting_approval');
    const heldState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(heldState.tasks.map((task) => task.id)).toEqual(['A', 'B', 'G']);
    expect(heldState.dynamicPlanning.holds[proposal.proposalId].taskIds).toEqual(['B', 'G']);

    const applied = service.approve(proposal.proposalId, { reviewer: 'human', note: '同意补对接任务' });
    expect(applied.status).toBe('applied');
    expect(applied.approvedBy).toBe('human');
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).tasks.map((task) => task.id)).toEqual(['A', 'I', 'B', 'G']);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).dynamicPlanning).toBeUndefined();
  });

  it('拒绝 proposal 会释放受影响任务 hold', () => {
    const service = createDynamicPlanningService({
      projectRoot: root,
      configLoader: () => ({ mode: MODES.APPROVE_THEN_APPLY, extensions: {} }),
    });
    const proposal = service.propose(insertRequest());
    const rejected = service.reject(proposal.proposalId, { reviewer: 'human', note: '不需要该任务' });
    expect(rejected.status).toBe('rejected');
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).dynamicPlanning).toBeUndefined();
  });

  it('第一版只允许一个开放 proposal，避免多个 hold 互相制造伪冲突', () => {
    const service = createDynamicPlanningService({
      projectRoot: root,
      configLoader: () => ({ mode: MODES.APPROVE_THEN_APPLY, extensions: {} }),
    });
    const first = service.propose(insertRequest());
    expect(() => service.propose({
      reason: '并发补另一个任务',
      operations: [{
        type: 'insert_task',
        relation: { type: 'prerequisite_for', targetTaskId: 'G' },
        task: { id: 'I2', title: '另一个对接', prompt: '实现另一个对接', acceptance: '对接完成' },
      }],
    })).toThrow(new RegExp(first.proposalId));
    expect(service.list()).toHaveLength(1);
  });

  it('proposal 形成终态后，重复批准或拒绝不能覆盖终态', () => {
    const service = createDynamicPlanningService({
      projectRoot: root,
      configLoader: () => ({ mode: MODES.APPROVE_THEN_APPLY, extensions: {} }),
    });
    const proposal = service.propose(insertRequest());
    expect(service.approve(proposal.proposalId, { reviewer: 'human' }).status).toBe('applied');
    expect(() => service.reject(proposal.proposalId, { reviewer: 'other' })).toThrow(/status=applied/);
    expect(service.get(proposal.proposalId).status).toBe('applied');
  });

  it('等待人工批准期间**无关任务**继续推进不阻塞批准，且重放不回退这些新状态', () => {
    const service = createDynamicPlanningService({
      projectRoot: root,
      configLoader: () => ({ mode: MODES.APPROVE_THEN_APPLY, extensions: {} }),
    });
    const proposal = service.propose(insertRequest());

    // 模拟 run 在等人批准期间继续前进：A 不在此次调整的受影响闭包内（闭包 = I/B/G），它被结算了；
    // 顶层也多了一个别处写入的字段。旧实现拿整份 state 的哈希做判据，这种前进必然把提案打成 conflicted
    // —— 而 approve_then_apply 的设计前提恰恰是「未受影响的并行任务仍可继续」。
    const progressed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    progressed.marker = 'newer';
    progressed.tasks.find((task) => task.id === 'A').exec = { result: 'A 已由 run 结算', files: ['src/a.js'] };
    fs.writeFileSync(statePath, JSON.stringify(progressed, null, 2));

    const applied = service.approve(proposal.proposalId, { reviewer: 'human', note: '同意补对接任务' });
    expect(applied.status).toBe('applied');

    const after = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(after.tasks.map((task) => task.id)).toEqual(['A', 'I', 'B', 'G']);
    // 应用的是**基于最新 state 重放**的结果，不是提案创建时的旧快照
    expect(after.marker).toBe('newer');
    expect(after.tasks.find((task) => task.id === 'A').exec.result).toBe('A 已由 run 结算');
    expect(after.dynamicPlanning).toBeUndefined();
  });

  it('受影响闭包本身被改动（目标被别处结算）才判 conflicted，且不留半次应用', () => {
    const service = createDynamicPlanningService({
      projectRoot: root,
      configLoader: () => ({ mode: MODES.APPROVE_THEN_APPLY, extensions: {} }),
    });
    const proposal = service.propose(insertRequest());

    // B 在受影响闭包内：它被别处改动（这里模拟被外部结算为 blocked），提案的前提已经变了
    const drifted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    drifted.tasks.find((task) => task.id === 'B').status = 'blocked';
    fs.writeFileSync(statePath, JSON.stringify(drifted, null, 2));

    const result = service.approve(proposal.proposalId, { reviewer: 'human' });
    expect(result.status).toBe('conflicted');
    expect(result.conflict.actualScopeFingerprint).not.toBe(result.conflict.expectedScopeFingerprint);
    const after = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(after.tasks.map((task) => task.id)).toEqual(['A', 'B', 'G']);
    expect(after.tasks.find((task) => task.id === 'B').status).toBe('blocked');
    expect(after.dynamicPlanning).toBeUndefined();
  });

  it('高层目标字段（plan.acceptanceCriteria）被改动同样拦住批准', () => {
    const service = createDynamicPlanningService({
      projectRoot: root,
      configLoader: () => ({ mode: MODES.APPROVE_THEN_APPLY, extensions: {} }),
    });
    const proposal = service.propose(insertRequest());
    const drifted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    drifted.plan.acceptanceCriteria = ['降级为单文件实现'];
    fs.writeFileSync(statePath, JSON.stringify(drifted, null, 2));

    expect(service.approve(proposal.proposalId, { reviewer: 'human' }).status).toBe('conflicted');
  });

  it('高风险调整建立正式 decision，不能绕过 decision 直接批准', () => {
    const service = createDynamicPlanningService({
      projectRoot: root,
      configLoader: () => ({ mode: MODES.AUTO_THEN_REVIEW, extensions: {} }),
      decisionPort: decisionPort(),
    });
    const proposal = service.propose({
      reason: '尝试删除模块实现',
      operations: [{ type: 'delete_task', taskId: 'B' }],
    });
    expect(proposal.status).toBe('decision_required');
    expect(proposal.nextAction).toMatchObject({ type: 'decision', decisionId: expect.stringMatching(/^D-DP-/) });
    expect(() => service.approve(proposal.proposalId, { reviewer: 'human' })).toThrow(/resolve the decision/);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).tasks.some((task) => task.id === 'B')).toBe(true);

    const lifecycle = new DecisionStore(root).eventsFor(proposal.decision.decisionId);
    expect(lifecycle.entries).toHaveLength(1);
    expect(lifecycle.entries[0]).toMatchObject({
      event: 'decision_requested',
      status: 'awaiting_human',
      source: 'dynamic_planning',
      subject: { proposal_id: proposal.proposalId },
    });

    const resolved = service.resolveDecision(proposal.decision.decisionId, {
      outcome: 'approve', reviewer: 'human-owner', note: '确认删除是目标的一部分',
    });
    expect(resolved.proposal.status).toBe('applied');
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).tasks.some((task) => task.id === 'B')).toBe(false);
    const completed = new DecisionStore(root).eventsFor(proposal.decision.decisionId).entries;
    expect(completed.map((entry) => entry.event)).toEqual(['decision_requested', 'decision_completed']);
    expect(completed[1]).toMatchObject({
      status: 'reviewed', source: 'human', reviewed_by: 'human-owner',
      result: { outcome: 'approve', application_status: 'applied' },
    });
  });

  it('人工 decision 拒绝高风险调整时释放 hold 并保持原计划', () => {
    const service = createDynamicPlanningService({
      projectRoot: root,
      configLoader: () => ({ mode: MODES.AUTO_THEN_REVIEW, extensions: {} }),
      decisionPort: decisionPort(),
    });
    const proposal = service.propose({
      reason: '尝试删除模块实现',
      operations: [{ type: 'delete_task', taskId: 'B' }],
    });
    const resolved = service.resolveDecision(proposal.decision.decisionId, {
      outcome: 'reject', reviewer: 'human-owner', note: '不得降低模块化目标',
    });
    expect(resolved.proposal.status).toBe('rejected');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(state.tasks.some((task) => task.id === 'B')).toBe(true);
    expect(state.dynamicPlanning).toBeUndefined();
    expect(resolved.decision.result).toMatchObject({ type: 'no_action', outcome: 'reject' });
  });

  it('proposal 已应用但 decision 完成记录中断时，同 outcome 重试只补记、不重复应用', () => {
    let failCompletion = true;
    let completionCalls = 0;
    const port = {
      request: ({ decisionId }) => ({ decisionId, status: 'awaiting_human', runStamp: 'r-test' }),
      complete: () => {
        completionCalls += 1;
        if (failCompletion) throw new Error('decision store unavailable');
        return { decisionId: 'D-repaired', runStamp: 'r-test', result: { outcome: 'approve' } };
      },
    };
    const service = createDynamicPlanningService({
      projectRoot: root,
      configLoader: () => ({ mode: MODES.AUTO_THEN_REVIEW, extensions: {} }),
      decisionPort: port,
    });
    const proposal = service.propose({
      reason: '删除任务需人工决定',
      operations: [{ type: 'delete_task', taskId: 'B' }],
    });
    expect(() => service.resolveDecision(proposal.decision.decisionId, {
      outcome: 'approve', reviewer: 'first-human', note: '批准',
    })).toThrow(/proposal .* is applied.*recording failed/);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).tasks.some((task) => task.id === 'B')).toBe(false);
    expect(service.get(proposal.proposalId).decision.recordStatus).toBe('completion_failed');

    failCompletion = false;
    const repaired = service.resolveDecision(proposal.decision.decisionId, {
      outcome: 'approve', reviewer: 'retrying-human', note: '重试只补记',
    });
    expect(repaired.proposal.status).toBe('applied');
    expect(repaired.proposal.decision).toMatchObject({
      recordStatus: 'completed', reviewer: 'first-human', outcome: 'approve',
    });
    expect(completionCalls).toBe(2);
    expect(() => service.resolveDecision(proposal.decision.decisionId, {
      outcome: 'reject', reviewer: 'attacker',
    })).toThrow(/status=applied/);
  });

  it('多 operation 中任一失败时整次规划不落 state，也不产生半成品 proposal', () => {
    const service = createDynamicPlanningService({
      projectRoot: root,
      configLoader: () => ({ mode: MODES.AUTO_THEN_REVIEW, extensions: {} }),
    });
    const before = fs.readFileSync(statePath, 'utf8');
    expect(() => service.propose({
      ...insertRequest(),
      operations: [
        ...insertRequest().operations,
        { type: 'edit_task', taskId: 'MISSING', patch: { title: '失败' } },
      ],
    })).toThrow(/task MISSING not found/);
    expect(fs.readFileSync(statePath, 'utf8')).toBe(before);
    expect(service.list()).toEqual([]);
  });
});
