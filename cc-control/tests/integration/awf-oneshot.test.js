import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const SERVER_PATH = fileURLToPath(new URL('../../src/mcp/awf-oneshot/server.cjs', import.meta.url));

// ── mock spawn（awf-oneshot 为原生 CJS，用注入钩子）──
const mockSpawn = vi.fn((cmd, args, options) => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  mockSpawn.calls.push({ cmd, args, options });
  // 监听器已在 spawnClaude 内同步挂好，setImmediate 后再触发事件
  setImmediate(() => {
    const b = mockSpawn.behavior;
    if (b.stdout) proc.stdout.emit('data', b.stdout);
    if (b.error) proc.emit('error', b.error);
    else if (b.closeCode !== undefined) proc.emit('close', b.closeCode);
  });
  return proc;
});
mockSpawn.calls = [];
mockSpawn.behavior = { stdout: 'Hello World\n', closeCode: 0 };

beforeAll(() => {
  global.__CC_SPAWN__ = mockSpawn;
});

afterAll(() => {
  delete global.__CC_SPAWN__;
});

beforeEach(() => {
  mockSpawn.calls = [];
  mockSpawn.behavior = { stdout: 'Hello World\n', closeCode: 0 };
});

let mod;
beforeAll(async () => {
  mod = await import(SERVER_PATH);
});

// 调用 awf_oneshot 并解析 textResult
async function callOneshot(args) {
  const result = await mod.handlers['tools/call']({ name: 'awf_oneshot', arguments: args });
  return JSON.parse(result.content[0].text);
}

describe('MCP 协议', () => {
  async function callRpc(msg) {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => {});
    await mod.handleMessage(msg);
    const sent = JSON.parse(spy.mock.calls[0][0]);
    spy.mockRestore();
    return sent;
  }

  it('TC1: initialize 握手', async () => {
    const sent = await callRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(sent.result.protocolVersion).toBe('2024-11-05');
    expect(sent.result.capabilities).toEqual({ tools: {} });
    expect(sent.result.serverInfo.name).toBe('awf-oneshot-mcp');
  });

  it('TC2: tools/list 返回 1 个 tool（awf_oneshot）', async () => {
    const sent = await callRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(sent.result.tools).toHaveLength(1);
    const tool = sent.result.tools[0];
    expect(tool.name).toBe('awf_oneshot');
    expect(tool.inputSchema.required).toEqual(['prompt']);
    expect(tool.inputSchema.properties).toHaveProperty('prompt');
    expect(tool.inputSchema.properties).toHaveProperty('cwd');
  });
});

describe('awf_oneshot 执行', () => {
  it('TC3: 正常执行 → ok + stdout（trim）', async () => {
    mockSpawn.behavior = { stdout: 'Hello World\n', closeCode: 0 };
    const res = await callOneshot({ prompt: 'say hello' });
    expect(res).toEqual({ ok: true, text: 'Hello World' });
    expect(mockSpawn.calls[0].cmd).toBe('claude');
    expect(mockSpawn.calls[0].args).toEqual(['-p', 'say hello']);
  });

  it('TC4: 指定 cwd 参数（不传则用 process.cwd()）', async () => {
    await callOneshot({ prompt: 'ls', cwd: '/tmp' });
    expect(mockSpawn.calls[0].options.cwd).toBe('/tmp');

    await callOneshot({ prompt: 'ls' });
    expect(mockSpawn.calls[1].options.cwd).toBe(process.cwd());
  });

  it('TC5: 非零退出码 → ok=false（resolve 而非 reject）', async () => {
    mockSpawn.behavior = { stdout: 'Error: something\n', closeCode: 1 };
    const res = await callOneshot({ prompt: 'bad command' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('claude -p exited 1');
    expect(res.text).toBe('Error: something');
  });

  it('TC6: error 事件（claude 未安装 ENOENT）→ ok=false', async () => {
    mockSpawn.behavior = { error: new Error('spawn claude ENOENT') };
    const res = await callOneshot({ prompt: 'test' });
    expect(res).toEqual({ ok: false, error: 'spawn claude ENOENT' });
  });

  it('TC7: 5 分钟超时 → timeout=300000，SIGTERM close code≠0', async () => {
    expect(mockSpawn.calls).toHaveLength(0);
    mockSpawn.behavior = { stdout: '', closeCode: null }; // 超时被 SIGTERM 后 close(code=null)
    const res = await callOneshot({ prompt: 'long task' });
    expect(mockSpawn.calls[0].options.timeout).toBe(300000);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('claude -p exited null');
  });
});

describe('边界', () => {
  it('TC8: 空 prompt → 参数校验失败，不 spawn', async () => {
    const res = await callOneshot({});
    expect(res.ok).toBe(false);
    expect(res.error).toBe('prompt is required');
    expect(mockSpawn.calls).toHaveLength(0);
  });

  it('TC9: env 包含 NO_COLOR=1 且继承 process.env', async () => {
    process.env.CC_TEST_MARKER = 'marker-value';
    await callOneshot({ prompt: 'hi' });
    const env = mockSpawn.calls[0].options.env;
    expect(env.NO_COLOR).toBe('1');
    expect(env.CC_TEST_MARKER).toBe('marker-value');
    delete process.env.CC_TEST_MARKER;
  });

  it('TC10: 未知 tool name → error', async () => {
    const result = await mod.handlers['tools/call']({ name: 'unknown_tool', arguments: {} });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: false, error: 'unknown tool: unknown_tool' });
  });

  it('TC11: spawnClaude 参数验证（cmd/args/stdio/timeout/env）', async () => {
    const p = mod.spawnClaude('test prompt', '/custom/cwd');
    const call = mockSpawn.calls[0];
    expect(call.cmd).toBe('claude');
    expect(call.args).toEqual(['-p', 'test prompt']);
    expect(call.options.cwd).toBe('/custom/cwd');
    expect(call.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(call.options.timeout).toBe(300000);
    expect(call.options.env.NO_COLOR).toBe('1');
    await p; // 等待 mock close 事件，避免悬空 promise
  });
});
