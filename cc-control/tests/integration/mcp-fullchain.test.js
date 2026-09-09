import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// T1-084：MCP 全链路——主会话经 server 写状态（awf-state）+ await（awf-session /choice、
// context-ready）+ oneshot（awf-oneshot /oneshot）在同一个真 server 上贯通；并核对注册/渲染
// 单测保持绿（render-config.test 等由全量套件承担，本文件聚焦链路）。

const SERVER_PATH = fileURLToPath(new URL('../../src/server/server.cjs', import.meta.url));
const require = createRequire(import.meta.url);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mcp-chain-'));
const proj = path.join(TMP, 'proj');
fs.mkdirSync(path.join(proj, '.awf'), { recursive: true });
fs.writeFileSync(path.join(proj, '.awf', 'state.json'), JSON.stringify({
  mode: 'run', currentState: 'CODE', version: '0.2.0',
  tasks: [{ id: 'T1', kind: 'dev', plannedFiles: ['a.js'], status: 'pending', deps: [] }],
  wbs: [], plan: {},
}, null, 2));

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

function connectMCP(file) {
  const proc = spawn(process.execPath, [file], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  proc.stderr.on('data', () => {});
  let buf = '';
  const pending = new Map();
  let idc = 0;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (c) => {
    buf += c;
    while (buf.includes('\n')) {
      const i = buf.indexOf('\n');
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg.result || msg); pending.delete(msg.id); }
    }
  });
  const call = (method, params) => new Promise((resolve) => {
    const id = ++idc;
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { proc, call };
}

let port;
let server;
let stateMcp;
let awfSession;
let awfOneshot;

beforeAll(async () => {
  port = await freePort();
  // server 用 fake oneshot（避免真 claude spawn）
  global.__CC_ONESHOT__ = { runOneShot: async () => ({ ok: true, text: 'once-ok' }) };
  process.env.CC_PROJECT = proj;
  process.env.CC_PORT = String(port);
  process.env.CC_SERVER_IDLE_MS = '0';
  process.env.AWF_BASE = `http://127.0.0.1:${port}`;
  process.env.CC_SESSION = 'cc';
  process.env.CC_AWF_STATE_SERVER = '1';
  process.env.AWF_PROJECT_ROOT = proj;

  const mod = await import(SERVER_PATH);
  server = mod;
  await server.start(port);

  // awf-state：stdio 子进程（该模块无 handlers 导出）；session/oneshot：本进程导入（导出 handlers）
  const STATE_PATH = fileURLToPath(new URL('../../plugin/core/mcp/awf-state/server.cjs', import.meta.url));
  stateMcp = connectMCP(STATE_PATH);
  await stateMcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  awfSession = require('../../plugin/core/mcp/awf-session/server.cjs');
  awfOneshot = require('../../plugin/core/mcp/awf-oneshot/server.cjs');
});

afterAll(async () => {
  try { stateMcp.proc.kill('SIGKILL'); } catch {}
  delete global.__CC_ONESHOT__;
  delete process.env.CC_PROJECT;
  delete process.env.CC_PORT;
  delete process.env.CC_SERVER_IDLE_MS;
  delete process.env.AWF_BASE;
  delete process.env.CC_SESSION;
  delete process.env.CC_AWF_STATE_SERVER;
  delete process.env.AWF_PROJECT_ROOT;
  await server?.stop().catch(() => {});
  fs.rmSync(TMP, { recursive: true, force: true });
});

const parse = (res) => JSON.parse(res.content[0].text);

describe('MCP 全链路（T1-084）', () => {
  it('主会话写状态 → await_choice → context_ready → oneshot，全部经同一 server', async () => {
    // 1) awf-state（子进程）读（server）→ 标记 done（server apply 落盘）
    const read = parse(await stateMcp.call('tools/call', { name: 'awf_read_state', arguments: {} }));
    expect(read.tasks[0].id).toBe('T1');
    const upd = parse(await stateMcp.call('tools/call', { name: 'awf_task_status', arguments: { id: 'T1', status: 'done' } }));
    expect(upd.ok).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(path.join(proj, '.awf', 'state.json'), 'utf8'));
    expect(onDisk.tasks[0].status).toBe('done');

    // 2) awf-session await_choice → server /choice 置 default 槽 decisionPending
    await awfSession.handlers['tools/call']({ name: 'awf_await_choice', arguments: { question: '选择哪个方案', options: ['A', 'B'] } });
    const st = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
    expect(st.decisionPending?.question).toBe('选择哪个方案');

    // 3) awf-session context_ready → server 置位
    await awfSession.handlers['tools/call']({ name: 'awf_context_ready', arguments: {} });
    expect((await (await fetch(`http://127.0.0.1:${port}/context-ready`)).json()).ready).toBe(true);

    // 4) awf-oneshot → server /oneshot（fake adapter）
    const one = parse(await awfOneshot.handlers['tools/call']({ name: 'awf_oneshot', arguments: { prompt: 'hi' } }));
    expect(one.ok).toBe(true);
    expect(one.text).toBe('once-ok');
  });
});
