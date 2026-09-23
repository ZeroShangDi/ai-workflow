import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sourceOf,
  sourceLabel,
  sourceShort,
  gateOf,
  TASK_SOURCES,
} from '../src/pages/Tasks/model.js';
import { TASK_STATUSES } from '../src/shared/lib/format.js';

test('任务来源：字段缺失时按 ID 约定兜底，余者一律原计划', () => {
  assert.equal(sourceOf({ id: 'T1-001' }), 'plan');
  assert.equal(sourceOf({ id: 'T3-009-F1' }), 'gate_fix');
  assert.equal(sourceOf({ id: 'T3-010-F2' }), 'gate_fix');
  assert.equal(sourceOf(null), 'plan');
});

test('任务来源：server 字段优先于 ID 约定', () => {
  // id 不像门禁派生，但字段说了是——以字段为准
  assert.equal(sourceOf({ id: 'AL-1', source: 'dynamic_planning' }), 'dynamic_planning');
  // id 像门禁派生，但字段说了是别的——仍以字段为准
  assert.equal(sourceOf({ id: 'T3-009-F1', source: 'gate_fix' }), 'gate_fix');
});

test('任务来源：未知值原样透出，不伪装成原计划', () => {
  assert.equal(sourceOf({ id: 'X', source: 'human' }), 'human');
  assert.equal(sourceLabel('human'), 'human');
  assert.equal(sourceShort('human'), 'human');
});

test('任务来源：标签与门禁 id 反推', () => {
  assert.deepEqual(TASK_SOURCES, ['plan', 'gate_fix', 'dynamic_planning']);
  assert.equal(sourceLabel('plan'), '原计划');
  assert.equal(sourceLabel('gate_fix'), '门禁回退派生');
  assert.equal(sourceLabel('dynamic_planning'), '运行期动态规划');
  assert.equal(sourceShort('dynamic_planning'), '动态规划');
  assert.equal(gateOf({ id: 'T3-009-F1' }), 'T3-009');
  assert.equal(gateOf({ id: 'T1-001' }), null);
});

test('任务状态：五态固定顺序', () => {
  assert.deepEqual(TASK_STATUSES, ['active', 'pending', 'blocked', 'error', 'done']);
});
