import { describe, it, expect } from 'vitest';
import {
  PORT_CONTRACT, PORT_NAMES, NON_PORT_TOOLS, assertPortContract, createCcAdapters,
} from '../../src/adapters/ports.cjs';
import { createMockAdapters } from '../../src/adapters/mock.cjs';

/**
 * ports 契约（T1-116 补全）。
 *
 * 这组断言的立场：**契约是给消费者照着写的**（T1-117 生产要改走端口），所以
 * 「声明的方法在端口对象上真实存在」是硬要求 —— 此前契约写着 `oneshot.run` / `tooling.list`
 * / `interactive.askChoice`，而它们一个都不存在，谁照着写谁掉沟。
 */

describe('端口名册', () => {
  it('7 端口齐备且名册唯一', () => {
    expect(PORT_NAMES).toEqual(['host', 'hook', 'oneshot', 'tooling', 'interactive', 'probe', 'session']);
    expect(new Set(PORT_NAMES).size).toBe(7);
  });

  it('每个端口的 status 是已知取值，且只有工厂/未收口两种', () => {
    for (const p of PORT_CONTRACT) {
      expect(['factory', 'not-landed'], `${p.name}.status`).toContain(p.status);
      expect(p.role, `${p.name}.role`).toBeTruthy();
      expect(p.methods.length, `${p.name}.methods`).toBeGreaterThan(0);
    }
  });
});

describe('契约 ↔ 工厂一致（防漂移核心）', () => {
  const adapters = createCcAdapters({ sessionName: 'cc-r1' });

  it('T1-116：oneshot / tooling 已纳入 createCcAdapters（此前只绑 4 个）', () => {
    expect(Object.keys(adapters).sort()).toEqual(['hook', 'host', 'interactive', 'oneshot', 'probe', 'tooling']);
    expect(typeof adapters.oneshot.runOneShot).toBe('function');
    expect(typeof adapters.oneshot.spawnClaudeP).toBe('function');
    expect(typeof adapters.tooling.install).toBe('function');
    expect(typeof adapters.tooling.claudeAvailable).toBe('function');
  });

  it('契约声明的每个方法，在对应端口对象上都真实存在', () => {
    for (const port of PORT_CONTRACT.filter((p) => p.status === 'factory')) {
      const obj = adapters[port.name];
      expect(obj, `工厂缺端口 ${port.name}`).toBeTruthy();
      for (const m of port.methods) {
        const name = m.replace(/\(.*$/, '').trim();
        const isFn = m.includes('(');
        expect(name in obj, `${port.name}.${name} 声明了但端口对象上没有`).toBe(true);
        if (isFn) expect(typeof obj[name], `${port.name}.${name} 应为方法`).toBe('function');
      }
    }
  });

  it('工厂与 mock 夹具的端口方法集一致（夹具不得自说自话）', () => {
    const mock = createMockAdapters();
    for (const name of Object.keys(adapters)) {
      expect(Object.keys(mock.ports[name]).sort(), `端口 ${name}`).toEqual(Object.keys(adapters[name]).sort());
    }
  });
});

describe('session 未收口：显式登记，不留沉默', () => {
  const session = PORT_CONTRACT.find((p) => p.name === 'session');

  it('标注为 not-landed，并写明原因与责任任务号', () => {
    expect(session.status).toBe('not-landed');
    expect(session.note).toBeTruthy();
    expect(session.responsible).toMatch(/^T\d+-\d+$/);
  });

  it('不绑定在工厂里（未收口就不能假装有）', () => {
    expect(createCcAdapters().session).toBeUndefined();
  });

  it('责任指向 A/D 批次的承接任务 T1-113', () => {
    expect(session.responsible).toBe('T1-113');
  });

  it('契约自检：not-landed 缺 note 或 responsible 即抛错', () => {
    expect(assertPortContract()).toBe(true);
    expect(() => assertPortContract([{ name: 'x', status: 'not-landed', role: 'r', methods: ['a()'] }]))
      .toThrow(/不允许沉默的未收口/);
    expect(() => assertPortContract([{ name: 'x', status: 'not-landed', role: 'r', methods: ['a()'], note: 'n' }]))
      .toThrow(/responsible/);
  });
});

describe('非端口工具（裁决落档）', () => {
  it('cc-shapes 被明确记为「不是端口」，带理由', () => {
    const shapes = NON_PORT_TOOLS.find((t) => t.name === 'cc-shapes');
    expect(shapes).toBeTruthy();
    expect(shapes.reason).toBeTruthy();
    expect(shapes.file).toBe('src/adapters/cc-shapes.cjs');
  });

  it('非端口工具不出现在 7 端口名册里', () => {
    for (const t of NON_PORT_TOOLS) expect(PORT_NAMES).not.toContain(t.name);
  });
});

describe('mock 夹具（7 端口全量）', () => {
  it('createMockAdapters 覆盖 7 端口并记录调用', async () => {
    const mock = createMockAdapters();
    expect(Object.keys(mock.ports)).toEqual(PORT_NAMES);
    mock.ports.host.sendText('hi');
    await mock.ports.oneshot.runOneShot({ prompt: 'p' });
    mock.ports.hook.hook({ hook_event_name: 'Stop' }, { runId: 'r' });
    expect(mock.calls).toEqual([
      ['host.sendText', 'hi'],
      ['oneshot.runOneShot', { prompt: 'p' }],
      ['hook.hook', { hook_event_name: 'Stop' }, { runId: 'r' }],
    ]);
    mock.reset();
    expect(mock.calls).toEqual([]);
  });

  it('canned 默认值可用（host.capture / hook.hook 计数 / oneshot 形状）', async () => {
    const mock = createMockAdapters();
    expect(mock.ports.host.hasSession()).toBe(true);
    expect(mock.ports.host.capture()).toBe('pane');
    expect(mock.ports.hook.hook({}, {})).toBe(1);
    expect((await mock.ports.oneshot.runOneShot({ prompt: 'x' })).ok).toBe(true);
    expect((await mock.ports.oneshot.spawnClaudeP({ prompt: 'x' })).code).toBe(0);
    expect(mock.ports.tooling.claudeAvailable({})).toBe(true);
  });
});
