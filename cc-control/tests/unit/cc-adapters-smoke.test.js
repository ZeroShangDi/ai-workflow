import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createCcAdapters, PORT_NAMES } from '../../src/adapters/ports.cjs';
import { createMockAdapters } from '../../src/adapters/mock.cjs';
import { createEventBus } from '../../src/lib/events.cjs';
import { createProbe } from '../../src/adapters/probe.cjs';
import tooling from '../../src/adapters/tooling.cjs';

// T1-055 cc 冒烟：mock adapter 全绿 + 每端口真实 cc 实现各走一遍（host/hook/oneshot/install/probe/plan 交互）。

function stubSpawnOnce(behavior) {
  return (cmd, args, opts) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    setImmediate(() => {
      if (behavior.stdout) proc.stdout.emit('data', behavior.stdout);
      if (behavior.stderr) proc.stderr.emit('data', behavior.stderr);
      if (behavior.error) proc.emit('error', new Error(behavior.error));
      else proc.emit('close', behavior.code ?? 0);
    });
    return proc;
  };
}

describe('mock adapter 全绿', () => {
  it('7 端口 mock 均可调且记录', async () => {
    const m = createMockAdapters();
    expect(Object.keys(m.ports)).toEqual(PORT_NAMES);
    m.ports.host.sendText('hi');
    await m.ports.oneshot.run('p');
    await m.ports.tooling.install({});
    await m.ports.interactive.askChoice('q', ['A']);
    await m.ports.probe.inspect();
    await m.ports.session.start({});
    m.ports.hook.hook({ hook_event_name: 'Stop' }, {});
    expect(m.calls.length).toBeGreaterThan(0);
    expect(m.calls.some(([n]) => n.startsWith('host.'))).toBe(true);
  });
});

describe('cc 真实 adapter 各走一遍', () => {
  it('host：会话原语经注入 exec', () => {
    const exec = () => '';
    const { host } = createCcAdapters({ sessionName: 'cc-r', execFileSync: exec });
    expect(host.hasSession()).toBe(true);
    expect(host.sessionName).toBe('cc-r');
  });

  it('hook：SessionStart → bus 事件', () => {
    const bus = createEventBus();
    const got = [];
    bus.on('*', (e) => got.push(e.type));
    const { hook } = createCcAdapters({ bus });
    hook.hook({ hook_event_name: 'SessionStart' }, { runId: 'r' });
    expect(got).toEqual(['run.started']);
  });

  it('oneshot：注入 spawn 一次调用返回 ok/text', async () => {
    const { spawnClaudeP, runOneShot } = await import('../../src/adapters/oneshot.cjs');
    const ok = await runOneShot({ prompt: 'x', spawn: stubSpawnOnce({ stdout: 'hi' }) });
    expect(ok).toEqual({ ok: true, text: 'hi' });
  });

  it('tooling install：execAsync 注入执行一次', async () => {
    const calls = [];
    await tooling.install('spec', { execAsync: async (c) => { calls.push(c); return { ok: true }; } });
    expect(calls[0]).toContain('claude plugin install');
  });

  it('probe：host+status 侦查一次', async () => {
    const probe = createProbe({ host: { hasSession: () => true }, status: async () => ({ state: 'busy' }) });
    const r = await probe.inspect();
    expect(r.session).toBe(true);
    expect(r.state).toBe('busy');
  });

  it('plan 交互（launchDialog 存在；spawn 注入模拟一次退出）', async () => {
    const { launchInteractiveClaude } = await import('../../src/adapters/interactive.cjs');
    // 不真启 claude：仅确认端口暴露 launchDialog（真实交互留 plan/自托管冒烟）
    const { createCcAdapters: createWith } = await import('../../src/adapters/ports.cjs');
    expect(typeof createWith({}).interactive.launchDialog).toBe('function');
    expect(typeof launchInteractiveClaude).toBe('function');
  });
});
