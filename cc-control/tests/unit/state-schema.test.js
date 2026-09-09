import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const schema = require('../../src/lib/state-schema.cjs');

// T1-096：state.json 字段/枚举单源（store/migrate/文档/前端共用）直接单测。

describe('state-schema 单源', () => {
  it('版本与工作流顶层枚举', () => {
    expect(schema.STATE_SCHEMA_VERSION).toBe('0.2.0');
    expect(schema.MODES).toEqual(expect.arrayContaining(['idle', 'plan', 'run', 'pause']));
    expect(schema.PHASES).toEqual(expect.arrayContaining(['CODE', 'REVIEW', 'TEST', 'FINISH']));
    expect(schema.TASK_STATUSES).toEqual(['pending', 'active', 'done', 'blocked']);
    expect(schema.TASK_KINDS).toEqual(expect.arrayContaining(['dev', 'review', 'test', 'doc', 'commit', 'ui-design', 'ui-code']));
    expect(schema.MILESTONE_STATUSES).toEqual(['active', 'done']);
  });

  it('顶层/各段键位声明与枚举字段定义自洽', () => {
    expect(schema.ROOT_FIELDS).toEqual(expect.arrayContaining(['mode', 'currentState', 'version', 'tasks', 'wbs', 'plan', 'lastUpdated', 'milestones']));
    expect(schema.TASK_FIELDS).toContain('exec');
    expect(schema.EXEC_FIELDS).toEqual(expect.arrayContaining(['result', 'files', 'verdict', 'architecture']));
    expect(schema.WBS_FIELDS).toEqual(['id', 'name', 'desc', 'acceptance', 'deps']);
    expect(schema.FIELD_DEFS['task.kind'].enum).toEqual(schema.TASK_KINDS);
    expect(schema.FIELD_DEFS['task.status'].enum).toEqual(schema.TASK_STATUSES);
    expect(schema.FIELD_DEFS.mode.enum).toEqual(schema.MODES);
    expect(schema.FIELD_DEFS['milestone.status'].enum).toEqual(schema.MILESTONE_STATUSES);
  });

  it('isValid 便捷判定', () => {
    expect(schema.isValid.mode('run')).toBe(true);
    expect(schema.isValid.mode('fly')).toBe(false);
    expect(schema.isValid.phase('DEBUG')).toBe(true);
    expect(schema.isValid.taskStatus('blocked')).toBe(true);
    expect(schema.isValid.taskKind('ui-code')).toBe(true);
  });

  it('validateStateShape：合法结构通过，非法枚举/缺 id 逐条报错', () => {
    const ok = schema.validateStateShape({
      mode: 'run', currentState: 'CODE',
      tasks: [{ id: 'T1', status: 'pending', kind: 'dev' }],
      milestones: [{ id: 'M1', status: 'active' }],
    });
    expect(ok.ok).toBe(true);
    expect(ok.errors).toEqual([]);

    const bad = schema.validateStateShape({
      mode: 'fly', currentState: 'NOPE',
      tasks: [{ status: 'wat', kind: 'hax' }, { id: 'T2', status: 'done', kind: 'dev' }],
      milestones: [{ id: 'M1', status: 'maybe' }],
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join('\n')).toContain('mode 应为');
    expect(bad.errors.join('\n')).toContain('currentState 应为');
    expect(bad.errors.join('\n')).toContain('tasks[0].id 缺失');
    expect(bad.errors.join('\n')).toContain('tasks[0].status 应为');
    expect(bad.errors.join('\n')).toContain('tasks[0].kind 应为');
    expect(bad.errors.join('\n')).toContain('milestones[0].status 应为');
  });

  it('非对象输入 → 拒绝', () => {
    expect(schema.validateStateShape(null).ok).toBe(false);
    expect(schema.validateStateShape('x').ok).toBe(false);
  });
});
