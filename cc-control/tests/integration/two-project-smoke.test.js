import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { loadState, saveState, markTaskActive, findNextTask, setWorkflowMode } from '../../src/lib/state.js';

const require = createRequire(import.meta.url);
const { createRunHost } = require('../../src/server/run-host.cjs');
const { DecisionStore } = require('../../src/server/decision-store.cjs');

// T1-075 冒烟：同机两独立项目并发 run —— 各自 .awf/settings/workdir：不互杀、hook 路由正确、
// 隔离成立、registry 列两 run（A：两个独立 projectRoot 的 host 并发推进；B：两个真实 server 进程）。

const SERVER_PATH = fileURLToPath(new URL('../../src/server/server.cjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-twoproj-'));
function mkProject(name) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.awf'), { recursive: true });
  fs.writeFileSync(path.join(root, '.awf', 'state.json'), JSON.stringify({
    mode: 'idle', currentState: 'CODE',
    tasks: [{ id: 'T1', kind: 'dev', plannedFiles: [`${name}.js`], status: 'pending', deps: [] }],
  }, null, 2));
  return root;
}

const stateApi = { loadState, saveState, markTaskActive, findNextTask, setWorkflowMode };
const CFG = { agents: { max: 1, maxModules: 1, maxPerModule: 1, maxPerFeature: 1 } };

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
async function serverUp(port) { try { const r = await fetch(`http://127.0.0.1:${port}/status`); return r.ok; } catch { return false; } }
async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return res.json().catch(() => null);
}
async function getJson(url) { const r = await fetch(url); return r.json().catch(() => null); }

async function waitDone(host, runId) {
  const t0 = Date.now();
  for (;;) {
    const s = host.snapshot(runId).run;
    if (s && ['done', 'error', 'stopped'].includes(s.status)) return s;
    if (Date.now() - t0 > 6000) throw new Error('waitDone 超时');
    await sleep(10);
  }
}

afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

// ── A：两个独立 projectRoot 的 host 并发 run（隔离 + registry 各列其 run）──

describe('两独立项目 host 并发 run（T1-075-A）', () => {
  it('P1/P2 各自 host 并发推进到 done；state/run 记录互不干扰', async () => {
    const p1 = mkProject('projA');
    const p2 = mkProject('projB');
    const mkExec = (root) => ({ runTask: async ({ taskId }) => { const s = loadState(root); const t = s.tasks.find((x) => x.id === taskId); t.status = 'done'; t.exec = { result: 'ok' }; saveState(root, s); return { status: 'done' }; } });
    const h1 = createRunHost({ projectRoot: p1, cfg: CFG, state: stateApi, chain: { decideChain: (t) => ({ chain: 'simple', stages: ['DEV', 'COMMIT'] }), gateCompletionHook: () => async () => false }, executor: mkExec(p1) });
    const h2 = createRunHost({ projectRoot: p2, cfg: CFG, state: stateApi, chain: { decideChain: (t) => ({ chain: 'simple', stages: ['DEV', 'COMMIT'] }), gateCompletionHook: () => async () => false }, executor: mkExec(p2) });
    h1.start(); h2.start();
    const a = h1.submitRun({ runId: 'runA' });
    const b = h2.submitRun({ runId: 'runB' });
    expect(a.ok).toBe(true); expect(b.ok).toBe(true);
    await Promise.all([waitDone(h1, 'runA'), waitDone(h2, 'runB')]);

    // 各自 host registry 各列其 run（done）
    expect(h1.snapshot().runs.map((r) => r.runId)).toEqual(['runA']);
    expect(h2.snapshot().runs.map((r) => r.runId)).toEqual(['runB']);
    // 各自 .awf 状态独立完成
    expect(loadState(p1).tasks[0].status).toBe('done');
    expect(loadState(p2).tasks[0].status).toBe('done');
    expect(loadState(p1).tasks[0].exec.result).toBe('ok');
    expect(loadState(p2).tasks[0].exec.result).toBe('ok');
  });
});

// ── B：两个真实 server 进程（不同端口/项目）并发驻留：不互杀、project/run 槽隔离、hook 路由 ──

describe('两 server 进程并发驻留（T1-075-B）', () => {
  const children = [];
  async function spawnOne(name) {
    const port = await freePort();
    const proj = mkProject(name);
    const proc = spawn('node', [SERVER_PATH], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CC_PORT: String(port), CC_PROJECT: proj, CC_SERVER_IDLE_MS: '0' },
    });
    children.push(proc);
    proc.stderr.on('data', () => {});
    const deadline = Date.now() + 6000;
    while (!(await serverUp(port))) { if (Date.now() > deadline || proc.exitCode != null) throw new Error('server 未就绪'); await sleep(50); }
    return { proc, port, proj };
  }

  afterAll(async () => {
    for (const c of children) { if (c.exitCode == null) c.kill('SIGKILL'); }
    children.length = 0;
  });

  it('两 server 同时驻留：projectRoot 各自、hook sid 路由只影响本 server、不互杀', async () => {
    const s1 = await spawnOne('svcA');
    const s2 = await spawnOne('svcB');

    // 不互杀：两进程都存活且 projectRoot 各异
    expect(s1.proc.exitCode).toBe(null);
    expect(s2.proc.exitCode).toBe(null);
    const st1 = await getJson(`http://127.0.0.1:${s1.port}/status`);
    const st2 = await getJson(`http://127.0.0.1:${s2.port}/status`);
    expect(st1.projectRoot).not.toBe(st2.projectRoot);

    // hook 路由：只在 s1 喂 sid=rA，s2 对应槽保持独立
    await postJson(`http://127.0.0.1:${s1.port}/hook?event=SessionStart&sid=rA`, {});
    await postJson(`http://127.0.0.1:${s1.port}/hook?event=UserPromptSubmit&sid=rA`, {});
    expect((await getJson(`http://127.0.0.1:${s1.port}/status?sid=rA`)).state).toBe('busy');
    expect((await getJson(`http://127.0.0.1:${s1.port}/status?sid=rB`)).state).toBe('ready'); // s1 内槽隔离
    expect((await getJson(`http://127.0.0.1:${s2.port}/status?sid=rA`)).state).toBe('ready'); // s2 不受 s1 hook 影响

    // 两进程都仍存活（互不 kill）
    expect(s1.proc.exitCode).toBe(null);
    expect(s2.proc.exitCode).toBe(null);
  }, 20000);
});

// ── T1-076：单/双 run 状态·决策归属断言（决策落各自 run 文件不串）──

describe('单/双 run 状态·决策归属（T1-076）', () => {
  function hostOf(root) {
    const mkExec = (r) => ({
      runTask: async ({ taskId }) => {
        const s = loadState(r); const t = s.tasks.find((x) => x.id === taskId);
        t.status = 'done'; t.exec = { result: 'ok' }; saveState(r, s); return { status: 'done' };
      },
    });
    return createRunHost({
      projectRoot: root, cfg: CFG, state: stateApi,
      chain: { decideChain: () => ({ chain: 'simple', stages: ['DEV', 'COMMIT'] }), gateCompletionHook: () => async () => false },
      executor: mkExec(root),
    });
  }
  const storeOf = (root, runId) => new DecisionStore(root, { runStamp: runId, runsDir: path.join(root, '.awf', 'runs', runId, 'decisions') });

  it('单 run：状态 done + 决策只落该 run 文件', async () => {
    const p = mkProject('single');
    const h = hostOf(p); h.start();
    const r = h.submitRun({ runId: 'runS' });
    expect(r.ok).toBe(true);
    expect((await waitDone(h, 'runS')).status).toBe('done');
    expect(loadState(p).tasks[0].status).toBe('done');

    const st = storeOf(p, 'runS');
    const a = st.append({ decision_id: 'D-S', event: 'decision_completed', at: new Date().toISOString() });
    expect(a.file).toBe(path.join(p, '.awf', 'runs', 'runS', 'decisions', 'runS.jsonl'));
    expect(st.listAll()).toHaveLength(1);
  });

  it('双 run 并发：各自状态 done、决策分属各自 run 文件不串', async () => {
    const p1 = mkProject('dualA');
    const p2 = mkProject('dualB');
    const h1 = hostOf(p1); const h2 = hostOf(p2);
    h1.start(); h2.start();
    const a = h1.submitRun({ runId: 'run1' });
    const b = h2.submitRun({ runId: 'run2' });
    expect(a.ok).toBe(true); expect(b.ok).toBe(true);
    await Promise.all([waitDone(h1, 'run1'), waitDone(h2, 'run2')]);
    expect(loadState(p1).tasks[0].status).toBe('done');
    expect(loadState(p2).tasks[0].status).toBe('done');

    const s1 = storeOf(p1, 'run1');
    const s2 = storeOf(p2, 'run2');
    s1.append({ decision_id: 'D1', event: 'decision_completed', at: new Date().toISOString() });
    s2.append({ decision_id: 'D2', event: 'decision_completed', at: new Date().toISOString() });
    expect(s1.listAll().map((e) => e.decision_id)).toEqual(['D1']);
    expect(s2.listAll().map((e) => e.decision_id)).toEqual(['D2']);
    expect(fs.existsSync(path.join(p2, '.awf', 'runs', 'run1'))).toBe(false); // 不串写对端
  });
});
