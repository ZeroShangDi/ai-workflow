import { describe, it, expect } from 'vitest';
import { PORT_NAMES, createCcAdapters } from '../../src/adapters/ports.cjs';

function stubExec() {
  const fn = (cmd, args) => {
    if (args[0] === 'has-session') return '';
    throw new Error('not implemented');
  };
  return fn;
}

describe('ports — cc adapter 契约（host/hook）', () => {
  it('PORT_NAMES 至少含 host/hook', () => {
    expect(PORT_NAMES).toContain('host');
    expect(PORT_NAMES).toContain('hook');
  });

  it('host 端口：原语可跑（注入 execFileSync，has-session 命中）', () => {
    let called = false;
    const exec = (cmd, args) => {
      if (args[0] === 'has-session') { called = true; return ''; }
      return '';
    };
    const { host } = createCcAdapters({ sessionName: 'cc-r1', execFileSync: exec });
    expect(host.sessionName).toBe('cc-r1');
    expect(host.hasSession()).toBe(true);
    expect(called).toBe(true);
  });

  it('hook 端口：SessionStart → 领域事件上抛到 bus', () => {
    const events = [];
    const bus = { emit: (e) => events.push(e) };
    const { hook } = createCcAdapters({ bus });
    const n = hook.hook({ hook_event_name: 'SessionStart', session_id: 's1' }, { runId: 'r1' });
    expect(n).toBe(1);
    expect(events[0].type).toBe('run.started');
    expect(events[0].runId).toBe('r1');
    // PreToolUse 不产出
    expect(hook.hook({ hook_event_name: 'PreToolUse' })).toBe(0);
  });
});
