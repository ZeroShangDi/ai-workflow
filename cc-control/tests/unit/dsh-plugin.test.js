import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridgeClient } from '../../server/adapters/dsh/plugin/lib/bridge-client.js';
import { createTurnReporter } from '../../server/adapters/dsh/plugin/index.js';
import { createOps } from '../../server/adapters/dsh/plugin/lib/ops.js';
import { listSkills } from '../../server/adapters/dsh/plugin/lib/assets.js';

/**
 * AWF 的 DSH 插件 host 半侧（`dsh-plugin/`）—— P2-5a。
 *
 * 用**假 WebSocket + 假 fetch** 验协议行为：先 accepted 再 result、未实现 op 显式失败、
 * 断线重连、事件上报。真实链路（真 DSH 内连真 AWF）由 `scripts/probe/dsh/roundtrip.cjs` 验。
 */

/** 假 WebSocket：测试手动触发 open/message/close */
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    FakeWebSocket.last = this;
    this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
    this.closed = false;
  }
  close() { this.closed = true; }
  // 测试辅助
  emitOpen() { this.onopen?.(); }
  emitMessage(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  emitClose() { this.onclose?.(); }
}

/** 记录所有回传的假 fetch */
function makeFetchRecorder() {
  const posts = [];
  const fetchImpl = vi.fn(async (url, opts) => {
    posts.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200 };
  });
  return { fetchImpl, posts };
}

/** 等到微任务队列清空（handleCommand 是 fire-and-forget） */
const flush = () => new Promise((r) => setTimeout(r, 0));

let posts; let fetchImpl;
beforeEach(() => {
  ({ fetchImpl, posts } = makeFetchRecorder());
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function makeClient(over = {}) {
  const dispatch = vi.fn(async () => ({ ok: true, result: { pong: 1 } }));
  const client = createBridgeClient({
    awfBase: 'http://127.0.0.1:8787',
    pluginVersion: 'test',
    dispatch,
    WebSocketImpl: FakeWebSocket,
    fetchImpl,
    log: () => {},
    ...over,
  });
  return { client, dispatch };
}

describe('插件 host 半侧 — 连接与握手', () => {
  it('缺 awfBase / dispatch → 明确抛错（不半装配启动）', () => {
    expect(() => createBridgeClient({ dispatch: () => {} })).toThrow(/awfBase/);
    expect(() => createBridgeClient({ awfBase: 'http://x' })).toThrow(/dispatch/);
  });

  it('start 连到 AWF 的 WS 端点（http→ws），并把版本带在 query 上', () => {
    const { client } = makeClient();
    client.start();
    expect(FakeWebSocket.last.url).toBe('ws://127.0.0.1:8787/bridge/dsh?pluginVersion=test');
    expect(client.connected()).toBe(false);
    FakeWebSocket.last.emitOpen();
    expect(client.connected()).toBe(true);
  });
});

describe('插件 host 半侧 — 指令处理（先 accepted 再 result）', () => {
  it('收到指令 → 两条回传，commandId 一致，顺序正确', async () => {
    const { client, dispatch } = makeClient();
    client.start();
    FakeWebSocket.last.emitOpen();
    FakeWebSocket.last.emitMessage({ type: 'command', commandId: 'c-1', op: 'session.facts', args: { projectRoot: '/p' } });
    await flush();

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ commandId: 'c-1', op: 'session.facts' }));
    expect(posts.map((p) => p.body.phase)).toEqual(['accepted', 'result']);
    expect(posts.every((p) => p.body.commandId === 'c-1')).toBe(true);
    expect(posts[0].url).toBe('http://127.0.0.1:8787/bridge/dsh/callback');
    expect(posts[1].body).toMatchObject({ ok: true, result: { pong: 1 } });
  });

  it('执行抛错 → result 带 ok:false + 原因（不静默成功）', async () => {
    const { client } = makeClient({ dispatch: async () => { throw new Error('boom'); } });
    client.start();
    FakeWebSocket.last.emitOpen();
    FakeWebSocket.last.emitMessage({ type: 'command', commandId: 'c-2', op: 'session.create' });
    await flush();
    expect(posts[1].body).toMatchObject({ phase: 'result', ok: false, error: 'boom' });
  });

  it('无法识别的帧（非 command / 非法 JSON）被忽略，不影响后续指令', async () => {
    const { client, dispatch } = makeClient();
    client.start();
    FakeWebSocket.last.emitOpen();
    FakeWebSocket.last.onmessage({ data: 'not-json' });
    FakeWebSocket.last.emitMessage({ type: 'event', foo: 1 });
    FakeWebSocket.last.emitMessage({ type: 'command', commandId: 'c-3', op: 'session.nudge' });
    await flush();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(posts.map((p) => p.body.commandId)).toEqual(['c-3', 'c-3']);
  });

  it('回报失败只告警，不抛（回报通道抖动不该打挂插件）', async () => {
    const { client } = makeClient({ fetchImpl: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) });
    client.start();
    FakeWebSocket.last.emitOpen();
    FakeWebSocket.last.emitMessage({ type: 'command', commandId: 'c-4', op: 'session.facts' });
    await expect(flush()).resolves.toBeUndefined();
  });
});

describe('插件 host 半侧 — 重连与上报', () => {
  it('断线后按退避重连（首次约 300ms），重连成功后 connected 恢复', () => {
    vi.useFakeTimers();
    const { client } = makeClient();
    client.start();
    const first = FakeWebSocket.last;
    first.emitOpen();
    expect(client.connected()).toBe(true);

    first.emitClose();
    expect(client.connected()).toBe(false);
    vi.advanceTimersByTime(400); // 300ms + jitter(0-99)
    expect(FakeWebSocket.last).not.toBe(first); // 建了新连接
    FakeWebSocket.last.emitOpen();
    expect(client.connected()).toBe(true);
  });

  it('stop 之后不再重连', () => {
    vi.useFakeTimers();
    const { client } = makeClient();
    client.start();
    const first = FakeWebSocket.last;
    first.emitOpen();
    client.stop();
    expect(first.closed).toBe(true);
    const before = FakeWebSocket.last;
    vi.advanceTimersByTime(5000);
    expect(FakeWebSocket.last).toBe(before);
  });

  it('emitEvent 走同一条回传通道（kind:event + facts）', async () => {
    const { client } = makeClient();
    await client.emitEvent({ type: 'session.started' }, { sessionExists: true });
    expect(posts[0].body).toEqual({ kind: 'event', event: { type: 'session.started' }, facts: { sessionExists: true } });
  });
});

describe('插件 host 半侧 — op 表', () => {
  /** 造一个最小 ctx：只有 sessions 服务 */
  function makeCtx(sessions = []) {
    return { get: (n) => (n === 'sessions' ? { list: () => sessions } : undefined) };
  }

  it('session.facts：按项目根找活会话，ready 反映「有无回合在跑」', async () => {
    const { dispatch, inFlight } = createOps({ ctx: makeCtx([{ header: { id: 's1', cwd: '/proj' } }]) });
    const r = await dispatch({ op: 'session.facts', args: { projectRoot: '/proj' } });
    expect(r.result).toMatchObject({ sessionExists: true, reachable: true, ready: true, cwd: '/proj', sessionId: 's1' });

    inFlight.add('s1'); // 模拟一个回合在跑
    const busy = await dispatch({ op: 'session.facts', args: { projectRoot: '/proj' } });
    expect(busy.result.ready).toBe(false);
  });

  it('session.facts：项目没有会话 → sessionExists:false（不编造就绪）', async () => {
    const { dispatch } = createOps({ ctx: makeCtx([]) });
    const r = await dispatch({ op: 'session.facts', args: { projectRoot: '/nope' } });
    expect(r.result).toMatchObject({ sessionExists: false, ready: false, sessionId: null });
  });

  // 会话身份按**路径**比：同一目录的两种写法（尾斜杠 / 符号链接 / macOS 的 /private 前缀）
  // 不能让「明明建过会话」变成「找不到会话」——真机上 `awf attach` 就这么翻过车。
  it('session.facts：路径同一性（尾斜杠 / 符号链接）都认作同一个项目', async () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-sess-path-'));
    const link = `${real}-link`;
    try {
      fs.symlinkSync(real, link);
      const { dispatch } = createOps({ ctx: makeCtx([{ header: { id: 's1', cwd: real } }]) });
      for (const q of [real, `${real}/`, link]) {
        const r = await dispatch({ op: 'session.facts', args: { projectRoot: q } });
        expect(r.result.sessionId, q).toBe('s1');
        expect(r.result.sessionExists, q).toBe(true);
      }
      const other = await dispatch({ op: 'session.facts', args: { projectRoot: `${real}-other` } });
      expect(other.result.sessionExists).toBe(false);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  // 观看地址随事实一起回：CLI 进程没有 bridge（`awf attach` 只能经 AWF server 的 /probe），
  // 而 DSH 的 web 口只有插件知道 —— 没这个字段，`awf attach` 在 DSH 下就无事可做。
  it('session.facts：回该会话的观看地址（web 口来自 config，缺省 3080）', async () => {
    const { dispatch } = createOps({ ctx: makeCtx([{ header: { id: 's1', cwd: '/proj' } }]), config: { webPort: 39081 } });
    const r = await dispatch({ op: 'session.facts', args: { projectRoot: '/proj' } });
    expect(r.result.url).toBe('http://127.0.0.1:39081/?session=s1');

    const none = await dispatch({ op: 'session.facts', args: { projectRoot: '/nope' } });
    expect(none.result.sessionExists).toBe(false);
    expect(none.result.url).toBe('http://127.0.0.1:39081'); // 无会话 → 回 web 根（不编造会话地址）
  });

  it('session.nudge 是幂等 no-op；session.open 回网页 URL', async () => {
    const { dispatch } = createOps({ ctx: makeCtx([{ header: { id: 's1', cwd: '/proj' } }]), config: { webPort: 39081 } });
    expect(await dispatch({ op: 'session.nudge' })).toEqual({ ok: true, result: { noop: true } });
    const open = await dispatch({ op: 'session.open', args: { projectRoot: '/proj' } });
    expect(open.result.url).toContain('127.0.0.1:39081');
    expect(open.result.sessionId).toBe('s1');
  });

  /** 造一个能跑通 session.create 的假 ctx：agents.create 会在 setup 里挂 MCP，会话工具表立刻可见 */
  function makeCreateCtx({ createImpl } = {}) {
    const calls = [];
    const fakeMcp = { name: 'fake-mcp-client' };
    const agentCtx = { plugin: async (mod, cfg) => { calls.push({ mod, cfg }); } };
    const session = { header: { id: 's-new' }, requestHeader: () => ({ tools: [{ name: 'mcp__awf-state__awf_read_state' }] }) };
    const ctx = {
      get: (n) => {
        if (n === 'agents') {
          return {
            create: async (opts) => {
              if (createImpl) return createImpl(opts);
              await opts.setup(agentCtx);
              return { agent: { session, id: 's-new' } };
            },
          };
        }
        if (n === 'agentPresets') return { mount: async () => {} };
        return undefined;
      },
    };
    return { ctx, calls, fakeMcp };
  }

  it('session.create：在 agent 发布前（setup 里）装模型选择 + 挂 preset + 挂 MCP，再登记为 AWF 会话', async () => {
    const { ctx, calls } = makeCreateCtx();
    const events = [];
    const { dispatch, createdByAwf } = createOps({
      ctx,
      config: { mcpServers: ['awf-state'] },
      loadMcpClient: async () => ({ default: { name: 'fake-mcp-client' } }),
      loadAgent: async () => ({ installModelSelection: () => {} }),
      onEvent: (e) => events.push(e),
    });
    const r = await dispatch({ op: 'session.create', args: { projectRoot: '/proj' } });

    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ sessionId: 's-new', cwd: '/proj', mcp: { mounted: ['awf-state'] } });
    expect(calls[0].cfg).toMatchObject({
      transport: 'stdio',
      serverName: 'awf-state',
      env: { AWF_PROJECT_ROOT: '/proj' },
    });
    // MCP 入口必须是**本包内**的路径（旧实现经 awfRepo 指到 cc 插件树，拷到别处就断）
    const entry = calls[0].cfg.args[0];
    expect(entry.endsWith(path.join('mcp', 'awf-state', 'server.cjs'))).toBe(true);
    expect(fs.existsSync(entry)).toBe(true);
    expect(createdByAwf.has('s-new')).toBe(true);
    expect(events[0]).toMatchObject({ type: 'session.started', sessionId: 's-new' });
  });

  it('session.create：把会话**登记进工作区**（只建工作区不登记 → 网页里掉「未分组」）', async () => {
    const attached = [];
    const agentCtx = { plugin: async () => {} };
    const ctx = {
      get: (n) => {
        if (n === 'agents') return { create: async (o) => { await o.setup(agentCtx); return { agent: { session: { header: { id: 's-ws' } } } }; } };
        if (n === 'agentPresets') return { mount: async () => {} };
        if (n === 'workspaceRegistry') {
          return {
            list: () => [],
            create: async (p, title) => ({ id: 'ws-1', path: p, title, attachSession: async (sid) => { attached.push({ p, sid }); } }),
          };
        }
        return undefined;
      },
    };
    const { dispatch } = createOps({
      ctx,
      config: { mcpServers: [] },
      loadMcpClient: async () => ({ default: {} }),
      loadAgent: async () => ({ installModelSelection: () => {} }),
      loadToolSubagent: async () => ({ name: 'tool-subagent' }),
    });
    const r = await dispatch({ op: 'session.create', args: { projectRoot: '/proj' } });

    expect(r.ok).toBe(true);
    // 关键：建完工作区必须再 attachSession —— 归属靠 workspace.sessionIds，不是靠 cwd 前缀猜
    expect(attached).toHaveLength(1);
    expect(attached[0].sid).toBe('s-ws');
    expect(attached[0].p).toBe('/proj'); // 工作区路径与会话 cwd 用同一个规范化值
    expect(r.result.workspace).toMatchObject({ id: 'ws-1', attached: true });
  });

  it('plugin.* → 明确回「不属于插件侧」（DSH 装配归 CLI 的 T-P2-02，不是「没做完」）', async () => {
    const { dispatch } = createOps({ ctx: { get: () => undefined } });
    const r = await dispatch({ op: 'plugin.install', args: { scope: 'profile' } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不属于插件侧');
    expect(r.error).toContain('T-P2-02');
  });

  it('plan.launch：新建规划会话 + 注入指令 + 回网页 URL（规划会话同样挂 MCP）', async () => {
    const calls = [];
    const agentCtx = { plugin: async () => {} };
    const ctx = {
      get: (n) => {
        if (n === 'agents') {
          return { create: async (opts) => { await opts.setup(agentCtx); return { agent: { session: { header: { id: 's-plan' } }, id: 's-plan' } }; } };
        }
        if (n === 'agentPresets') return { mount: async () => {} };
        if (n === 'sessionController') return { prompt: (req, signal) => { calls.push({ req, signal }); return { accepted: true }; } };
        return undefined;
      },
    };
    const events = [];
    const { dispatch } = createOps({
      ctx,
      config: { mcpServers: ['awf-state'], webPort: 39081 },
      loadMcpClient: async () => ({ default: {} }),
      loadAgent: async () => ({ installModelSelection: () => {} }),
      onEvent: (e) => events.push(e),
    });
    const r = await dispatch({ op: 'plan.launch', args: { cwd: '/proj', prompt: '/ai-workflow-code:w-plan 需求' } });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ sessionId: 's-plan', accepted: true, mcp: { mounted: ['awf-state'] } });
    expect(r.result.url).toBe('http://127.0.0.1:39081/?session=s-plan');
    expect(calls[0].req).toMatchObject({ sessionId: 's-plan', content: [{ type: 'text', text: '/ai-workflow-code:w-plan 需求' }] });
    expect(events[0]).toMatchObject({ type: 'session.started', purpose: 'plan' });
  });

  it('plan.launch：空 prompt / 缺 cwd / 平台不可用 → 显式失败', async () => {
    const { dispatch } = createOps({ ctx: { get: () => undefined } });
    expect((await dispatch({ op: 'plan.launch', args: { cwd: '', prompt: 'x' } })).error).toContain('cwd');
    expect((await dispatch({ op: 'plan.launch', args: { cwd: '/p', prompt: '  ' } })).error).toContain('prompt');
    expect((await dispatch({ op: 'plan.launch', args: { cwd: '/p', prompt: 'x' } })).ok).toBe(false);
  });

  it('session.snapshot：取最后一条 assistant/message 的 text 块（可截断，不编内容）', async () => {
    const session = {
      header: { id: 's1', cwd: '/p' },
      snapshotEvents: () => [
        { type: 'turn/start', seq: 1, data: {} },
        { type: 'assistant/message', seq: 2, time: 1700000000000, data: { turn: 1, message: { content: [{ type: 'text', text: '第一段' }] } } },
        { type: 'turn/end', seq: 3, data: {} },
        { type: 'assistant/message', seq: 4, time: 1700000001000, data: { turn: 2, message: { content: [
          { type: 'text', text: '最后一段' }, { type: 'tool_use', name: 'Bash' },
        ] } } },
      ],
    };
    const { dispatch } = createOps({ ctx: { get: (n) => (n === 'sessions' ? { list: () => [session] } : undefined) } });
    const r = await dispatch({ op: 'session.snapshot', args: { projectRoot: '/p' } });
    expect(r.result).toMatchObject({ text: '最后一段', turn: 2, seq: 4, truncated: false });
    expect(r.result.at).toBe(new Date(1700000001000).toISOString());

    const cut = await dispatch({ op: 'session.snapshot', args: { projectRoot: '/p', maxChars: 2 } });
    expect(cut.result).toMatchObject({ text: '最后', truncated: true });
  });

  it('session.snapshot：还没有助手消息 → text:null + 原因（不编）', async () => {
    const session = { header: { id: 's1', cwd: '/p' }, snapshotEvents: () => [{ type: 'turn/start', seq: 1, data: {} }] };
    const { dispatch } = createOps({ ctx: { get: (n) => (n === 'sessions' ? { list: () => [session] } : undefined) } });
    const r = await dispatch({ op: 'session.snapshot', args: { projectRoot: '/p' } });
    expect(r.result.text).toBeNull();
    expect(r.result.note).toContain('还没有助手消息');
  });

  it('session.tools：报模型可见工具名（header 未折叠时 count=0，不编）', async () => {
    const withTools = createOps({
      ctx: { get: (n) => (n === 'sessions' ? { list: () => [{ header: { id: 's1', cwd: '/p' }, requestHeader: () => ({ tools: [{ name: 'Bash' }, { name: 'mcp__awf-state__awf_read_state' }] }) }] } : undefined) },
    });
    const r = await withTools.dispatch({ op: 'session.tools', args: { projectRoot: '/p' } });
    expect(r.result.count).toBe(2);
    expect(r.result.mcp).toEqual(['mcp__awf-state__awf_read_state']);

    const noHeader = createOps({ ctx: { get: (n) => (n === 'sessions' ? { list: () => [{ header: { id: 's1', cwd: '/p' } }] } : undefined) } });
    expect((await noHeader.dispatch({ op: 'session.tools', args: { projectRoot: '/p' } })).result.count).toBe(0);
  });

  it('session.create：agent 作用域不可用 / agents 服务缺失 / 平台抛错 → 显式失败', async () => {
    // 旧实现靠 awfRepo 定位 MCP 入口，缺了直接失败；现在入口随包，失败面变成「作用域不对」
    const noScope = createOps({
      ctx: { get: (n) => (n === 'agents' ? { create: async (o) => { await o.setup({}); return { agent: { session: { header: { id: 's' } } } }; } } : (n === 'agentPresets' ? { mount: async () => {} } : undefined)) },
      loadMcpClient: async () => ({ default: {} }),
      loadAgent: async () => ({ installModelSelection: () => {} }),
    });
    expect((await noScope.dispatch({ op: 'session.create', args: { projectRoot: '/p' } })).error)
      .toContain('agent 作用域');

    const noAgents = createOps({ ctx: { get: () => undefined } });
    expect((await noAgents.dispatch({ op: 'session.create', args: { projectRoot: '/p' } })).ok).toBe(false);

    const { ctx: boomCtx } = makeCreateCtx({ createImpl: async () => { throw new Error('preset conflict'); } });
    const boom = createOps({ ctx: boomCtx, loadMcpClient: async () => ({ default: {} }), loadAgent: async () => ({ installModelSelection: () => {} }) });
    const r = await boom.dispatch({ op: 'session.create', args: { projectRoot: '/p' } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('preset conflict');
  });

  it('session.create：技能与命名子 Agent 在会话作用域装配，结果如实回报', async () => {
    const skills = [];
    const mounted = [];
    const fakeToolSubagent = { name: 'tool-subagent' };
    const agentCtx = {
      plugin: async (mod, cfg) => { if (mod === fakeToolSubagent) mounted.push(cfg.toolName); },
      get: (n) => (n === 'skills' ? { register: (s) => { skills.push(s.name); return () => {}; } } : undefined),
      effect: () => () => {},
      // 工具面里只有 read/write（含平台内置名映射的结果），白名单核验会据此剔除非存在项
      tools: { restrict: ({ allow }) => { if (allow.includes('read') || allow.includes('write')) return () => {}; throw new Error(`tools.restrict() names unknown global tool "${allow[0]}"`); } },
    };
    const ctx = {
      get: (n) => {
        if (n === 'agents') return { create: async (o) => { await o.setup(agentCtx); return { agent: { session: { header: { id: 's' } } } }; } };
        if (n === 'agentPresets') return { mount: async () => {} };
        return undefined;
      },
    };
    const { dispatch } = createOps({
      ctx,
      config: { mcpServers: [] },
      loadMcpClient: async () => ({ default: {} }),
      loadAgent: async () => ({ installModelSelection: () => {} }),
      loadToolSubagent: async () => fakeToolSubagent,
    });
    const r = await dispatch({ op: 'session.create', args: { projectRoot: '/p' } });

    expect(r.ok).toBe(true);
    expect(r.result.skills.slice().sort()).toEqual(listSkills().skills.map((s) => s.name).sort());
    expect(skills).toContain('awf-plan-norm');
    // 三个 cc 侧 agents/*.md 各自变成一个命名工具（文件名排序决定装配顺序）
    const expected = ['awf_monitor_probe', 'awf_monitor_repair', 'awf_worker'];
    expect(r.result.subagents).toEqual(expected);
    expect(mounted).toEqual(expected);
  });

  it('session.interrupt：调 cancel（平台回执 ≠ 已停，keepInbox=true）', async () => {
    const cancelled = [];
    const ctx = {
      get: (n) => {
        if (n === 'sessions') return { list: () => [{ header: { id: 's1', cwd: '/proj' } }] };
        if (n === 'sessionController') return { cancel: (req) => { cancelled.push(req); return { accepted: true }; } };
        return undefined;
      },
    };
    const { dispatch } = createOps({ ctx });
    const r = await dispatch({ op: 'session.interrupt', args: { projectRoot: '/proj' } });
    expect(cancelled).toEqual([{ sessionId: 's1' }]);
    expect(r.result).toMatchObject({ accepted: true, sessionId: 's1', keepInbox: true });
  });

  it('session.stop：cancel 主会话 + **逐个**打断子 Agent（E-06：取消父会话不停子）', async () => {
    const interrupted = [];
    const ctx = {
      get: (n) => {
        if (n === 'sessions') {
          return { list: () => [
            { header: { id: 's1', cwd: '/proj' } },
            { header: { id: 'c1', cwd: '/proj', parentSessionId: 's1' } },
            { header: { id: 'c2', cwd: '/proj', parentSessionId: 's1' } },
            { header: { id: 'other', cwd: '/other' } },
          ] };
        }
        if (n === 'sessionController') return { cancel: () => ({ accepted: true }) };
        if (n === 'subagents') return { interrupt: (id, authority) => { interrupted.push({ id, authority }); } };
        return undefined;
      },
    };
    const { dispatch } = createOps({ ctx });
    const r = await dispatch({ op: 'session.stop', args: { projectRoot: '/proj' } });
    expect(r.result).toMatchObject({ sessionId: 's1', cancelled: true });
    expect(interrupted.map((i) => i.id)).toEqual(['c1', 'c2']);  // 只打断 s1 的子，不动别人的
  });

  it('session.stop：没有活会话 → 显式失败', async () => {
    const { dispatch } = createOps({ ctx: { get: (n) => (n === 'sessions' ? { list: () => [] } : undefined) } });
    const r = await dispatch({ op: 'session.stop', args: { projectRoot: '/nope' } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('没有活会话');
  });

  it('session.prompt：调 prompt(request, signal)（signal 是第二位置参数，F26），登记在途并上报', async () => {
    const calls = [];
    const ctx = {
      get: (n) => {
        if (n === 'sessions') return { list: () => [{ header: { id: 's1', cwd: '/proj' } }] };
        if (n === 'sessionController') return { prompt: (req, signal) => { calls.push({ req, signal }); return { accepted: true }; } };
        return undefined;
      },
    };
    const events = [];
    const { dispatch, inFlight } = createOps({ ctx, onEvent: (e) => events.push(e) });
    const r = await dispatch({ op: 'session.prompt', args: { projectRoot: '/proj', text: '做 T1' }, commandId: 'cmd-1' });
    expect(r).toEqual({ ok: true, result: { accepted: true, sessionId: 's1' } });
    expect(calls[0].req).toEqual({ sessionId: 's1', content: [{ type: 'text', text: '做 T1' }], requestId: 'cmd-1' });
    expect(calls[0].signal).toBeTruthy();          // 第二位置参数确实传了 signal
    expect(inFlight.has('s1')).toBe(true);
    expect(events[0]).toMatchObject({ type: 'prompt.submitted', sessionId: 's1' });
  });

  it('session.prompt：空文本 / 没有活会话 / 平台抛错 → 显式失败（不静默）', async () => {
    const ctx = {
      get: (n) => {
        if (n === 'sessions') return { list: () => [{ header: { id: 's1', cwd: '/proj' } }] };
        if (n === 'sessionController') return { prompt: async () => { throw new Error('model unavailable'); } };
        return undefined;
      },
    };
    const { dispatch } = createOps({ ctx });
    expect((await dispatch({ op: 'session.prompt', args: { projectRoot: '/proj', text: '   ' } })).ok).toBe(false);
    expect((await dispatch({ op: 'session.prompt', args: { projectRoot: '/nope', text: 'x' } })).error).toContain('没有活会话');
    const boom = await dispatch({ op: 'session.prompt', args: { projectRoot: '/proj', text: 'x' } });
    expect(boom.ok).toBe(false);
    expect(boom.error).toContain('model unavailable');
  });

  it('turn 事件翻译：只报 AWF 会话；turn/end → session.ready 并清在途', () => {
    const createdByAwf = new Set(['s1']);
    const inFlight = new Set();
    const emitted = [];
    const report = createTurnReporter({ createdByAwf, inFlight, emit: (e, f) => emitted.push({ e, f }) });

    report({ header: { id: 's1' } }, { type: 'turn/start' });
    expect(inFlight.has('s1')).toBe(true);

    report({ header: { id: 's1' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
    expect(inFlight.has('s1')).toBe(false);
    expect(emitted.map((x) => x.e.type)).toEqual(['turn.started', 'session.ready']);
    expect(emitted[1].e.reason).toEqual({ kind: 'completed' });
    expect(emitted[1].f).toMatchObject({ ready: true, sessionExists: true, sessionId: 's1' });

    // 非 AWF 会话：一个事件都不产
    report({ header: { id: 'other' } }, { type: 'turn/end' });
    expect(emitted).toHaveLength(2);
    // 无 id 的 session：安全跳过
    report(null, { type: 'turn/end' });
    expect(emitted).toHaveLength(2);
  });

  // 子 Agent：AWF 没建它，但「谁派的、结果是什么」必须回传 —— 多 agent 的落账靠这条（T-P3-01）
  it('子会话（header.parentSession 指向 AWF 会话）：turn/start|end → agent.started|stopped + 末条文本', () => {
    const createdByAwf = new Set(['s-main']);
    const inFlight = new Set();
    const emitted = [];
    const report = createTurnReporter({
      createdByAwf,
      inFlight,
      emit: (e, f) => emitted.push({ e, f }),
      lastText: () => ({ text: 'RESULT: {"taskId":"T1","status":"done"}' }),
    });
    const child = { header: { id: 'c1', cwd: '/proj', parentSession: 's-main' } };

    report(child, { type: 'turn/start' });
    report(child, { type: 'turn/end', data: { reason: { kind: 'completed' } } });

    expect(emitted.map((x) => x.e.type)).toEqual(['agent.started', 'agent.stopped']);
    expect(emitted[0].e).toMatchObject({ agentId: 'c1', parentSessionId: 's-main', cwd: '/proj' });
    expect(emitted[1].e).toMatchObject({
      agentId: 'c1',
      parentSessionId: 's-main',
      lastAssistantMessage: 'RESULT: {"taskId":"T1","status":"done"}',
    });
    // 子会话**不能**动主会话的 busy/ready 与在途集合
    expect(inFlight.size).toBe(0);
    expect(emitted.some((x) => x.e.type === 'session.ready')).toBe(false);

    // 别人的子会话（父不是 AWF 会话）：一个事件都不产
    report({ header: { id: 'c2', parentSession: 's-other' } }, { type: 'turn/end' });
    expect(emitted).toHaveLength(2);

    // 取不到文本也要上报（宁可上报空文本让 AWF 判「无 RESULT」，也不静默丢事件）
    const emitted2 = [];
    const report2 = createTurnReporter({
      createdByAwf,
      inFlight,
      emit: (e) => emitted2.push(e),
      lastText: () => { throw new Error('boom'); },
    });
    report2(child, { type: 'turn/end' });
    expect(emitted2[0]).toMatchObject({ type: 'agent.stopped', lastAssistantMessage: null });
  });

  it('批准请求登记：noteApproval 记录 toolName/reason/是否 AWF 会话（U16 定策略依据）', () => {
    const { noteApproval, approvalRequests } = createOps({ ctx: { get: () => undefined } });
    noteApproval({ toolName: 'Bash', reason: '写入项目外目录' }, { sessionId: 's1', ours: true });
    expect(approvalRequests[0]).toMatchObject({ toolName: 'Bash', sessionId: 's1', ours: true });
    expect(typeof approvalRequests[0].at).toBe('string');
  });

  it('未实现的 op → ok:false 且写明是 P2-5b（显式失败，不冒充成功）', async () => {
    const { dispatch } = createOps({ ctx: makeCtx() });
    const r = await dispatch({ op: 'session.snapshot', args: { projectRoot: '/nope' } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('没有活会话');
  });

  it('llm.oneshot：llm 服务缺失 → 明确失败（不是空文本）', async () => {
    const { dispatch } = createOps({ ctx: makeCtx() });
    const r = await dispatch({ op: 'llm.oneshot', args: { prompt: 'ping' } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('llm 服务不可用');
  });
});
