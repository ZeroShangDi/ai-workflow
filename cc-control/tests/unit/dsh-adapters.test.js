import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDshAdapters, checkPrerequisites, DSH_EVENT_MAP } = require('../../server/adapters/dsh/index.cjs');
const { PORT_NAMES } = require('../../server/adapters/ports.cjs');

/**
 * DSH 平台适配器（AWF 侧）—— P2-4。
 *
 * 立场：这层只做「把端口方法翻译成指令」，**不做调度判断**。所以断言分三类：
 *   ① 端口面恰好 7 个（契约自检的可执行版本）；
 *   ② 每个方法发给平台的 op/args 正确；
 *   ③ 三种送达结论与平台错误的**语义不被吞掉**（未交给/无法确认/被拒绝都要抛出来）。
 *
 * ⚠️ 本文件是**替身测试**，不是「DSH 可用」的证据 —— 真实链路见 P2-5（隔离探针实测）。
 */

/** 可控假通道：记录指令，按 answer 决定回什么送达结论 */
function makeFakeBridge({ connected = true, answer } = {}) {
  const calls = [];
  const handlers = new Set();
  let facts = { sessionExists: true, reachable: true, ready: true, cwd: '/proj', snapshot: 'pane-text' };
  const bridge = {
    connected: () => connected,
    lastFacts: () => ({ ...facts }),
    noteFacts: (patch) => { facts = { ...facts, ...patch }; return { ...facts }; },
    onEvent: (h) => { handlers.add(h); return () => handlers.delete(h); },
    pendingCount: () => 0,
    detachedReason: () => null,
    async request(op, args, opts = {}) {
      calls.push({ op, args, opts });
      const r = answer ? answer(op, args, opts) : { ok: true, result: {} };
      return { commandId: 'c-1', op, ...r };
    },
    emitEvent(e) { for (const h of handlers) h(e); },
  };
  return { bridge, calls };
}

describe('dsh 适配器 — 端口面', () => {
  it('工厂恰好返回 7 个端口（与名册同集）', () => {
    const { bridge } = makeFakeBridge();
    const ports = createDshAdapters({ bridge });
    expect(Object.keys(ports).sort()).toEqual([...PORT_NAMES].sort());
  });

  it('未注入 bridge → 端口仍可构造，但真发指令得到「未交给平台」（CLI 侧只需工具面）', async () => {
    const ports = createDshAdapters({});
    expect(Object.keys(ports).sort()).toEqual([...PORT_NAMES].sort());
    expect(ports.session.exists()).toBe(false);
    const r = await ports.session.start({ projectRoot: '/p' }).catch((e) => ({ error: e.message }));
    expect(String(r.error)).toMatch(/未交给平台|未连接/);
  });
});

describe('dsh 适配器 — 三种送达结论不被吞掉', () => {
  const cases = [
    [{ delivery: 'not-delivered', error: '未连接' }, /未交给平台/],
    [{ delivery: 'unconfirmed', error: '没回执' }, /无法确认/],
    [{ delivery: 'accepted', ok: false, error: '平台拒绝' }, /平台拒绝/],
  ];

  for (const [answer, pattern] of cases) {
    it(`${answer.delivery}${answer.ok === false ? '/ok:false' : ''} → start() 抛错并带上原因`, async () => {
      const { bridge } = makeFakeBridge({ answer: () => answer });
      const ports = createDshAdapters({ bridge });
      await expect(ports.session.start({ projectRoot: '/proj' })).rejects.toThrow(pattern);
    });
  }

  it('accepted + ok → 返回结果，并刷新「会话存在」事实', async () => {
    const { bridge, calls } = makeFakeBridge({ answer: () => ({ delivery: 'accepted', ok: true, result: { sessionId: 's-1' } }) });
    const ports = createDshAdapters({ bridge });
    await expect(ports.session.start({ projectRoot: '/proj' })).resolves.toEqual({ ok: true, sessionId: 's-1' });
    expect(calls[0]).toMatchObject({ op: 'session.create', args: { projectRoot: '/proj' }, opts: { projectRoot: '/proj' } });
    expect(bridge.lastFacts().sessionExists).toBe(true);
  });
});

describe('dsh 适配器 — 端口 → 指令映射', () => {
  const okBridge = () => makeFakeBridge({ answer: () => ({ delivery: 'accepted', ok: true, result: {} }) });

  it('host：sendPrompt/sendText/sendEnter/sendCtrlC 各发对应 op', async () => {
    const { bridge, calls } = okBridge();
    const { host } = createDshAdapters({ bridge });
    await host.sendPrompt('做 T1');
    await host.sendText('raw');
    await host.sendEnter();
    await host.sendCtrlC();
    expect(calls.map((c) => c.op)).toEqual(['session.prompt', 'session.inject', 'session.enter', 'session.interrupt']);
    expect(calls[0].args).toEqual({ text: '做 T1' });
  });

  it('host：hasSession/capture 用「最近已知事实」（同步 API 的诚实口径）', () => {
    const { bridge } = makeFakeBridge();
    const { host } = createDshAdapters({ bridge });
    expect(host.hasSession()).toBe(true);
    expect(host.capture()).toBe('pane-text');
    // 事实未知时不装成功
    bridge.noteFacts({ sessionExists: false });
    expect(host.hasSession()).toBe(false);
  });

  it('session：kill 发 session.stop、把事实置为不存在，并**回传**停止回执（含逐个打断的子 Agent）', async () => {
    const stopRecord = { sessionId: 's-1', cancelled: true, subagents: ['child-1'], subagentsSeen: ['child-1'], errors: [] };
    const { bridge, calls } = makeFakeBridge({ answer: () => ({ delivery: 'accepted', ok: true, result: stopRecord }) });
    const { session } = createDshAdapters({ bridge });
    // U11：调用方要能验证子 Agent 真被打断 —— 回执不能吞掉（吞掉就只剩「看起来停了」）
    await expect(session.kill()).resolves.toEqual(stopRecord);
    expect(calls[0].op).toBe('session.stop');
    expect(bridge.lastFacts().sessionExists).toBe(false);
  });

  it('session：attach 是网页形态（返回 url），不是终端', async () => {
    const { bridge } = makeFakeBridge({ answer: () => ({ delivery: 'accepted', ok: true, result: { url: 'http://127.0.0.1:3080/s/1' } }) });
    const { session } = createDshAdapters({ bridge });
    await expect(session.attach()).resolves.toMatchObject({ ok: true, url: 'http://127.0.0.1:3080/s/1' });
  });

  it('oneshot：runOneShot 把 timeoutMs 透传给平台（隔离调用的超时语义）', async () => {
    const { bridge, calls } = makeFakeBridge({ answer: () => ({ delivery: 'accepted', ok: true, result: { text: 'PONG' } }) });
    const { oneshot } = createDshAdapters({ bridge });
    await expect(oneshot.runOneShot({ prompt: 'ping', cwd: '/p', timeoutMs: 1000 })).resolves.toEqual({ ok: true, text: 'PONG' });
    expect(calls[0]).toMatchObject({ op: 'llm.oneshot', args: { prompt: 'ping', timeoutMs: 1000 } });
  });

  it('tooling：install/uninstall 走平台装配指令', async () => {
    const { bridge, calls } = okBridge();
    const { tooling } = createDshAdapters({ bridge });
    await tooling.install({ scope: 'profile' });
    await tooling.uninstall({ scope: 'profile' });
    expect(calls.map((c) => c.op)).toEqual(['plugin.install', 'plugin.uninstall']);
  });

  it('interactive：launchDialog 走「新建规划会话 + 注入指令」', async () => {
    const { bridge, calls } = makeBridgeWith({ url: 'http://127.0.0.1:3080/s/2' });
    const { interactive } = createDshAdapters({ bridge });
    const r = await interactive.launchDialog({ cwd: '/p', prompt: '/ai-workflow-code:w-plan 需求' });
    expect(calls[0]).toMatchObject({ op: 'plan.launch', args: { cwd: '/p', prompt: '/ai-workflow-code:w-plan 需求' } });
    expect(r.url).toBe('http://127.0.0.1:3080/s/2');
  });
});

/** 小工具：只关心 result 的假通道 */
function makeBridgeWith(result) {
  return makeFakeBridge({ answer: () => ({ delivery: 'accepted', ok: true, result }) });
}

describe('dsh 适配器 — cc 机制方法显式不支持（不静默降级）', () => {
  const { bridge } = makeFakeBridge();
  const ports = createDshAdapters({ bridge });

  for (const [port, method] of [
    ['oneshot', 'spawnClaudeP'], ['oneshot', 'claudePArgs'],
    ['tooling', 'claudeAvailable'], ['tooling', 'buildMarketplaceAdd'],
    ['tooling', 'buildInstall'], ['tooling', 'buildUninstall'],
  ]) {
    it(`${port}.${method} 抛错并说明是 cc 机制方法`, () => {
      expect(() => ports[port][method]()).toThrow(/cc 机制方法/);
    });
  }
});

describe('dsh 适配器 — probe 侦查（无失败态，未知用 state 表达）', () => {
  const cases = [
    [{ delivery: 'accepted', ok: true, result: { sessionExists: true, ready: true } }, 'ready'],
    [{ delivery: 'accepted', ok: true, result: { sessionExists: true, ready: false } }, 'busy'],
    [{ delivery: 'accepted', ok: true, result: { sessionExists: false } }, 'absent'],
    [{ delivery: 'unconfirmed', error: 'no ack' }, 'unknown'],
  ];

  for (const [answer, state] of cases) {
    it(`facts=${JSON.stringify(answer).slice(0, 48)} → state=${state}`, async () => {
      const { bridge } = makeFakeBridge({ answer: () => answer });
      const { probe } = createDshAdapters({ bridge });
      const r = await probe.inspect();
      expect(r.ok).toBe(true);          // 侦查本身没有失败态
      expect(r.state).toBe(state);
      expect(typeof r.capturedAt).toBe('string');
    });
  }

  it('断链时 state=unknown 且不抛', async () => {
    const { bridge } = makeFakeBridge({ connected: false });
    const { probe } = createDshAdapters({ bridge });
    await expect(probe.inspect()).resolves.toMatchObject({ ok: true, state: 'unknown' });
  });

  // CLI 进程没有 bridge → `awf attach` 只能经 server 的 /probe 拿「观看地址」；
  // 地址只有平台知道（DSH 的 web 口在 profile patch 的 config 里），所以随事实一起透出。
  it('有会话且平台给了观看地址 → 侦查结果带上 url（跨进程 attach 的唯一事实源）', async () => {
    const { bridge } = makeFakeBridge({ answer: () => ({ delivery: 'accepted', ok: true, result: { sessionExists: true, ready: true, url: 'http://127.0.0.1:3081/?session=s-1' } }) });
    const { probe } = createDshAdapters({ bridge });
    await expect(probe.inspect()).resolves.toMatchObject({ state: 'ready', url: 'http://127.0.0.1:3081/?session=s-1' });
  });

  it('平台没给地址（旧插件/无会话）→ 结果里就没有 url，不编一个', async () => {
    const { bridge } = makeFakeBridge({ answer: () => ({ delivery: 'accepted', ok: true, result: { sessionExists: true, ready: true } }) });
    const { probe } = createDshAdapters({ bridge });
    const r = await probe.inspect();
    expect('url' in r).toBe(false);
  });
});

describe('dsh 适配器 — 平台事件 → 领域事件', () => {
  function makePorts() {
    const emitted = [];
    const { bridge } = makeFakeBridge();
    const ports = createDshAdapters({ bridge, bus: { emit: (e) => emitted.push(e) } });
    return { ports, emitted, bridge };
  }

  it('session.started → run.started；prompt.submitted → run.phase(BUSY)', () => {
    const { ports, emitted } = makePorts();
    expect(ports.hook.hook({ type: 'session.started' }, { runId: 'r1' })).toBe(1);
    expect(ports.hook.hook({ type: 'prompt.submitted' }, { runId: 'r1' })).toBe(1);
    expect(emitted.map((e) => e.type)).toEqual(['run.started', 'run.phase']);
    expect(emitted[0].runId).toBe('r1');
    expect(emitted[1].payload.phase).toBe('BUSY');
  });

  it('agent.stopped 带 agentId/taskId', () => {
    const { ports, emitted } = makePorts();
    ports.hook.hook({ type: 'agent.stopped', agentId: 'a1', taskId: 'T1' }, {});
    expect(emitted[0]).toMatchObject({ type: 'agent.stopped', payload: { agentId: 'a1', taskId: 'T1' } });
  });

  it('session.ready → run.phase(READY)（回合结束 = 会话回到可派发）且刷 ready 事实', () => {
    const { ports, emitted, bridge } = makePorts();
    expect(ports.hook.hook({ type: 'session.ready' }, {})).toBe(1);
    expect(emitted.map((e) => e.type)).toEqual(['run.phase']);
    expect(emitted[0].payload.phase).toBe('READY');
    expect(bridge.lastFacts().ready).toBe(true);
  });

  it('未知事件 / 非法载荷 → 0 条，不抛', () => {
    const { ports, emitted } = makePorts();
    expect(ports.hook.hook({ type: 'wat' }, {})).toBe(0);
    expect(ports.hook.hook(null, {})).toBe(0);
    expect(emitted).toEqual([]);
  });

  it('事件映射表覆盖的平台事件都有对应领域事件或明确的 null', () => {
    for (const [type, mapper] of Object.entries(DSH_EVENT_MAP)) {
      const ev = mapper({ agentId: 'a', taskId: 't' });
      expect(ev === null || typeof ev.type === 'string', `${type} 映射失形`).toBe(true);
    }
  });
});

describe('dsh 适配器 — 依赖检查（C02：不要求装 CC）', () => {
  it('只查 dsh 与 node，不查 claude', () => {
    const names = checkPrerequisites({ execSync: () => {} }).map((d) => d.name);
    expect(names).toEqual(['dsh', 'node']);
    expect(names).not.toContain('claude');
  });

  it('命令缺失 → ok:false 且给安装提示', () => {
    const execSync = vi.fn((cmd) => { if (String(cmd).includes('dsh')) throw new Error('not found'); });
    const deps = checkPrerequisites({ execSync });
    expect(deps.find((d) => d.name === 'dsh').ok).toBe(false);
    expect(deps.find((d) => d.name === 'dsh').hint).toContain('DeepSeek Harness');
  });
});
