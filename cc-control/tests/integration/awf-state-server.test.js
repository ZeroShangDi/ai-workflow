import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

// T1-077：awf-state MCP 底层经 server run api（env CC_AWF_STATE_SERVER=1，
// 带 CC_PORT/AWF_PROJECT_ROOT）；读 GET /awf/state、写 POST /run/state/apply（server 单写者），
// MCP 不再直写文件/自持锁。本测试：真 server + MCP stdio 子进程端到端。

const SERVER_PATH = fileURLToPath(new URL('../../src/server/server.cjs', import.meta.url));
const MCP_PATH = fileURLToPath(new URL('../../plugin/core/mcp/awf-state/server.cjs', import.meta.url));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mcp-server-'));
const proj = path.join(TMP, 'proj');
fs.mkdirSync(path.join(proj, '.awf'), { recursive: true });
fs.writeFileSync(path.join(proj, '.awf', 'state.json'), JSON.stringify({
  mode: 'run', currentState: 'CODE', version: '0.2.0',
  tasks: [
    { id: 'T1', kind: 'dev', plannedFiles: ['a.js'], status: 'pending', deps: [] },
    { id: 'T2', kind: 'dev', plannedFiles: ['b.js'], status: 'pending', deps: [] },
  ],
  wbs: [], plan: {},
}, null, 2));
fs.writeFileSync(path.join(proj, '.awf', 'config.json'), JSON.stringify({
  run: { dynamicPlanning: { mode: 'auto_then_review', extensions: { reviewAdapter: 'future-ui' } } },
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

  it('失败的 MCP mutation 不回写旧快照；stale apply 被 CAS 拒绝', async () => {
    const statePath = path.join(proj, '.awf', 'state.json');
    const beforeFailureRaw = fs.readFileSync(statePath, 'utf8');

    const invalid = await mcp.call('tools/call', {
      name: 'awf_task_update',
      arguments: { id: 'T1', deps: ['MISSING'] },
    });
    expect(JSON.parse(invalid.content[0].text).ok).toBe(false);
    expect(fs.readFileSync(statePath, 'utf8')).toBe(beforeFailureRaw);

    const current = JSON.parse(beforeFailureRaw);
    const staleApply = await fetch(
      `http://127.0.0.1:${apiPort}/run/state/apply?p=${encodeURIComponent(proj)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          state: { ...current, mode: 'run' },
          expectedLastUpdated: '2000-01-01T00:00:00.000Z',
          expectedStateFingerprint: crypto.createHash('sha256')
            .update(JSON.stringify(current))
            .digest('hex'),
        }),
      },
    );
    const staleBody = await staleApply.json();
    expect(staleApply.status, JSON.stringify(staleBody)).toBe(409);
    expect(staleBody).toMatchObject({ ok: false, conflict: true });
    expect(fs.readFileSync(statePath, 'utf8')).toBe(beforeFailureRaw);
  });

  it('awf_dynamic_plan 仅作薄入口，server 自动处理位置、副作用与复审记录', async () => {
    const result = await mcp.call('tools/call', {
      name: 'awf_dynamic_plan',
      arguments: {
        reason: 'T2 缺少模块对接任务，补齐既定模块化目标',
        operations: [{
          type: 'insert_task',
          relation: { type: 'prerequisite_for', targetTaskId: 'T2' },
          task: {
            id: 'T2-I', title: '模块对接', prompt: '完成模块装配，不得回退单文件',
            acceptance: 'T2 通过对接层消费模块能力', plannedFiles: ['src/integration.js'],
          },
        }],
      },
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.applied).toBe(true);
    expect(payload.proposal.status).toBe('applied_review_pending');
    expect(payload.proposal.extensionContext).toEqual({ reviewAdapter: 'future-ui' });

    const state = JSON.parse(fs.readFileSync(path.join(proj, '.awf', 'state.json'), 'utf8'));
    expect(state.tasks.map((task) => task.id)).toEqual(['T1', 'T2-I', 'T2']);
    expect(state.tasks.find((task) => task.id === 'T2').deps).toContain('T2-I');

    const status = await mcp.call('tools/call', {
      name: 'awf_dynamic_plan_status',
      arguments: { proposalId: payload.proposal.proposalId },
    });
    const statusPayload = JSON.parse(status.content[0].text);
    expect(statusPayload.proposal.status).toBe('applied_review_pending');
    expect(statusPayload.proposal.proposedState).toBeUndefined();

    const bypass = await mcp.call('tools/call', {
      name: 'awf_task_create',
      arguments: { id: 'BYPASS', title: '旁路', prompt: '不应创建' },
    });
    expect(JSON.parse(bypass.content[0].text).error).toContain('use awf_dynamic_plan');
  });

  it('approve_then_apply 模式先保留 proposal，人工批准端点调用后才落盘', async () => {
    fs.writeFileSync(path.join(proj, '.awf', 'config.json'), JSON.stringify({
      run: { dynamicPlanning: { mode: 'approve_then_apply' } },
    }, null, 2));
    const result = await mcp.call('tools/call', {
      name: 'awf_dynamic_plan',
      arguments: {
        reason: '再补一层适配任务，验证人工批准模式',
        operations: [{
          type: 'insert_task',
          relation: { type: 'prerequisite_for', targetTaskId: 'T2' },
          task: {
            id: 'T2-I2', title: '二级适配', prompt: '补二级适配',
            acceptance: '适配关系可验证',
          },
        }],
      },
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.applied).toBe(false);
    expect(payload.proposal.status).toBe('awaiting_approval');
    expect(JSON.parse(fs.readFileSync(path.join(proj, '.awf', 'state.json'), 'utf8')).tasks
      .some((task) => task.id === 'T2-I2')).toBe(false);

    const approved = await fetch(
      `http://127.0.0.1:${apiPort}/run/dynamic-planning/proposals/${payload.proposal.proposalId}/approve?p=${encodeURIComponent(proj)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewer: 'human-test', note: '批准' }),
      },
    );
    expect(approved.status).toBe(200);
    expect((await approved.json()).proposal.status).toBe('applied');
    expect(JSON.parse(fs.readFileSync(path.join(proj, '.awf', 'state.json'), 'utf8')).tasks
      .some((task) => task.id === 'T2-I2')).toBe(true);
  });

  it('高风险 proposal 自动建立正式 decision，只有人工 resolve 才能应用', async () => {
    const result = await mcp.call('tools/call', {
      name: 'awf_dynamic_plan',
      arguments: {
        reason: '删除二级适配会改变既定结构，需要正式决策',
        operations: [{ type: 'delete_task', taskId: 'T2-I2' }],
      },
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.proposal.status).toBe('decision_required');
    const decisionId = payload.proposal.decision.decisionId;

    const decisions = await (await fetch(
      `http://127.0.0.1:${apiPort}/awf/decisions?p=${encodeURIComponent(proj)}`,
    )).json();
    expect(decisions.decisions.some((entry) => (
      entry.event === 'decision_requested'
      && entry.decision_id === decisionId
      && entry.subject?.proposal_id === payload.proposal.proposalId
    ))).toBe(true);

    const bypass = await fetch(
      `http://127.0.0.1:${apiPort}/run/dynamic-planning/proposals/${payload.proposal.proposalId}/approve?p=${encodeURIComponent(proj)}`,
      {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewer: 'human-test' }),
      },
    );
    expect(bypass.status).toBe(409);
    expect((await bypass.json()).error).toContain('resolve the decision');

    const resolved = await fetch(
      `http://127.0.0.1:${apiPort}/awf/decisions/${encodeURIComponent(decisionId)}/resolve?p=${encodeURIComponent(proj)}`,
      {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outcome: 'approve', reviewer: 'human-test', note: '确认删除' }),
      },
    );
    const resolvedBody = await resolved.json();
    expect(resolved.status, JSON.stringify(resolvedBody)).toBe(200);
    expect(resolvedBody.proposal.status).toBe('applied');
    expect(resolvedBody.decision.result).toMatchObject({ outcome: 'approve', application_status: 'applied' });
    expect(JSON.parse(fs.readFileSync(path.join(proj, '.awf', 'state.json'), 'utf8')).tasks
      .some((task) => task.id === 'T2-I2')).toBe(false);
  });
});
