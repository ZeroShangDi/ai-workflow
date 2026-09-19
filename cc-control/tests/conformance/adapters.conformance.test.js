import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  PORT_NAMES, PORT_CONTRACT, ADAPTER_NAMES, ADAPTER_PLATFORMS,
  REQUIRED_PORT_METHODS, assertRequiredMethods,
  resolveProjectAdapters, resolveAdapterName, createCcAdapters,
} = require('../../server/adapters/ports.cjs');
const { createMockAdapters } = require('../../server/adapters/mock.cjs');
const { createProjectRuntime } = require('../../server/runtime/index.cjs');

/**
 * 适配器一致性（conformance）套件 —— T-P1-05。
 *
 * 立场：**平台专属测试证明「这个平台能跑」，conformance 证明「每个平台都满足同一份契约」**。
 * 这里不写 cc 专属断言；平台清单取自 `ADAPTER_PLATFORMS`，将来 dsh 落地（status 转 factory）
 * 会自动进入本套件的覆盖范围，不需要新写用例。
 *
 * 三层断言（对应执行记录 T-P1-05 的「测试分层 + 契约自检」）：
 *   ① 名册一致 —— 工厂必须返回不多不少的 7 个端口；
 *   ② 必填方法可执行 —— `REQUIRED_PORT_METHODS`（上层真会调的那批）必须是 function，
 *      并对只读/纯函数方法做一次真实调用（存在 ≠ 能用）；
 *   ③ 装配入口一致 —— `resolveProjectAdapters` 与工厂返回同一份端口面。
 */

/** 已落地平台（status=factory）；新增平台只要注册表转正就自动被覆盖 */
const LANDED = ADAPTER_NAMES.filter((n) => ADAPTER_PLATFORMS[n].status === 'factory');

/** 注入的 exec 替身：只认 tmux 的只读子命令；其余一律抛错（避免测试悄悄真跑外部命令） */
function makeExec() {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'tmux') {
      if (args[0] === 'has-session') return '';
      if (args[0] === 'capture-pane') return 'pane-content';
      if (args[0] === 'display-message') return '/proj\n';
      return '';
    }
    if (cmd === 'bash') return '';
    throw new Error(`conformance: 未预期的外部命令 ${cmd}`);
  };
  exec.calls = calls;
  return exec;
}

/** 各平台工厂的装配选项（同一形状；平台内部自行取用需要的字段） */
function makeOpts() {
  return {
    sessionName: 'cc-check',
    bootstrapScriptPath: '/fake/bootstrap.sh',
    execFileSync: makeExec(),
    bus: { emit: () => 0 },
    status: async () => ({ state: 'ready' }),
  };
}

function makeRoot(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-conformance-'));
  if (config) {
    fs.mkdirSync(path.join(root, '.awf'), { recursive: true });
    fs.writeFileSync(path.join(root, '.awf', 'config.json'), JSON.stringify(config));
  }
  return root;
}

beforeEach(() => { process.env.CC_ENTER_DELAY_MS = '0'; });
afterEach(() => { delete process.env.CC_ENTER_DELAY_MS; });

describe('conformance：平台端口面（每个已落地平台跑同一套断言）', () => {
  it('至少有一个已落地平台（否则本套件形同虚设）', () => {
    expect(LANDED.length).toBeGreaterThan(0);
  });

  describe.each(LANDED)('平台 %s', (platform) => {
    const ports = ADAPTER_PLATFORMS[platform].create(makeOpts());

    it('① 名册一致：工厂恰好返回 7 个端口', () => {
      expect(Object.keys(ports).sort()).toEqual([...PORT_NAMES].sort());
    });

    it('② 必填方法都存在且是 function（可执行断言，不是「文档里写了」）', () => {
      for (const [portName, methods] of Object.entries(REQUIRED_PORT_METHODS)) {
        const port = ports[portName];
        expect(port, `缺端口 ${portName}`).toBeTruthy();
        for (const m of methods) {
          expect(typeof port[m], `${platform}.${portName}.${m} 必须是 function`).toBe('function');
        }
      }
    });

    it('② 只读/纯函数方法可真实调用（存在 ≠ 能用）', async () => {
      expect(ports.host.sessionName).toBe('cc-check');
      expect(ports.host.hasSession()).toBe(true);
      expect(typeof ports.host.capture()).toBe('string');
      await expect(ports.host.sendPrompt('hi')).resolves.toBeUndefined();

      expect(ports.session.sessionName).toBe('cc-check');
      expect(ports.session.exists()).toBe(true);
      expect(ports.session.cwd()).toBe('/proj');
      expect(() => ports.session.kill()).not.toThrow();
      expect(() => ports.session.nudge()).not.toThrow();
      expect(ports.session.start({ projectRoot: '/proj', env: {} })).toEqual({ ok: true });

      const probe = ADAPTER_PLATFORMS[platform].impls.probe({
        host: ports.host,
        status: ports.status,
      });
      const snapshot = await probe.inspect();
      expect(snapshot.ok).toBe(true);
      expect(snapshot.session).toBe(true);
      expect(typeof snapshot.capturedAt).toBe('string');

      expect(typeof ports.hook.hook({ hook_event_name: 'PreToolUse' }, {})).toBe('number');
      expect(Array.isArray(ports.oneshot.claudePArgs('p'))).toBe(true);
      expect(typeof ports.tooling.buildMarketplaceAdd('/mp')).toBe('string');
      expect(typeof ports.tooling.buildInstall('spec')).toBe('string');
      expect(typeof ports.tooling.buildUninstall('spec')).toBe('string');
    });

    it('③ 装配入口一致：resolveProjectAdapters 与工厂返回同一份端口面', () => {
      const root = makeRoot({ runtime: { adapter: platform } });
      const resolved = resolveProjectAdapters(root, makeOpts());
      expect(resolved.name).toBe(platform);
      expect(Object.keys(resolved.ports).sort()).toEqual(Object.keys(ports).sort());
      expect(typeof resolved.impls.host).toBe('function'); // 原始实现（需自注入依赖者经此取）
    });
  });
});

describe('conformance：解析入口的失败语义（U6 明确失败）', () => {
  it('缺 config → 缺省 cc', () => {
    expect(resolveAdapterName(makeRoot(null), { env: {} })).toBe('cc');
  });

  it('未知平台 → 抛错（不静默回落）', () => {
    expect(() => resolveAdapterName(makeRoot({ runtime: { adapter: 'nope' } }), { env: {} })).toThrow(/未知平台/);
  });

  it('已登记未落地平台 → 抛错且点名责任任务', () => {
    const notLanded = ADAPTER_NAMES.filter((n) => ADAPTER_PLATFORMS[n].status !== 'factory');
    for (const name of notLanded) {
      const root = makeRoot({ runtime: { adapter: name } });
      expect(() => resolveProjectAdapters(root, { env: {} }))
        .toThrow(new RegExp(ADAPTER_PLATFORMS[name].responsible));
    }
  });

  it('必填方法自检可执行：漏声明即抛错', () => {
    expect(assertRequiredMethods()).toBe(true);
    expect(() => assertRequiredMethods({ host: ['notDeclared'] })).toThrow(/未在 PORT_CONTRACT/);
    expect(() => assertRequiredMethods({ nosuchport: ['x'] })).toThrow(/不存在的端口/);
  });

  it('必填方法面确实是契约方法面的子集（两份声明不漂移）', () => {
    for (const [portName, methods] of Object.entries(REQUIRED_PORT_METHODS)) {
      const port = PORT_CONTRACT.find((p) => p.name === portName);
      expect(port, `契约缺端口 ${portName}`).toBeTruthy();
      expect(port.status).toBe('factory');
      const declared = port.methods.map((m) => m.replace(/\(.*$/, '').trim());
      for (const m of methods) expect(declared).toContain(m);
    }
  });
});

describe('conformance：测试替身与工厂不漂移', () => {
  it('mock 夹具的端口方法集与 cc 工厂逐一相同（夹具不自说自话）', () => {
    const adapters = createCcAdapters({ sessionName: 'cc-check' });
    const mock = createMockAdapters();
    for (const name of Object.keys(adapters)) {
      expect(Object.keys(mock.ports[name]).sort(), `端口 ${name}`).toEqual(Object.keys(adapters[name]).sort());
    }
  });
});

describe('conformance：编排层脱离 CLI 装配（测试分层）', () => {
  it('createProjectRuntime 只注入 hostFactory 即可完成装配，ctx 暴露平台与端口面', () => {
    const root = makeRoot(null);
    const host = makeMockHost();
    const rt = createProjectRuntime({ projectRoot: root, hostFactory: () => host });
    try {
      expect(rt.ctx.host).toBe(host);           // 出口就是注入的替身（编排层不碰真 tmux）
      expect(rt.ctx.adapter).toBe('cc');        // 平台按项目解析
      expect(rt.ctx.adapters.name).toBe('cc');
      expect(typeof rt.ctx.adapters.ports.session.kill).toBe('function');
      expect(rt.session.state).toBe('ready');
    } finally {
      rt.reset();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/** 最小 host 替身（编排层只依赖这几个方法） */
function makeMockHost() {
  return {
    sessionName: 'cc-check',
    hasSession: () => true,
    sendText: () => {},
    sendPrompt: async () => {},
    sendEnter: () => {},
    sendCtrlC: () => {},
    capture: () => '',
  };
}
