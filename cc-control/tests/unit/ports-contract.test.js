import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PORT_CONTRACT, PORT_NAMES, NON_PORT_TOOLS, assertPortContract, createCcAdapters,
  ADAPTER_PLATFORMS, ADAPTER_NAMES, ADAPTER_ENV, assertAdapterRegistry,
  resolveAdapterName, resolveAdapterSource, resolveProjectAdapters,
} from '../../server/adapters/ports.cjs';
import { createMockAdapters } from '../../server/adapters/mock.cjs';

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

  it('T1-116/T-P1-03：7 端口全部纳入 createCcAdapters（含 session）', () => {
    expect(Object.keys(adapters).sort()).toEqual(['hook', 'host', 'interactive', 'oneshot', 'probe', 'session', 'tooling']);
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

describe('session 端口（T-P1-03 收口转正）', () => {
  const session = PORT_CONTRACT.find((p) => p.name === 'session');

  it('status=factory，方法面覆盖启动/探测/停止/接入', () => {
    expect(session.status).toBe('factory');
    expect(session.methods.join(' ')).toMatch(/start\(/);
    expect(session.methods.join(' ')).toMatch(/kill\(/);
    expect(session.methods.join(' ')).toMatch(/cwd\(/);
    expect(session.methods.join(' ')).toMatch(/attach\(/);
  });

  it('已绑定进工厂（未收口时它曾是显式的洞）', () => {
    const port = createCcAdapters({ sessionName: 'cc-r1' }).session;
    expect(port.sessionName).toBe('cc-r1');
    for (const m of ['exists', 'cwd', 'start', 'kill', 'nudge', 'attach']) {
      expect(typeof port[m], `session.${m}`).toBe('function');
    }
  });

  it('session.start 缺 bootstrapScriptPath → 明确失败（不静默起不来）', () => {
    expect(() => createCcAdapters().session.start({ projectRoot: '/tmp' })).toThrow(/bootstrapScriptPath/);
  });

  it('契约自检：not-landed 缺 note 或 responsible 即抛错（机制仍在，供未来未收口端口用）', () => {
    expect(assertPortContract()).toBe(true);
    expect(() => assertPortContract([{ name: 'x', status: 'not-landed', role: 'r', methods: ['a()'] }]))
      .toThrow(/不允许沉默的未收口/);
    expect(() => assertPortContract([{ name: 'x', status: 'not-landed', role: 'r', methods: ['a()'], note: 'n' }]))
      .toThrow(/responsible/);
  });
});

describe('非端口工具（裁决落档）', () => {
  it('shapes 被明确记为「不是端口」，带理由', () => {
    const shapes = NON_PORT_TOOLS.find((t) => t.name === 'shapes');
    expect(shapes).toBeTruthy();
    expect(shapes.reason).toBeTruthy();
    expect(shapes.file).toBe('adapters/cc/shapes.cjs');
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

/** 造一个带 .awf/config.json 的项目根（config 为 null 时不写文件） */
function makeProject(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-adapter-resolve-'));
  if (config) {
    fs.mkdirSync(path.join(root, '.awf'), { recursive: true });
    fs.writeFileSync(path.join(root, '.awf', 'config.json'), JSON.stringify(config));
  }
  return root;
}

describe('按项目解析平台（T-P1-01 / C01）', () => {
  it('缺 .awf/config.json → 缺省 cc（老项目零配置不受影响）', () => {
    expect(resolveAdapterName(makeProject(null), { env: {} })).toBe('cc');
  });

  it('.awf/config.json 的 runtime.adapter 可选中平台；cc 装配出端口句柄', () => {
    const root = makeProject({ runtime: { adapter: 'cc' } });
    expect(resolveAdapterName(root, { env: {} })).toBe('cc');
    const resolved = resolveProjectAdapters(root, { env: {}, sessionName: 'cc-r1' });
    expect(resolved.name).toBe('cc');
    expect(resolved.ports.host.sessionName).toBe('cc-r1');
    expect(typeof resolved.tools.settings.generateRunSettings).toBe('function');
    expect(typeof resolved.tools.profile.installProjectMcp).toBe('function');
    expect(typeof resolved.impls.probe).toBe('function'); // probe 需调用方注入 host+status，故留在 impls
    expect(resolved.checks().map((d) => d.name)).toEqual(['tmux', 'claude', 'node']); // C02：依赖清单也按平台取
  });

  it(`env ${ADAPTER_ENV} 覆盖配置文件`, () => {
    const root = makeProject({ runtime: { adapter: 'cc' } });
    expect(resolveAdapterName(root, { env: { [ADAPTER_ENV]: 'cc' } })).toBe('cc');
  });

  // 「我现在跑在哪个环境」必须能说出**依据**，而不是只报一个名字（诊断/排查的第一问）
  it('平台来源可查：env > config > 缺省', () => {
    expect(resolveAdapterSource(makeProject(null), { env: {} })).toBe('default');
    const root = makeProject({ runtime: { adapter: 'dsh' } });
    expect(resolveAdapterSource(root, { env: {} })).toBe('config');
    expect(resolveAdapterSource(root, { env: { [ADAPTER_ENV]: 'cc' } })).toBe('env');
    // 来源与解析结果一致：config 说 dsh 且无 env → 解析出 dsh
    expect(resolveAdapterName(root, { env: {} })).toBe('dsh');
  });

  it('未知平台名 → 显式抛错（不静默回落 cc）', () => {
    const root = makeProject({ runtime: { adapter: 'nope' } });
    expect(() => resolveAdapterName(root, { env: {} })).toThrow(/未知平台/);
    expect(() => resolveProjectAdapters(root, { env: {} })).toThrow(/未知平台/);
  });

  it('dsh 已落地：解析成功且装配选项（bridge）透传到平台工厂', () => {
    const root = makeProject({ runtime: { adapter: 'dsh' } });
    expect(resolveAdapterName(root, { env: {} })).toBe('dsh');
    const bridge = { connected: () => true, request: async () => ({ delivery: 'accepted', ok: true, result: {} }) };
    const resolved = resolveProjectAdapters(root, { env: {}, bridge });
    expect(resolved.name).toBe('dsh');
    expect(typeof resolved.ports.session.start).toBe('function');
    // DSH 的装配端口是「装进 profile」（参数形状与 cc 不同，CLI 按平台分支调用）
    expect(typeof resolved.tools.profile.installProfile).toBe('function');
    expect(typeof resolved.tools.profile.resolveDshHome).toBe('function');
    // cc 形状的项目资产在 DSH 侧显式抛错（不是 undefined is not a function）
    expect(() => resolved.tools.settings.generateRunSettings()).toThrow(/没有 cc 形状的项目资产工具/);
  });

  it('注册表自检：未落地平台缺 note/responsible 即抛错（机制保留）', () => {
    expect(assertAdapterRegistry()).toBe(true);
    expect(ADAPTER_NAMES).toContain('cc');
    expect(ADAPTER_PLATFORMS.dsh.status).toBe('factory');
    expect(() => assertAdapterRegistry({ x: { status: 'not-landed' } })).toThrow(/note \+ responsible/);
    expect(() => assertAdapterRegistry({ x: { status: 'factory' } })).toThrow(/没有 create/);
  });
});
