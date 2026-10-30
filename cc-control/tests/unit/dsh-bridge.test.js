import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDshBridge } = require('../../server/adapters/dsh/bridge.cjs');

/**
 * DSH 指令通道（bridge.cjs）—— P2-4。
 *
 * 这组断言钉的是**三种送达结论不能混用**（spec §6 原则）：
 *   未交给平台（not-delivered） / 无法确认（unconfirmed） / 已交给平台（accepted）。
 * 用假定时器（`setTimer`/`clearTimer` 注入）避开真实等待，纯逻辑可测。
 */

/** 可控定时器：登记回调，由测试手动触发 */
function makeClock() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    /** 触发「最早登记的那个还活着的定时器」 */
    fireNext() {
      const [id, t] = [...timers.entries()].sort((a, b) => a[0] - b[0])[0] || [];
      if (!t) return false;
      timers.delete(id);
      t.fn();
      return true;
    },
    pending() {
      return timers.size;
    },
  };
}

/** 造一条通道 + 记录发送的帧 */
function makeBridge(over = {}) {
  const sent = [];
  const clock = makeClock();
  const bridge = createDshBridge({
    send: (cmd) => { sent.push(cmd); },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...over,
  });
  return { bridge, sent, clock };
}

let unhandled;
beforeEach(() => { unhandled = []; });
afterEach(() => { vi.restoreAllMocks(); });

describe('bridge — 未连接 = 未交给平台（不是失败，也不是成功）', () => {
  it('未 attach 时 request 立即回 not-delivered，且不调用 send', async () => {
    const { bridge, sent } = makeBridge();
    const r = await bridge.request('session.create', { projectRoot: '/p' });
    expect(r.delivery).toBe('not-delivered');
    expect(r.error).toContain('未连接');
    expect(sent).toEqual([]);
    expect(r.commandId).toBeTruthy(); // 仍给 id，便于日志关联
  });

  it('send 抛错 → not-delivered（帧没出去）', async () => {
    const { bridge } = makeBridge({ send: () => { throw new Error('socket gone'); } });
    bridge.attach();
    const r = await bridge.request('session.prompt', { text: 'hi' });
    expect(r.delivery).toBe('not-delivered');
    expect(r.error).toContain('socket gone');
  });
});

describe('bridge — 无法确认（发了但没回执）', () => {
  it('ack 窗口内没回执 → unconfirmed，且**不**当失败/成功', async () => {
    const { bridge, sent, clock } = makeBridge({ ackTimeoutMs: 111 });
    bridge.attach();
    const p = bridge.request('session.create', {}, { projectRoot: '/p' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'command', op: 'session.create', projectRoot: '/p' });
    clock.fireNext(); // ack 超时
    const r = await p;
    expect(r.delivery).toBe('unconfirmed');
    expect(r.error).toContain('是否执行未知');
  });

  it('通道中途断开 → 在途指令一律 unconfirmed，并保留断开原因', async () => {
    const { bridge } = makeBridge();
    bridge.attach();
    const p = bridge.request('session.prompt', { text: 'x' });
    bridge.detach('ws closed');
    const r = await p;
    expect(r.delivery).toBe('unconfirmed');
    expect(r.error).toContain('ws closed');
    expect(bridge.connected()).toBe(false);
    expect(bridge.detachedReason()).toBe('ws closed');
    expect(bridge.pendingCount()).toBe(0);
  });
});

describe('bridge — 已交给平台（accepted 后才等结果）', () => {
  it('accepted → 结果到达 → delivery=accepted + result', async () => {
    const { bridge, sent } = makeBridge();
    bridge.attach();
    const p = bridge.request('session.facts', {});
    const id = sent[0].commandId;
    expect(bridge.onCallback({ commandId: id, phase: 'accepted' })).toBe(true);
    expect(bridge.onCallback({ commandId: id, phase: 'result', ok: true, result: { sessionExists: true } })).toBe(true);
    const r = await p;
    expect(r.delivery).toBe('accepted');
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ sessionExists: true });
  });

  it('accepted 后结果超时 → accepted + error（结果未知，不得视为成功）', async () => {
    const { bridge, sent, clock } = makeBridge({ resultTimeoutMs: 222 });
    bridge.attach();
    const p = bridge.request('session.prompt', { text: 'x' });
    bridge.onCallback({ commandId: sent[0].commandId, phase: 'accepted' });
    clock.fireNext(); // 现在活着的定时器就是结果窗口
    const r = await p;
    expect(r.delivery).toBe('accepted');
    expect(r.ok).toBeUndefined();
    expect(r.error).toContain('未回结果');
  });

  it('平台报错 → accepted + ok:false + error（受理了但失败）', async () => {
    const { bridge, sent } = makeBridge();
    bridge.attach();
    const p = bridge.request('session.create', {});
    bridge.onCallback({ commandId: sent[0].commandId, phase: 'accepted' });
    bridge.onCallback({ commandId: sent[0].commandId, phase: 'result', ok: false, error: 'create failed' });
    const r = await p;
    expect(r).toMatchObject({ delivery: 'accepted', ok: false, error: 'create failed' });
  });

  it('未知 commandId 的回报不被消费（返回 false，交调用方记日志）', () => {
    const { bridge } = makeBridge();
    bridge.attach();
    expect(bridge.onCallback({ commandId: 'nope', phase: 'accepted' })).toBe(false);
  });

  it('同一个 commandId 重复回报只算一次（幂等）', async () => {
    const { bridge, sent } = makeBridge();
    bridge.attach();
    const p = bridge.request('session.facts', {});
    const id = sent[0].commandId;
    bridge.onCallback({ commandId: id, phase: 'accepted' });
    expect(bridge.onCallback({ commandId: id, phase: 'result', ok: true, result: 1 })).toBe(true);
    bridge.onCallback({ commandId: id, phase: 'result', ok: false, error: 'late' });
    expect((await p).ok).toBe(true);
  });
});

describe('bridge — 事实与事件', () => {
  it('noteFacts / lastFacts 合并最近已知值并带 updatedAt', () => {
    const { bridge } = makeBridge();
    bridge.noteFacts({ sessionExists: true, cwd: '/p' });
    bridge.noteFacts({ ready: true });
    const f = bridge.lastFacts();
    expect(f).toMatchObject({ sessionExists: true, cwd: '/p', ready: true });
    expect(typeof f.updatedAt).toBe('string');
  });

  it('attach 记录平台/版本事实（版本可识别，spec §6 原则）', () => {
    const { bridge } = makeBridge();
    bridge.attach({ platform: 'dsh', pluginVersion: '0.0.1' });
    expect(bridge.lastFacts()).toMatchObject({ platform: 'dsh', pluginVersion: '0.0.1' });
  });

  it('事件回报分发给订阅者，并可带 facts 一起刷新', () => {
    const { bridge } = makeBridge();
    const seen = [];
    const off = bridge.onEvent((e) => seen.push(e));
    bridge.onCallback({ kind: 'event', event: { type: 'session.started' }, facts: { sessionExists: true } });
    expect(seen).toEqual([{ type: 'session.started' }]);
    expect(bridge.lastFacts().sessionExists).toBe(true);
    off();
    bridge.onCallback({ kind: 'event', event: { type: 'session.stopped' } });
    expect(seen).toHaveLength(1);
  });

  it('单个订阅者抛错不影响其他订阅者与通道', () => {
    const { bridge } = makeBridge();
    const seen = [];
    bridge.onEvent(() => { throw new Error('bad subscriber'); });
    bridge.onEvent((e) => seen.push(e));
    expect(() => bridge.onCallback({ kind: 'event', event: { type: 'x' } })).not.toThrow();
    expect(seen).toHaveLength(1);
  });
});
