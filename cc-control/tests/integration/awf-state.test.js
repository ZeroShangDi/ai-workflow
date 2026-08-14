import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ── server path ──

const SERVER_PATH = fileURLToPath(new URL('../../plugin/core/mcp/awf-state/server.cjs', import.meta.url));

// ── fixtures ──

function writeState(root, state) {
  const awf = path.join(root, '.awf');
  fs.mkdirSync(awf, { recursive: true });
  fs.writeFileSync(path.join(awf, 'state.json'), JSON.stringify(state, null, 2));
}

function readState(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.awf', 'state.json'), 'utf-8'));
}

function baseState() {
  return {
    mode: 'idle',
    version: '0.1.0',
    currentState: 'IDLE',
    plan: {
      summary: '默认计划',
      tasks: [
        { id: 'T1', desc: '任务1', prompt: 'p1', status: 'pending', deps: [], complexity: 'medium', wbsRef: null, featureGroup: null, phases: null },
        { id: 'T2', desc: '任务2', prompt: 'p2', status: 'pending', deps: [], complexity: 'medium', wbsRef: null, featureGroup: null, phases: null },
      ],
    },
    milestones: [],
  };
}

// ── JSON-RPC client over stdio ──

class AWFStateClient {
  constructor(projectRoot) {
    this.proc = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, AWF_PROJECT_ROOT: projectRoot },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.nextId = 1;
    this.buffer = '';
    this.pending = new Map();
    this.stderr = '';

    this.proc.stdout.setEncoding('utf-8');
    this.proc.stderr.setEncoding('utf-8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.on('data', (chunk) => { this.stderr += chunk; });
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
      const resolve = this.pending.get(msg.id);
      if (resolve) {
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
        // 防挂起：子进程异常退出时 pending 永不 resolve
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`JSON-RPC 请求超时: ${method}`));
        }
      }, 5000);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async initialize() {
    return (await this.request('initialize', {})).result;
  }

  async toolsList() {
    return (await this.request('tools/list')).result.tools;
  }

  async callTool(name, args = {}) {
    const msg = await this.request('tools/call', { name, arguments: args });
    if (msg.error) throw new Error(JSON.stringify(msg.error));
    return JSON.parse(msg.result.content[0].text);
  }

  close() {
    this.proc.stdin.end();
    this.proc.kill('SIGTERM');
  }
}

// ── tests ──

describe('awf-state MCP Server — JSON-RPC protocol', () => {
  let tmpDir;
  let client;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-state-mcp-'));
    client = new AWFStateClient(tmpDir);
    await client.initialize(); // ready barrier
  });

  afterAll(() => {
    if (client) client.close(); // beforeAll 失败时 client 可能未创建
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    writeState(tmpDir, baseState());
  });

  // ── protocol handshake ──

  it('TC27: initialize 协议握手', async () => {
    const result = await client.initialize();
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.capabilities).toEqual({ tools: {} });
    expect(result.serverInfo).toEqual({ name: 'awf-state-mcp', version: '1.0.0' });
  });

  it('TC28: tools/list 返回 17 个 tools', async () => {
    const tools = await client.toolsList();
    expect(tools).toHaveLength(17);
    tools.forEach((t) => {
      expect(t).toHaveProperty('name');
      expect(t).toHaveProperty('description');
      expect(t).toHaveProperty('inputSchema');
    });
  });

  it('TC30: 未知 method → -32601', async () => {
    const msg = await client.request('unknown/method');
    expect(msg.error.code).toBe(-32601);
    expect(msg.error.message).toContain('method not found: unknown/method');
  });

  // ── read ──

  it('TC11: awf_read_state 返回完整 state', async () => {
    const before = readState(tmpDir);
    const res = await client.callTool('awf_read_state');

    expect(res.mode).toBe('idle');
    expect(res.version).toBe('0.1.0');
    expect(res.plan.tasks).toHaveLength(2);
    // read-only: state 不变
    expect(readState(tmpDir)).toEqual(before);
  });

  // ── task lifecycle ──

  it('TC12: awf_task_status 更新任务状态', async () => {
    const res = await client.callTool('awf_task_status', { id: 'T1', status: 'active' });
    expect(res).toEqual({ ok: true, tool: 'awf_task_status' });

    const s = readState(tmpDir);
    expect(s.plan.tasks.find((t) => t.id === 'T1').status).toBe('active');
    expect(s.plan.tasks.find((t) => t.id === 'T2').status).toBe('pending');
    expect(s.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('TC13: awf_task_status id 不存在 → ok:false 且 state 不变', async () => {
    const before = readState(tmpDir);
    const res = await client.callTool('awf_task_status', { id: 'T99', status: 'active' });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('task T99 not found');
    expect(readState(tmpDir)).toEqual(before);
  });

  it('TC14: awf_task_result 写入 result + files', async () => {
    const res = await client.callTool('awf_task_result', { id: 'T1', result: '完成', files: ['a.js', 'b.js'] });
    expect(res.ok).toBe(true);

    const s = readState(tmpDir);
    expect(s.plan.tasks.find((t) => t.id === 'T1').exec).toEqual({ result: '完成', files: ['a.js', 'b.js'] });
  });

  it('TC15: awf_task_commit 追加 commit 记录', async () => {
    await client.callTool('awf_task_commit', { id: 'T1', hash: 'abc1234', message: 'feat: add x' });
    await client.callTool('awf_task_commit', { id: 'T1', hash: 'def5678', message: 'fix: y' });

    const s = readState(tmpDir);
    expect(s.plan.tasks.find((t) => t.id === 'T1').commits).toEqual([
      { hash: 'abc1234', message: 'feat: add x' },
      { hash: 'def5678', message: 'fix: y' },
    ]);
  });

  it('TC16: awf_task_create 正常创建（默认值）', async () => {
    const res = await client.callTool('awf_task_create', { id: 'T3', desc: '新任务', prompt: '做某事' });
    expect(res).toEqual({ ok: true, tool: 'awf_task_create' });

    const s = readState(tmpDir);
    const t3 = s.plan.tasks.find((t) => t.id === 'T3');
    expect(t3).toMatchObject({
      id: 'T3', desc: '新任务', prompt: '做某事',
      status: 'pending', deps: [], complexity: 'medium',
      featureGroup: null, phases: null,
    });
    expect(t3.wbsRef).toBeUndefined(); // 未提供时为 undefined（JSON 序列化丢弃）
    expect(s.plan.tasks).toHaveLength(3);
  });

  it('TC17: awf_task_create id 重复 → ok:false', async () => {
    const before = readState(tmpDir);
    const res = await client.callTool('awf_task_create', { id: 'T1', desc: '重复', prompt: '...' });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('task T1 already exists');
    expect(readState(tmpDir)).toEqual(before);
  });

  it('TC18: awf_task_update 部分字段更新 + featureGroup 空串 → null', async () => {
    const res = await client.callTool('awf_task_update', { id: 'T1', desc: 'new desc', featureGroup: '' });
    expect(res.ok).toBe(true);

    const t1 = readState(tmpDir).plan.tasks.find((t) => t.id === 'T1');
    expect(t1.desc).toBe('new desc');
    expect(t1.prompt).toBe('p1'); // 未传不更新
    expect(t1.featureGroup).toBeNull();
  });

  it('TC19: awf_task_delete 正常删除', async () => {
    const res = await client.callTool('awf_task_delete', { id: 'T2' });
    expect(res).toEqual({ ok: true, tool: 'awf_task_delete' });

    const tasks = readState(tmpDir).plan.tasks;
    expect(tasks.map((t) => t.id)).toEqual(['T1']);
  });

  // ── plan metadata ──

  it('TC20: awf_plan_configure 配置所有元数据', async () => {
    await client.callTool('awf_plan_configure', {
      summary: '摘要', hasUI: true, inScope: ['A'], outOfScope: ['B'], acceptanceCriteria: ['C1'],
    });

    const plan = readState(tmpDir).plan;
    expect(plan.summary).toBe('摘要');
    expect(plan.hasUI).toBe(true);
    expect(plan.inScope).toEqual(['A']);
    expect(plan.outOfScope).toEqual(['B']);
    expect(plan.acceptanceCriteria).toEqual(['C1']);
  });

  // ── WBS lifecycle ──

  it('TC21: awf_wbs_create/update/delete 正常链路', async () => {
    await client.callTool('awf_wbs_create', { id: 'W1', name: '模块1', desc: '...' });
    let s = readState(tmpDir);
    expect(s.plan.wbs).toHaveLength(1);
    expect(s.plan.wbs[0]).toMatchObject({ id: 'W1', name: '模块1', deps: [] });

    await client.callTool('awf_wbs_update', { id: 'W1', name: '模块1-改' });
    s = readState(tmpDir);
    expect(s.plan.wbs[0].name).toBe('模块1-改');

    await client.callTool('awf_wbs_delete', { id: 'W1' });
    s = readState(tmpDir);
    expect(s.plan.wbs).toEqual([]);
  });

  it('TC22: awf_wbs_create id 重复 → ok:false', async () => {
    await client.callTool('awf_wbs_create', { id: 'W1', name: '模块1' });
    const res = await client.callTool('awf_wbs_create', { id: 'W1', name: '重复' });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('wbs W1 already exists');
  });

  // ── phase / mode / version ──

  it('TC23: awf_phase 设置当前阶段', async () => {
    const res = await client.callTool('awf_phase', { phase: 'CODE' });
    expect(res.ok).toBe(true);
    expect(readState(tmpDir).currentState).toBe('CODE');
  });

  it('TC24: awf_mode 设置运行模式', async () => {
    await client.callTool('awf_mode', { mode: 'run' });
    expect(readState(tmpDir).mode).toBe('run');
  });

  it('TC25: awf_version 设置版本号', async () => {
    await client.callTool('awf_version', { version: '0.2.0' });
    expect(readState(tmpDir).version).toBe('0.2.0');
  });

  // ── milestone lifecycle ──

  it('TC26: awf_milestone_create/update/delete 正常链路', async () => {
    await client.callTool('awf_milestone_create', { id: 'M1', desc: '里程碑1', tasks: ['T1'] });
    let s = readState(tmpDir);
    expect(s.milestones).toEqual([{ id: 'M1', desc: '里程碑1', status: 'active', tasks: ['T1'] }]);

    await client.callTool('awf_milestone_update', { id: 'M1', status: 'done' });
    s = readState(tmpDir);
    expect(s.milestones[0].status).toBe('done');

    await client.callTool('awf_milestone_delete', { id: 'M1' });
    s = readState(tmpDir);
    expect(s.milestones).toEqual([]);
  });

  // ── error paths ──

  it('TC29: 未知 tool name → ok:false', async () => {
    const before = readState(tmpDir);
    const res = await client.callTool('awf_nonexistent');

    expect(res.ok).toBe(false);
    expect(res.error).toBe('unknown tool: awf_nonexistent');
    expect(readState(tmpDir)).toEqual(before);
  });

  it('TC31: state.json 不存在 → ok:false + ENOENT', async () => {
    fs.rmSync(path.join(tmpDir, '.awf', 'state.json'));
    const res = await client.callTool('awf_read_state');

    expect(res.ok).toBe(false);
    expect(res.error).toContain('ENOENT');
  });

  // ── dual position: plan.tasks vs tasks ──

  it('TC32: 双位置兼容 — plan.tasks 优先 / root tasks / 空 state', async () => {
    // A: 两者都存在 → 操作 plan.tasks，root tasks 不触碰
    writeState(tmpDir, {
      plan: { tasks: [{ id: 'T1', status: 'pending' }] },
      tasks: [{ id: 'T2', status: 'pending' }],
    });
    await client.callTool('awf_task_status', { id: 'T1', status: 'done' });
    let s = readState(tmpDir);
    expect(s.plan.tasks[0].status).toBe('done');
    expect(s.tasks[0].status).toBe('pending');

    // B: 只有 root tasks
    writeState(tmpDir, { tasks: [{ id: 'T2', status: 'pending' }] });
    await client.callTool('awf_task_status', { id: 'T2', status: 'done' });
    s = readState(tmpDir);
    expect(s.tasks[0].status).toBe('done');

    // C: 空 state → create 落到新建的 plan.tasks
    writeState(tmpDir, {});
    await client.callTool('awf_task_create', { id: 'T3', desc: 'x', prompt: 'y' });
    s = readState(tmpDir);
    expect(s.plan.tasks).toEqual([expect.objectContaining({ id: 'T3', status: 'pending' })]);
  });
});
