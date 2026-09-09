import { describe, it, expect } from 'vitest';
import { levelOf, buildWbsTree } from '../../web/src/views/wbs-tree-model.js';

// T1-090：WBS-Tree 视图模型（state.wbs + tasks → 树，纯逻辑可测）。

describe('levelOf', () => {
  it('W 编号取语义层级', () => {
    expect(levelOf('W4-001')).toBe(4);
    expect(levelOf('W1-089')).toBe(1);
    expect(levelOf('w3-002')).toBe(3); // 大小写容忍
  });
  it('非法 id → 0', () => {
    expect(levelOf('T1-001')).toBe(0);
    expect(levelOf(undefined)).toBe(0);
  });
});

describe('buildWbsTree', () => {
  it('嵌套 wbs（children 声明）→ 真树 + 任务状态绑定', () => {
    const wbs = [
      { id: 'W4-001', name: '重构 v0.2.0', children: ['W3-001', 'W3-002'] },
      { id: 'W3-001', name: 'config 模块', desc: '配置单源', children: ['W1-001'] },
      { id: 'W3-002', name: 'store 模块' },
      { id: 'W1-001', name: 'config-loader 共享模块', acceptance: '默认/env/校验' },
    ];
    const tasks = [
      { id: 'T1-001', wbsRef: 'W1-001', kind: 'dev', status: 'done' },
      { id: 'T3-001', wbsRef: 'W3-001', kind: 'test', status: 'active' },
    ];
    const { roots, stats } = buildWbsTree({ wbs, tasks });

    expect(roots).toHaveLength(1);
    expect(roots[0].id).toBe('W4-001');
    expect(roots[0].children.map((c) => c.id)).toEqual(['W3-001', 'W3-002']);

    const m1 = roots[0].children[0];
    expect(m1.children[0].id).toBe('W1-001');
    expect(m1.children[0].task).toEqual({ id: 'T1-001', kind: 'dev', status: 'done' }); // wbsRef 命中
    expect(m1.task).toEqual({ id: 'T3-001', kind: 'test', status: 'active' }); // 父节点可独立绑定任务

    expect(stats.total).toBe(4);
    expect(stats.withTask).toBe(2);
    expect(stats.byStatus.done).toBe(1);
    expect(stats.byStatus.active).toBe(1);
  });

  it('扁平 wbs（无 children）→ 平铺为根（不臆造父层），保持原序', () => {
    const wbs = [
      { id: 'W3-001', name: '模块 A' },
      { id: 'W1-001', name: '子任务 A1' },
      { id: 'W1-002', name: '子任务 A2' },
    ];
    const tasks = [
      { id: 'T1-001', wbsRef: 'W1-001', kind: 'dev', status: 'done' },
      { id: 'T1-002', wbsRef: 'W1-002', kind: 'dev', status: 'blocked' },
    ];
    const { roots, stats } = buildWbsTree({ wbs, tasks });

    expect(roots.map((r) => r.id)).toEqual(['W3-001', 'W1-001', 'W1-002']);
    expect(roots.every((r) => r.children.length === 0)).toBe(true);
    expect(roots[1].task.status).toBe('done');
    expect(roots[2].task.status).toBe('blocked');
    expect(roots[0].task).toBe(null);
    expect(stats.byStatus.blocked).toBe(1);
  });

  it('缺省入参/引用悬空 → 安全兜底', () => {
    const empty = buildWbsTree({});
    expect(empty.roots).toEqual([]);
    expect(empty.stats.total).toBe(0);

    const dangling = buildWbsTree({
      wbs: [{ id: 'W1-001', name: 'X' }],
      tasks: [{ id: 'T1-001', wbsRef: 'W9-999', kind: 'dev', status: 'done' }], // wbsRef 不在 wbs
    });
    expect(dangling.roots[0].task).toBe(null); // 悬空引用不命中
  });
});
