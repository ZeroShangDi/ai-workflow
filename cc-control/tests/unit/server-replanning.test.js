import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  MODES,
  createDynamicPlanningService,
  createDynamicPlanningDecisionPort,
} = require('../../server/features/replanning/index.cjs');
const { DecisionStore } = require('../../server/features/decision/store.cjs');

// 本文件测的是新 server 树（server/features/replanning）。旧树 src/server/dynamic-planning 仍在
// 被 awf run 执行，其回归由 tests/unit/dynamic-planning.test.js 负责——在 CLI 切换前两者并存。

function baseState() {
  return {
    mode: 'run',
    version: '0.2.0',
    lastUpdated: '2026-09-11T00:00:00.000Z',
    plan: { acceptanceCriteria: ['保持模块化架构'] },
    tasks: [
      { id: 'A', title: '基础', status: 'done', deps: [], acceptance: 'A 完成' },
      { id: 'B', title: '模块实现', status: 'pending', deps: ['A'], wbsRef: 'W1', acceptance: '模块完成' },
      { id: 'G', title: '模块门禁', kind: 'review', status: 'pending', deps: ['B'], acceptance: '模块验收' },
    ],
    milestones: [{ id: 'M1', status: 'active', tasks: ['A', 'B', 'G'] }],
  };
}

describe('server · 动态任务规划（replanning）', () => {
  let root;
  let statePath;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-server-replanning-'));
    fs.mkdirSync(path.join(root, '.awf'), { recursive: true });
    statePath = path.join(root, '.awf', 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(baseState(), null, 2));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function service(extensions) {
    return createDynamicPlanningService({
      projectRoot: root,
      configLoader: () => ({ mode: MODES.AUTO_THEN_REVIEW, extensions: {} }),
      decisionPort: createDynamicPlanningDecisionPort({ storeFactory: () => new DecisionStore(root) }),
      extensions,
    });
  }

  it('decision 批准应用后 afterApply 拿到的是重放后的新状态（不是创建时快照）', () => {
    // 判据：提案创建后、批准前，别处改了 state。若钩子拿到的是创建时快照，这个改动就不在里面；
    // 只有「在锁内用 operations 对最新 state 重放」才会带上它。
    const seen = [];
    const svc = service({ afterApply: ({ state }) => seen.push(state) });
    const proposal = svc.propose({
      reason: '尝试删除模块实现',
      operations: [{ type: 'delete_task', taskId: 'B' }],
    });
    // 模拟 run 在等人批准期间继续前进（顶层改动，不在受影响闭包内 → 不触发 conflicted）
    const drifted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    drifted.marker = 'written-after-proposal';
    fs.writeFileSync(statePath, JSON.stringify(drifted, null, 2));

    svc.resolveDecision(proposal.decision.decisionId, { outcome: 'approve', reviewer: 'human' });

    expect(seen).toHaveLength(1);
    expect(seen[0].marker).toBe('written-after-proposal'); // ← 创建时快照不会有它
    expect(seen[0].tasks.some((task) => task.id === 'B')).toBe(false); // 重放仍按 operations 生效
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).marker).toBe('written-after-proposal'); // 落盘的同一份
  });

  it('state 布局单源：replanning 与 shared/state.js 读写的是同一份 state.json', async () => {
    // state 文件布局（.awf/state.json + .awf/state.lock）由 shared/state-paths.cjs 单源给出，
    // replanning 不再自己拼字面量 —— 这条钉住「两处指的是同一个文件」。
    const { loadState } = await import('../../server/shared/state.js');
    const svc = createDynamicPlanningService({
      projectRoot: root,
      configLoader: () => ({ mode: MODES.APPROVE_THEN_APPLY, extensions: {} }),
    });
    const proposal = svc.propose({
      reason: '模块实现缺少对接层',
      operations: [{
        type: 'insert_task',
        relation: { type: 'prerequisite_for', targetTaskId: 'B' },
        task: {
          id: 'I', title: '模块对接', prompt: '实现模块之间的装配',
          acceptance: '模块通过对接层协作', plannedFiles: ['src/integration.js'],
        },
      }],
    });

    // propose 会把 hold 写进 state；经 shared/state.js 的 loadState 应能同址读到
    const viaShared = loadState(root);
    expect(viaShared.dynamicPlanning.holds[proposal.proposalId]).toBeTruthy();
    expect(viaShared.tasks.map((t) => t.id)).toEqual(['A', 'B', 'G']); // hold 不插任务，只挡调度
  });

  it('approve 路径的 afterApply 同样拿到重放后的新状态（两条路径一致）', () => {
    const seen = [];
    const svc = createDynamicPlanningService({
      projectRoot: root,
      configLoader: () => ({ mode: MODES.APPROVE_THEN_APPLY, extensions: {} }),
      extensions: { afterApply: ({ state }) => seen.push(state) },
    });
    const proposal = svc.propose({
      reason: '模块实现缺少对接层',
      operations: [{
        type: 'insert_task',
        relation: { type: 'prerequisite_for', targetTaskId: 'B' },
        task: {
          id: 'I', title: '模块对接', prompt: '实现模块之间的装配',
          acceptance: '模块通过对接层协作', plannedFiles: ['src/integration.js'],
        },
      }],
    });
    const drifted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    drifted.marker = 'written-after-proposal';
    fs.writeFileSync(statePath, JSON.stringify(drifted, null, 2));

    svc.approve(proposal.proposalId, { reviewer: 'human' });

    expect(seen).toHaveLength(1);
    expect(seen[0].marker).toBe('written-after-proposal');
    expect(seen[0].tasks.map((task) => task.id)).toEqual(['A', 'I', 'B', 'G']);
  });
});
