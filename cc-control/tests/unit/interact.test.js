import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  validateDecisionRequest,
  isAwaitDecision,
  createReadyLatch,
  handoffPath,
  readHandoff,
  writeHandoff,
} from '../../src/server/interact.cjs';

const tmpDirs = [];
function tmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-interact-'));
  tmpDirs.push(root);
  fs.mkdirSync(path.join(root, '.awf', 'context'), { recursive: true });
  return root;
}
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('validateDecisionRequest', () => {
  it('choice：question/options/context → 决策模型', () => {
    const r = validateDecisionRequest('choice', { question: 'Q?', options: ['A', 'B'], context: 'ctx' });
    expect(r.ok).toBe(true);
    expect(r.decision).toEqual({ type: 'choice', question: 'Q?', options: ['A', 'B'], context: 'ctx' });
  });

  it('text：无 options；缺 question 返回错误（语义与旧端点 400 一致）', () => {
    expect(validateDecisionRequest('text', { question: '输入?' }).decision.options).toBeUndefined();
    expect(validateDecisionRequest('choice', {}).ok).toBe(false);
    expect(validateDecisionRequest('text', null).error).toContain('body must be {question: string}');
  });
});

describe('isAwaitDecision / createReadyLatch / handoff', () => {
  it('isAwaitDecision：choice/text 为真，其余假', () => {
    expect(isAwaitDecision({ type: 'choice', question: 'x' })).toBe(true);
    expect(isAwaitDecision({ type: 'text', question: 'x' })).toBe(true);
    expect(isAwaitDecision(null)).toBe(false);
    expect(isAwaitDecision({ type: 'run' })).toBe(false);
  });

  it('ready latch：mark/consume 一次性、reset', () => {
    const latch = createReadyLatch();
    expect(latch.get()).toBe(false);
    expect(latch.mark()).toBe(true);
    expect(latch.consume()).toBe(true);
    expect(latch.get()).toBe(false); // consume 已复位
    latch.mark();
    latch.reset();
    expect(latch.get()).toBe(false);
  });

  it('handoff 写读（原子写）与路径', () => {
    const root = tmpProject();
    writeHandoff(root, 'snapshot text');
    expect(readHandoff(root)).toBe('snapshot text');
    expect(handoffPath(root)).toBe(path.join(root, '.awf', 'context', 'handoff.md'));
    expect(readHandoff(tmpProject())).toBeNull();
  });
});
