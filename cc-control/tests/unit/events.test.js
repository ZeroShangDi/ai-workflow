import { describe, it, expect } from 'vitest';
import {
  EVENT_DEFS,
  HOOK_EVENT_MAP,
  EVENT_TYPES,
  createEvent,
  persistSinkFor,
  createEventBus,
  wirePersist,
} from '../../src/lib/events.cjs';

// events 总线 + 首批领域事件类型（W1-028）：run/task/agent/hook 映射锚点 + persist 落盘锚点。

describe('createEvent / EVENT_DEFS', () => {
  it('归一化事件补 at/runId；类型目录齐全', () => {
    const e = createEvent('task.started', { taskId: 'T1' }, 'r1');
    expect(e.type).toBe('task.started');
    expect(e.runId).toBe('r1');
    expect(typeof e.at).toBe('string');
    expect(EVENT_TYPES.length).toBeGreaterThan(10);
    expect(Object.keys(HOOK_EVENT_MAP)).toContain('SubagentStop');
  });

  it('未知类型 / 缺必需载荷键抛错', () => {
    expect(() => createEvent('nope', {})).toThrowError(/未知事件类型/);
    expect(() => createEvent('agent.stopped', { agentId: 'a' })).toThrowError(/缺少必需载荷键 taskId/);
  });

  it('persist 锚点：usage/metrics/decision 事件映射到自身 sink', () => {
    expect(persistSinkFor('usage.snapshot')).toBe('usage.snapshot');
    expect(persistSinkFor('metrics.snapshot')).toBe('metrics.snapshot');
    expect(persistSinkFor('decision.record')).toBe('decision.record');
    expect(persistSinkFor('task.started')).toBeNull();
  });
});

describe('createEventBus — on/off/emit', () => {
  it('type 订阅 + 通配订阅均触发，emit 返回命中数', () => {
    const bus = createEventBus();
    const got = [];
    bus.on('task.done', (e) => got.push(`t:${e.payload.taskId}`));
    bus.on('*', (e) => got.push(`*:${e.type}`));
    const n = bus.emit(createEvent('task.done', { taskId: 'T1' }));
    expect(n).toBe(2);
    expect(got).toContain('t:T1');
  });

  it('off 取消订阅', () => {
    const bus = createEventBus();
    const got = [];
    const off = bus.on('run.started', () => got.push(1));
    bus.emit(createEvent('run.started', {}, 'r'));
    off();
    bus.emit(createEvent('run.started', {}, 'r'));
    expect(got).toHaveLength(1);
  });

  it('单 handler 异常被吞不影响其他 handler', () => {
    const bus = createEventBus();
    const got = [];
    bus.on('run.phase', () => { throw new Error('boom'); });
    bus.on('run.phase', () => got.push(1));
    const n = bus.emit(createEvent('run.phase', { phase: 'CODE' }, 'r'));
    expect(n).toBe(2); // 两 handler 都被调（异常被吞）
    expect(got).toEqual([1]);
  });
});

describe('wirePersist — 事件 → persist 落盘', () => {
  it('按 persist 锚点把事件派发给 dispatch；无锚点事件忽略', () => {
    const bus = createEventBus();
    const dispatched = [];
    wirePersist(bus, null, { dispatch: (ev) => dispatched.push(ev) });
    bus.emit(createEvent('usage.snapshot', { used_percentage: 60 }));
    bus.emit(createEvent('task.started', { taskId: 'T1' }));
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].type).toBe('usage.snapshot');
    expect(dispatched[0].payload.used_percentage).toBe(60);
  });
});
