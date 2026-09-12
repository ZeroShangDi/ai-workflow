import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRunSlot } = require('../../src/server/run-slot.cjs');

// T1-071：内存状态机按 sid 隔离（ready/busy/decision 不串 run）。

describe('createRunSlot（per-run 内存状态机隔离）', () => {
  it('ready/busy 按槽隔离：a busy 不影响 b ready；waitReady 不跨槽唤醒', async () => {
    const a = createRunSlot('a');
    const b = createRunSlot('b');
    a.setBusy();
    expect(a.state).toBe('busy');
    expect(b.state).toBe('ready');
    expect(await b.waitReady(5)).toBe(true); // b 已 ready 立即返回
    const waited = a.waitReady(20);
    expect(await Promise.race([waited, Promise.resolve('pending')])).toBe('pending');
    a.setReady();
    expect(await waited).toBe(true); // 仅 a setReady 唤醒 a 等待者
    expect(b.state).toBe('ready');
  });

  it('decisionPending 按槽隔离：set/clear 互不影响', () => {
    const a = createRunSlot('a');
    const b = createRunSlot('b');
    a.setDecision({ type: 'choice', question: 'A?' });
    expect(a.decisionPending.question).toBe('A?');
    expect(b.decisionPending).toBe(null);
    b.setDecision({ type: 'text', question: 'B?' });
    expect(a.decisionPending.question).toBe('A?'); // 不串
    a.clearDecision();
    expect(a.decisionPending).toBe(null);
    expect(b.decisionPending.question).toBe('B?');
  });

  it('snapshot/reset：只暴露真的被维护的字段', () => {
    const a = createRunSlot('a');
    a.setDecision({ type: 'choice', question: 'A?' });
    expect(a.snapshot()).toMatchObject({ sid: 'a', state: 'ready', decisionPending: { question: 'A?' }, activeWaiters: 0 });
    a.reset();
    expect(a.snapshot()).toMatchObject({ state: 'ready', decisionPending: null, activeWaiters: 0 });
  });

  // issue 004-2：槽里曾有一个 contextReady 字段 + setContextReady()，但全仓零调用 ——
  // `GET /status?sid` 因此恒返回 false（永假值），而真标记是**项目级**的 pcx.contextReady。
  // 处置是「摘除」（宁缺勿假），故这里钉住的是**它不存在**，而不是它的行为。
  it('不暴露永假字段 contextReady（死字段已摘除，见 issue 004-2）', () => {
    const a = createRunSlot('a');
    expect('contextReady' in a).toBe(false);
    expect(a.snapshot()).not.toHaveProperty('contextReady');
    expect(() => a.setContextReady(true)).toThrow(TypeError);
  });
});
