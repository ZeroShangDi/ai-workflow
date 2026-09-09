import { describe, it, expect } from 'vitest';
import { PORT_CONTRACT, PORT_NAMES, createCcAdapters } from '../../src/adapters/ports.cjs';
import { createMockAdapters } from '../../src/adapters/mock.cjs';

describe('ports 契约定稿（7 端口 + 文档）', () => {
  it('7 端口齐备且名册唯一', () => {
    expect(PORT_NAMES).toEqual(['host', 'hook', 'oneshot', 'tooling', 'interactive', 'probe', 'session']);
    expect(new Set(PORT_CONTRACT.map((p) => p.name)).size).toBe(7);
    expect(PORT_CONTRACT.filter((p) => p.impl).map((p) => p.name)).toEqual(['host', 'hook', 'interactive', 'probe']);
  });

  it('host/hook/interactive/probe 有 cc 实现（createCcAdapters）', () => {
    const adapters = createCcAdapters({ sessionName: 'cc-r1' });
    expect(typeof adapters.host.capture).toBe('function');
    expect(typeof adapters.hook.hook).toBe('function');
    expect(typeof adapters.interactive.launchDialog).toBe('function');
    expect(typeof adapters.probe.inspect).toBe('function');
  });
});

describe('mock adapter 夹具（7 端口全量）', () => {
  it('createMockAdapters 覆盖 7 端口并记录调用', async () => {
    const mock = createMockAdapters();
    expect(Object.keys(mock.ports)).toEqual(PORT_NAMES);
    mock.ports.host.sendText('hi');
    await mock.ports.oneshot.run('p');
    mock.ports.hook.hook({ hook_event_name: 'Stop' }, { runId: 'r' });
    expect(mock.calls).toEqual([
      ['host.sendText', 'hi'],
      ['oneshot.run', 'p'],
      ['hook.hook', { hook_event_name: 'Stop' }, { runId: 'r' }],
    ]);
    mock.reset();
    expect(mock.calls).toEqual([]);
  });

  it('canned 默认值可用（host.capture/hook.hook 计数/oneshot ok）', async () => {
    const mock = createMockAdapters();
    expect(mock.ports.host.hasSession()).toBe(true);
    expect(mock.ports.host.capture()).toBe('pane');
    expect(mock.ports.hook.hook({}, {})).toBe(1);
    expect((await mock.ports.oneshot.run('x')).ok).toBe(true);
  });
});
