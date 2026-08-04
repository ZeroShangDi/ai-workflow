import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_PATH = fileURLToPath(new URL('../../src/server/server.cjs', import.meta.url));
const AWF_STATE_MCP_PATH = fileURLToPath(new URL('../../src/mcp/awf-state/server.cjs', import.meta.url));
const FIXTURE_STATE = fileURLToPath(new URL('../fixtures/minimal-state.json', import.meta.url));

// ── mock tmux：只 mock tmux。E2E 用「真实 RunLogger」验证 .awf/logs 输出 ──
const mockTmux = {
  hasSession: vi.fn(() => true),
  sendText: vi.fn(),
  sendEnter: vi.fn(),
  capture: vi.fn(() => ''),
  SESSION: 'cc',
};

// ── 临时项目：用 fixtures 最小 state.json ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-'));
fs.mkdirSync(path.join(TMP, '.awf'), { recursive: true });
fs.copyFileSync(FIXTURE_STATE, path.join(TMP, '.awf', 'state.json'));

// ── env：server.cjs 在 import 时读取（真实 RunLogger 依赖 state.json 的 version）──
process.env.CC_PROJECT = TMP;
process.env.CC_READY_TIMEOUT_MS = '2000';
process.env.CC_ENTER_DELAY_MS = '0';
process.env.CC_LOCAL_CMD_MS = '500';

global.__CC_TMUX__ = mockTmux;
// 注意：不注入 global.__CC_RUNLOGGER__ → server 使用真实 RunLogger

// ── awf-state MCP 子进程客户端（模拟 AI 通过 MCP tools 更新任务状态）──
class MCPClient {
  constructor(serverPath, projectRoot) {
    this.proc = spawn(process.execPath, [serverPath], {
      env: { ...process.env, AWF_PROJECT_ROOT: projectRoot },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.nextId = 1;
    this.buffer = '';
    this.pending = new Map();
    this.proc.stdout.setEncoding('utf-8');
    this.proc.stderr.setEncoding('utf-8');
    this.proc.stdout.on('data', (c) => this._onData(c));
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (this.pending.has(msg.id)) {
        const resolve = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    }
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer;
      timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`JSON-RPC 请求超时: ${method}`));
        }
      }, 5000);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async callTool(name, args) {
    const msg = await this.request('tools/call', { name, arguments: args });
    if (msg.error) throw new Error(JSON.stringify(msg.error));
    return JSON.parse(msg.result.content[0].text);
  }

  close() {
    this.proc.stdin.end();
    this.proc.kill('SIGTERM');
  }
}

// ── server + HTTP helper ──
let server;
let api;
let client;

beforeAll(async () => {
  const mod = await import(SERVER_PATH);
  server = mod;
  const { url } = await server.start(0);
  api = async (method, pathname, body) => {
    const headers = { connection: 'close' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(url + pathname, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text };
  };
  client = new MCPClient(AWF_STATE_MCP_PATH, TMP);
  await client.request('initialize', {});
});

afterAll(async () => {
  client?.close();
  await server?.stop();
  delete global.__CC_TMUX__;
  delete process.env.CC_PROJECT;
  delete process.env.CC_READY_TIMEOUT_MS;
  delete process.env.CC_ENTER_DELAY_MS;
  delete process.env.CC_LOCAL_CMD_MS;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('E2E 冒烟测试 — awf run 完整链路', () => {
  it('SessionStart → /send → MCP 更新 → Stop → FINISH + Run Logger', async () => {
    // 1. SessionStart → ready
    const s0 = await api('POST', '/hook', { event: 'SessionStart' });
    expect(s0.status).toBe(200);
    expect(s0.body.state).toBe('ready');

    // 2. /status 就绪
    const st1 = await api('GET', '/status');
    expect(st1.body.state).toBe('ready');
    expect(st1.body.session).toBe(true);

    // 3. /send 发送任务 prompt → server busy + tmux 收到
    const send = await api('POST', '/send', { text: 'Do something simple' });
    expect(send.status).toBe(200);
    expect(send.body.sent).toBe('Do something simple');
    expect(mockTmux.sendText).toHaveBeenCalledWith('Do something simple');
    expect(mockTmux.sendEnter).toHaveBeenCalled();

    const st2 = await api('GET', '/status');
    expect(st2.body.state).toBe('busy');

    // 4. 模拟 AI 通过 awf-state MCP tools 更新任务状态
    const done = await client.callTool('awf_task_status', { id: 'T1', status: 'done' });
    expect(done.ok).toBe(true);
    await client.callTool('awf_task_result', { id: 'T1', result: 'E2E 冒烟测试通过', files: ['tests/integration/e2e-smoke.test.js'] });
    await client.callTool('awf_phase', { phase: 'FINISH' });

    // 5. Stop hook → ready
    const stop = await api('POST', '/hook', { event: 'Stop' });
    expect(stop.status).toBe(200);
    expect(stop.body.state).toBe('ready');

    // 6. 验证任务完成 + FINISH
    const state = JSON.parse(fs.readFileSync(path.join(TMP, '.awf', 'state.json'), 'utf-8'));
    const task = state.plan.tasks.find((t) => t.id === 'T1');
    expect(task.status).toBe('done');
    expect(task.exec.result).toContain('E2E 冒烟测试通过');
    expect(state.currentState).toBe('FINISH');

    // 7. Run Logger 输出验证
    const logsDir = path.join(TMP, '.awf', 'logs');
    const logFiles = fs.readdirSync(logsDir).filter(f => f.endsWith('.log'));
    expect(logFiles).toHaveLength(1);
    const log = fs.readFileSync(path.join(logsDir, logFiles[0]), 'utf-8');
    expect(log).toContain('=== AWF Run Log ===');
    expect(log).toContain('version: 0.1.0');
    expect(log).toContain('提示词');
    expect(log).toContain('Do something simple');
  });
});
