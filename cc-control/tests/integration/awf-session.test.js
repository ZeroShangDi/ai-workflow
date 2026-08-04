import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const SERVER_PATH = fileURLToPath(new URL('../../src/mcp/awf-session/server.cjs', import.meta.url));

// ── mock execSync（capturePane 用；awf-session 为原生 CJS，用注入钩子）──
const mockExecSync = vi.fn(() => 'pane text');

beforeAll(() => {
  global.__CC_EXEC_SYNC__ = mockExecSync;
});

afterAll(() => {
  delete global.__CC_EXEC_SYNC__;
});

// ── mock Session Server：记录请求并按路径返回固定响应 ──
let srv;
let baseUrl;
const requests = [];

function startMockServer() {
  return new Promise((resolve) => {
    srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, body, headers: req.headers });
        const payload = req.url === '/status' ? { ok: true, state: 'ready', session: true } : { ok: true };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

// 找一个无人监听的端口（连接拒绝用）
function deadPort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// 一个永不响应的 server（超时用）
function startSlowServer() {
  return new Promise((resolve) => {
    const s = http.createServer(() => { /* 永不响应 */ });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

// ── env：必须在 import 前设置（模块顶层读取）──
process.env.CC_HTTP_TIMEOUT_MS = '80'; // 加速 httpGet/httpPost 超时
process.env.CC_SESSION = 'cc';

let mod;
beforeAll(async () => {
  await startMockServer();
  mod = await import(SERVER_PATH);
});

afterAll(async () => {
  await new Promise((r) => srv.close(r));
});

beforeEach(() => {
  process.env.AWF_BASE = baseUrl; // 默认指向 mock server
  requests.length = 0;
  mockExecSync.mockReset();
  mockExecSync.mockReturnValue('pane text');
});

describe('awf-session MCP tools', () => {
  it('TC9: awf_session_status 正常（含 pane 500 字符截取）', async () => {
    mockExecSync.mockReturnValue('p'.repeat(600));
    const result = await mod.handlers['tools/call']({ name: 'awf_session_status', arguments: {} });
    const text = result.content[0].text;
    expect(text).toContain('"state": "ready"');
    const pane = text.match(/"pane": "([^"]*)"/)[1];
    expect(pane.length).toBe(500);
    expect(requests[0].url).toBe('/status');
  });

  it('TC10: awf_capture_pane 正常（不经过 HTTP）', async () => {
    mockExecSync.mockReturnValue('完整 pane 文本');
    const result = await mod.handlers['tools/call']({ name: 'awf_capture_pane', arguments: {} });
    expect(result.content[0].text).toContain('完整 pane 文本');
    expect(requests).toHaveLength(0); // 未发任何 HTTP 请求
  });

  it('TC11: awf_await_choice 正常 → POST /choice', async () => {
    const result = await mod.handlers['tools/call']({
      name: 'awf_await_choice',
      arguments: { question: '选择?', options: ['A', 'B'] },
    });
    expect(result.content[0].text).toContain('"ok": true');
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].url).toBe('/choice');
    expect(JSON.parse(requests[0].body)).toEqual({ question: '选择?', options: ['A', 'B'] });
  });

  it('TC12: awf_await_input 正常 → POST /ask', async () => {
    const result = await mod.handlers['tools/call']({
      name: 'awf_await_input',
      arguments: { question: '输入?' },
    });
    expect(result.content[0].text).toContain('"ok": true');
    expect(requests[0].url).toBe('/ask');
    expect(JSON.parse(requests[0].body)).toEqual({ question: '输入?' });
  });

  it('TC13: args 引用 bug 已修复 — awf_await_choice 正确解构 args', async () => {
    // 修复前：tools/call 只解构 name，args 未定义 → ReferenceError → 工具返回 error
    // 修复后：question/options/context 正确传递到 /choice
    const result = await mod.handlers['tools/call']({
      name: 'awf_await_choice',
      arguments: { question: 'Q', options: ['继续', '跳过'], context: 'ctx' },
    });
    expect(result.content[0].text).toContain('"ok": true');
    expect(JSON.parse(requests[0].body)).toEqual({ question: 'Q', options: ['继续', '跳过'], context: 'ctx' });
  });

  it('TC14: args 引用 bug 已修复 — awf_await_input 正确解构 args', async () => {
    const result = await mod.handlers['tools/call']({
      name: 'awf_await_input',
      arguments: { question: '请描述', context: '任务 T9' },
    });
    expect(result.content[0].text).toContain('"ok": true');
    expect(JSON.parse(requests[0].body)).toEqual({ question: '请描述', context: '任务 T9' });
  });

  it('TC20: 未知 tool name → error', async () => {
    const result = await mod.handlers['tools/call']({ name: 'unknown_tool', arguments: {} });
    expect(result.content[0].text).toContain('"ok": false');
    expect(result.content[0].text).toContain('unknown tool: unknown_tool');
  });
});

describe('HTTP helpers', () => {
  it('TC15: httpGet Server 可达 → 解析 JSON', async () => {
    const res = await mod.httpGet('/status');
    expect(res).toEqual({ ok: true, state: 'ready', session: true });
  });

  it('TC16: httpGet 连接拒绝 → {ok:false, error}', async () => {
    const port = await deadPort();
    process.env.AWF_BASE = `http://127.0.0.1:${port}`;
    const res = await mod.httpGet('/status');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('ECONNREFUSED');
  });

  it('TC17: httpGet 超时 → {ok:false, error:timeout}', async () => {
    const slow = await startSlowServer();
    process.env.AWF_BASE = `http://127.0.0.1:${slow.address().port}`;
    const res = await mod.httpGet('/status');
    expect(res).toEqual({ ok: false, error: 'timeout' });
    await new Promise((r) => slow.close(r));
  });

  it('TC18: httpPost 正常（content-type/content-length 正确）', async () => {
    const res = await mod.httpPost('/choice', JSON.stringify({ question: 'Q', options: ['A'] }));
    expect(res).toEqual({ ok: true });
    expect(requests[0].method).toBe('POST');
    expect(requests[0].url).toBe('/choice');
    expect(requests[0].headers['content-type']).toBe('application/json');
    expect(requests[0].headers['content-length']).toBe(String(Buffer.byteLength('{"question":"Q","options":["A"]}')));
  });

  it('TC19: capturePane execSync 异常 → 不抛，返回 (capture failed:)', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('no session'); });
    expect(mod.capturePane()).toBe('(capture failed: no session)');
  });
});

describe('JSON-RPC 协议', () => {
  async function callRpc(msg) {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => {});
    await mod.handleMessage(msg);
    const sent = JSON.parse(spy.mock.calls[0][0]);
    spy.mockRestore();
    return sent;
  }

  it('TC21: initialize', async () => {
    const sent = await callRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(sent.id).toBe(1);
    expect(sent.result.protocolVersion).toBe('2024-11-05');
    expect(sent.result.capabilities).toEqual({ tools: {} });
    expect(sent.result.serverInfo.name).toBe('awf-session-mcp');
  });

  it('TC22: tools/list 返回 4 个 tools', async () => {
    const sent = await callRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = sent.result.tools.map((t) => t.name);
    expect(names).toEqual(['awf_session_status', 'awf_capture_pane', 'awf_await_choice', 'awf_await_input']);
    for (const t of sent.result.tools) {
      expect(t).toHaveProperty('name');
      expect(t).toHaveProperty('description');
      expect(t).toHaveProperty('inputSchema');
    }
  });

  it('TC23: 未知 method → -32601', async () => {
    const sent = await callRpc({ jsonrpc: '2.0', id: 9, method: 'unknown/method', params: {} });
    expect(sent.error.code).toBe(-32601);
    expect(sent.error.message).toBe('method not found: unknown/method');
  });
});
