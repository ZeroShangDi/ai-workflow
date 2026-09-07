import { describe, it, expect } from 'vitest';
import { STATES, TRANSITIONS, createStateMachine, createStateMachineRegistry } from '../../src/server/statemachine.cjs';

// 会话状态机（W1-030）：单槽 → 按 sid 实例（脚手架迁移矩阵，最终语义由 W1-071 定稿）。

describe('createStateMachine', () => {
  it('初始状态 idle；value()/state 一致', () => {
    const m = createStateMachine({ sid: 'r1' });
    expect(m.value()).toBe('idle');
    expect(m.state).toBe('idle');
  });

  it('can/set：允许迁移置状态并触发 onChange；非法迁移抛错', () => {
    const log = [];
    const m = createStateMachine({ sid: 'r1', onChange: (to, from) => log.push(`${from}->${to}`) });
    expect(m.can('ready')).toBe(true);
    const t = m.set('ready', { by: 'session_start' });
    expect(t).toEqual({ from: 'idle', to: 'ready', by: 'session_start' });
    expect(m.state).toBe('ready');
    expect(() => m.set('idle')).toThrowError(/非法迁移/); // ready→idle 不在矩阵
    expect(log).toEqual(['idle->ready']);
  });

  it('force 可绕过迁移矩阵（紧急兜底）', () => {
    const m = createStateMachine({ sid: 'r1', initialState: 'busy' });
    expect(m.force('error').to).toBe('error');
    expect(m.state).toBe('error');
    expect(m.set('ready').to).toBe('ready'); // error→ready 允许
  });

  it('未知状态抛错', () => {
    expect(() => createStateMachine({ initialState: 'nope' })).toThrowError(/未知状态/);
  });
});

describe('createStateMachineRegistry — 按 sid 隔离', () => {
  it('不同 sid 独立实例互不影响', () => {
    const reg = createStateMachineRegistry();
    const a = reg.get('r1');
    const b = reg.get('r2');
    a.set('ready');
    a.set('busy');
    expect(a.state).toBe('busy');
    expect(b.state).toBe('idle');
  });

  it('get 惰性创建；has/remove/list', () => {
    const reg = createStateMachineRegistry();
    reg.get('r1');
    expect(reg.has('r1')).toBe(true);
    expect(reg.has('r2')).toBe(false);
    reg.remove('r1');
    expect(reg.has('r1')).toBe(false);
    reg.get(null).set('ready');
    expect(reg.list()).toContainEqual({ sid: null, state: 'ready' });
  });

  it('STATES/TRANSITIONS 完整', () => {
    expect(STATES).toContain('deciding');
    expect(TRANSITIONS.busy).toContain('ready');
    expect(TRANSITIONS.ready).toContain('busy');
  });
});
