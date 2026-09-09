import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// T1-077：awf-state MCP（18 tools 语义保留）底层经 server run api（env CC_AWF_STATE_SERVER=1，
// 带 CC_PORT/AWF_PROJECT_ROOT）；读 GET /awf/state、写 POST /run/state/apply（server 单写者），
// MCP 不再直写文件/自持锁。本测试：真 server + MCP stdio 子进程端到端。

const SERVER_PATH = fileURLToPath(new URL('../../src/server/server.cjs', import.meta.url));
const MCP_PATH = fileURLToPath(new URL('../../plugin/core/mcp/awf-state/server.cjs', import.meta.url));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mcp-server-'));
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

function connectMCP(port) {
  const proc = spawn('node', [MCP_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CC_AWF_STATE_SERVER: '1', CC_PORT: String(port), AWF_PROJECT_ROOT: proj },
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

let server;
let apiPort;
let mcp;

beforeAll(async () => {
  apiPort = await freePort();
  process.env.CC_PROJECT = proj;
  process.env.CC_PORT = String(apiPort);
  process.env.CC_SERVER_IDLE_MS = '0';
  const mod = await import(SERVER_PATH);
  server = mod;
  await server.start(apiPort);
  mcp = connectMCP(apiPort);
  await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  await mcp.call('notifications/initialized', {});
});

afterAll(async () => {
  try { mcp.proc.kill('SIGKILL'); } catch {}
  await server?.stop().catch(() => {});
  delete process.env.CC_PROJECT;
  delete process.env.CC_PORT;
  delete process.env.CC_SERVER_IDLE_MS;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('awf-state MCP → server run api（T1-077）', () => {
  it('awf_read_state 经 server 读；awf_task_status 经 server apply 落盘（语义保留，写收 server）', async () => {
    // 读（经 server GET /awf/state）
    const read = await mcp.call('tools/call', { name: 'awf_read_state', arguments: {} });
    const text = read.content?.[0]?.text;
    expect(text).toBeTruthy();
    expect(JSON.parse(text).tasks[0].id).toBe('T1');

    // 写（经 server POST /run/state/apply）
    const upd = await mcp.call('tools/call', { name: 'awf_task_status', arguments: { id: 'T1', status: 'done' } });
    expect(JSON.parse(upd.content[0].text).ok).toBe(true);

    // 落盘真实反映到 server GET 与文件
    const st = JSON.parse(fs.readFileSync(path.join(proj, '.awf', 'state.json'), 'utf8'));
    expect(st.tasks[0].status).toBe('done');
    expect(st.tasks[0].exec.completedAt).toBeTruthy();

    const viaServer = await (await fetch(`http://127.0.0.1:${apiPort}/awf/state`)).json();
    expect(viaServer.tasks[0].status).toBe('done');
  });
});
