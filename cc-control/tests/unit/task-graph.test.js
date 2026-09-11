import { describe, it, expect } from 'vitest';

import taskGraph from '../../src/lib/task-graph.cjs';

const {
  taskGraphErrors,
  assertTaskGraph,
  assertTaskDependenciesDone,
  insertPrerequisiteTask,
  replaceTaskDependencies,
  removeTaskFromGraph,
} = taskGraph;

const task = (id, overrides = {}) => ({ id, status: 'pending', deps: [], ...overrides });

describe('task graph validation', () => {
  it('合法 DAG 通过', () => {
    expect(taskGraphErrors([task('A'), task('B', { deps: ['A'] })])).toEqual([]);
    expect(assertTaskGraph([task('A'), task('B', { deps: ['A'] })])).toBe(true);
  });

  it('同时报告重复 id、缺失依赖、自依赖和重复边', () => {
    const errors = taskGraphErrors([
      task('A'), task('A'), task('B', { deps: ['B', 'MISSING', 'MISSING'] }),
    ]);
    expect(errors.map((error) => error.code)).toEqual(expect.arrayContaining([
      'TASK_ID_DUPLICATE', 'TASK_SELF_DEP', 'TASK_DEP_MISSING', 'TASK_DEP_DUPLICATE',
    ]));
  });

  it('检测依赖环', () => {
    const errors = taskGraphErrors([task('A', { deps: ['C'] }), task('B', { deps: ['A'] }), task('C', { deps: ['B'] })]);
    expect(errors.some((error) => error.code === 'TASK_DEP_CYCLE')).toBe(true);
    expect(() => assertTaskGraph([task('A', { deps: ['B'] }), task('B', { deps: ['A'] })])).toThrow(/cycle/);
  });

  it('派发/完成边界拒绝未完成前置任务', () => {
    const tasks = [task('A'), task('B', { deps: ['A'] })];
    expect(() => assertTaskDependenciesDone(tasks, 'B')).toThrow(/incomplete dependencies: A/);
    tasks[0].status = 'done';
    expect(assertTaskDependenciesDone(tasks, 'B')).toBe(true);
  });
});

describe('insertPrerequisiteTask', () => {
  it('把前置任务插到目标之前并自动连依赖', () => {
    const state = { tasks: [task('A', { status: 'done' }), task('G', { deps: ['A'] }), task('NEXT')] };
    const inserted = insertPrerequisiteTask(state, {
      targetId: 'G',
      task: task('G-F1', { deps: ['A'] }),
    });
    expect(state.tasks.map((item) => item.id)).toEqual(['A', 'G-F1', 'G', 'NEXT']);
    expect(inserted.target.deps).toEqual(['A', 'G-F1']);
  });

  it('active 目标拒绝动态增加前置且 state 不变', () => {
    const state = { tasks: [task('A'), task('G', { status: 'active' })] };
    const before = structuredClone(state);
    expect(() => insertPrerequisiteTask(state, { targetId: 'G', task: task('G-F1') })).toThrow(/status=active/);
    expect(state).toEqual(before);
  });

  it('前置任务引入环时拒绝且 state 不变', () => {
    const state = { tasks: [task('G'), task('NEXT', { deps: ['G'] })] };
    const before = structuredClone(state);
    expect(() => insertPrerequisiteTask(state, {
      targetId: 'G',
      task: task('G-F1', { deps: ['NEXT'] }),
    })).toThrow(/cycle/);
    expect(state).toEqual(before);
  });
});

describe('依赖更新与删除保护', () => {
  it('active 任务不能新增未完成依赖', () => {
    const state = { tasks: [task('A'), task('RUN', { status: 'active' })] };
    const before = structuredClone(state);
    expect(() => replaceTaskDependencies(state, 'RUN', ['A'])).toThrow(/active task/);
    expect(state).toEqual(before);
  });

  it('active 任务允许新增已经完成的依赖', () => {
    const state = { tasks: [task('A', { status: 'done' }), task('RUN', { status: 'active' })] };
    expect(replaceTaskDependencies(state, 'RUN', ['A']).deps).toEqual(['A']);
  });

  it('依赖更新造成环时拒绝', () => {
    const state = { tasks: [task('A'), task('B', { deps: ['A'] })] };
    expect(() => replaceTaskDependencies(state, 'A', ['B'])).toThrow(/cycle/);
  });

  it('有依赖者时拒绝删除任务', () => {
    const state = { tasks: [task('A'), task('B', { deps: ['A'] })] };
    expect(() => removeTaskFromGraph(state, 'A')).toThrow(/depended on by B/);
    expect(removeTaskFromGraph(state, 'B')).toBe(true);
    expect(state.tasks.map((item) => item.id)).toEqual(['A']);
  });
});
