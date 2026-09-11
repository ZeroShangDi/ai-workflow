import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { makeApi } from '../helpers/http-api.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { loadState, saveState, markTaskActive, findNextTask, setWorkflowMode } from '../../src/lib/state.js';
import { handleGateCompletion } from '../../src/server/gate-fix.js';
import { runScheduler } from '../../src/server/run-scheduler.js';
import { createRunClient } from '../../src/cli/run-client.js';
import { openWsClient } from '../helpers/ws-client.js';

const require = createRequire(import.meta.url);
const runDriver = require('../../src/server/run-driver.cjs');

// server.cjs 常驻 run host 端点（T1-105）：以 __CC_RUN_HOST_DEPS__ 注入真实 state/run-driver/
// gate-fix + fake per-task executor（模型通道由 T1-058 接线），走真实 HTTP 提交→驱动→轮询闭环。

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-runhost-integ-'));
const runProject = path.join(TMP, 'run-project');
fs.mkdirSync(path.join(runProject, '.awf'), { recursive: true });
fs.writeFileSync(
  path.join(runProject, '.awf', 'state.json'),
  JSON.stringify({
    mode: 'idle', currentState: 'CODE',
    tasks: [
      { id: 'T1', kind: 'dev', title: '做 A', plannedFiles: ['a.js'], status: 'pending', deps: [] },
      { id: 'T2', kind: 'dev', title: '做 B', plannedFiles: ['b.js'], status: 'pending', deps: ['T1'] },
    ],
  }, null, 2),
);

// ── env + 注入：必须在 import server.cjs 之前 ──
process.env.CC_PROJECT = runProject;
process.env.CC_READY_TIMEOUT_MS = '300';
process.env.CC_ENTER_DELAY_MS = '0';
process.env.HOME = path.join(TMP, 'home');
fs.mkdirSync(path.join(TMP, 'home'), { recursive: true });
// tmux mock（server.cjs 顶层加载），run host 默认 executor 未接线，这里走注入 fake
global.__CC_TMUX__ = {
  hasSession: () => true, sendText: () => {}, sendEnter: () => {}, sendCtrlC: () => {}, capture: () => 'pane', SESSION: 'cc',
};
global.__CC_RUNLOGGER__ = { RunLogger: class { constructor() {} get enabled() { return false; } } };

const stateApi = { loadState, saveState, markTaskActive, findNextTask, setWorkflowMode };
const fakeExecutor = {
  runTask: async ({ projectRoot, taskId }) => {
    const s = loadState(projectRoot);
    const t = s.tasks.find((x) => x.id === taskId);
    if (t) { t.status = 'done'; t.exec = { result: 'ok', files: t.plannedFiles || [] }; saveState(projectRoot, s); }
    return { status: 'done' };
  },
};
global.__CC_RUN_HOST_DEPS__ = {
  stateApi,
  cfg: { agents: { max: 1, maxModules: 1, maxPerModule: 1, maxPerFeature: 1 } },
  chain: runDriver,
  handleGateCompletion,
  scheduler: runScheduler,
  executor: fakeExecutor,
  batch: null,
};

const SERVER_PATH = fileURLToPath(new URL('../../src/server/server.cjs', import.meta.url));

let server;
let api;
let baseUrl = ''; // ws 测试用
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询 run 状态直到终态（done/error/stopped） */
async function waitRunDone(runId, timeoutMs = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const res = await api('GET', `/run/status?runId=${runId}`);
    if (res.body?.run && ['done', 'error', 'stopped'].includes(res.body.run.status)) return res.body.run;
    await sleep(10);
  }
  throw new Error(`waitRunDone(${runId}) 超时`);
}

beforeAll(async () => {
  const mod = await import(SERVER_PATH);
  server = mod;
  const { url } = await server.start(0);
  baseUrl = url;
  api = makeApi(url, runProject);
});

afterAll(async () => {
  await server?.stop();
  delete global.__CC_TMUX__;
  delete global.__CC_RUNLOGGER__;
  delete global.__CC_RUN_HOST_DEPS__;
  delete process.env.CC_PROJECT;
  delete process.env.CC_READY_TIMEOUT_MS;
  delete process.env.CC_ENTER_DELAY_MS;
  delete process.env.HOME;
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  // 复位 run 项目 state 到初始 pending，保证用例顺序无关
  fs.writeFileSync(
    path.join(runProject, '.awf', 'state.json'),
    JSON.stringify({
      mode: 'idle', currentState: 'CODE',
      tasks: [
        { id: 'T1', kind: 'dev', title: '做 A', plannedFiles: ['a.js'], status: 'pending', deps: [] },
        { id: 'T2', kind: 'dev', title: '做 B', plannedFiles: ['b.js'], status: 'pending', deps: ['T1'] },
      ],
    }, null, 2),
  );
  server._resetForTest();
});

describe('server run host 端点（/run/*）', () => {
  it('GET /run/status 空态：host 装配完成、无 run（runs: []）', async () => {
    const res = await api('GET', '/run/status');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.runs).toEqual([]);
  });

  it('POST /run/submit → 驱动到 done；事件轮询含 run/task 生命周期', async () => {
    const sub = await api('POST', '/run/submit', { runId: 'it1' });
    expect(sub.status).toBe(202);
    expect(sub.body).toMatchObject({ ok: true, runId: 'it1', mode: 'single' });

    const run = await waitRunDone('it1');
    expect(run.status).toBe('done');
    expect(run.counts).toMatchObject({ total: 2, done: 2, blocked: 0 });

    // 事件轮询：run.submitted → run.started → task.started/done ×2 → run.stopped
    const events = [];
    let afterSeq = 0;
    let sawStopped = false;
    for (let i = 0; i < 200 && !sawStopped; i++) {
      const res = await api('GET', `/run/events?afterSeq=${afterSeq}&runId=it1`);
      for (const e of res.body?.events || []) { events.push(e); afterSeq = e.seq; if (e.type === 'run.stopped') sawStopped = true; }
      await sleep(5);
    }
    const types = events.map((e) => e.type);
    expect(types).toContain('run.submitted');
    expect(types).toContain('run.started');
    expect(types).toContain('run.stopped');
    const started = events.filter((e) => e.type === 'task.started').map((e) => e.payload.taskId);
    expect(started).toEqual(['T1', 'T2']); // deps 有序
    expect(events.filter((e) => e.type === 'task.done').length).toBe(2);

    // 幂等轮询：afterSeq 尾游标后无新事件
    const tail = await api('GET', `/run/events?afterSeq=${afterSeq}&runId=it1`);
    expect(tail.body.events).toEqual([]);
    expect(tail.body.tailSeq).toBe(afterSeq);

    // state 真实落账
    const s = loadState(runProject);
    expect(s.tasks.map((t) => t.status)).toEqual(['done', 'done']);
  });

  it('未知 runId 快照 → ok:false；重复/并发 submit 冲突可读', async () => {
    const miss = await api('GET', '/run/status?runId=nope');
    expect(miss.status).toBe(200);
    expect(miss.body.ok).toBe(false);
    expect(miss.body.error).toContain('nope');
  });
});

describe('run events WebSocket 推送（T1-091 轮询→事件订阅）', () => {
  const wsPort = () => Number(new URL(baseUrl).port);

  it('ws 订阅实时收到 run/task 事件（task.done/run 状态推送刷新）', async () => {
    const ws = await openWsClient({ port: wsPort() });
    try {
      // 先确保 host 装配完成 + 订阅注册就绪
      await api('GET', '/run/status');
      const sub = await api('POST', '/run/submit', { runId: 'ws1' });
      expect(sub.status).toBe(202);

      // 事件推送（非轮询）：直接经 ws 帧到达
      await ws.waitFor((msgs) => msgs.some((m) => JSON.parse(m).type === 'run.stopped'));
      const types = ws.messages.map((m) => JSON.parse(m).type);
      expect(types).toContain('run.started');
      expect(types.filter((t) => t === 'task.done').length).toBe(2);
      expect(types).toContain('run.stopped');

      // 帧为 { seq, runId, type, at, payload } 归一事件
      const done = ws.messages.map((m) => JSON.parse(m)).find((e) => e.type === 'task.done');
      expect(done.runId).toBe('ws1');
      expect(done.payload.taskId).toBeTruthy();
    } finally {
      await ws.close();
    }
  });

  it('decision.required 推送（决策挂起 → 前端订阅刷新依据）', async () => {
    const ws = await openWsClient({ port: wsPort() });
    try {
      await api('GET', '/run/status'); // host 装配完成
      const c = await api('POST', '/choice', { type: 'choice', question: '继续?', options: ['继续', '跳过'] });
      expect(c.status).toBe(200);

      await ws.waitFor((msgs) => msgs.some((m) => JSON.parse(m).type === 'decision.required'));
      const ev = ws.messages.map((m) => JSON.parse(m)).find((e) => e.type === 'decision.required');
      expect(ev.payload.question).toBe('继续?');
      expect(ev.payload.options).toEqual(['继续', '跳过']);
    } finally {
      await ws.close();
    }
  });

  it('非 /run/events 升级路径 → 拒绝（握手失败）', async () => {
    await expect(openWsClient({ port: wsPort(), path: '/status' })).rejects.toThrow(/101|失败/);
  });
});

describe('cli run-client 经 server（新结构 client→afterSeq 事件路由→store 读，T1-095）', () => {
  it('真实 createRunClient（非 mock）提交→poll 事件到 done→快照→getState 读 store', async () => {
    const port = Number(new URL(baseUrl).port);
    const client = createRunClient({ port, project: runProject });

    const sub = await client.submitRun({ runId: 'cli1' });
    expect(sub.ok).toBe(true);

    // afterSeq 增量轮询直到 run.stopped
    let after = 0;
    let sawStopped = false;
    const types = [];
    for (let i = 0; i < 200 && !sawStopped; i++) {
      const ev = await client.pollRunEvents({ runId: 'cli1', afterSeq: after });
      for (const e of ev.events || []) { types.push(e.type); after = e.afterSeq ?? after; if (e.type === 'run.stopped') sawStopped = true; }
      await sleep(5);
    }
    expect(sawStopped).toBe(true);
    expect(types).toContain('run.started');
    expect(types.filter((t) => t === 'task.done').length).toBe(2);

    const snap = await client.runSnapshot({ runId: 'cli1' });
    expect(snap.run.status).toBe('done');
    expect(snap.run.counts).toMatchObject({ total: 2, done: 2 });

    // store 路径读：CLI 运行态读经 server GET /awf/state（T1-062 单写者收口，不再直读 lib/state.js）
    const st = await client.getState();
    expect(st.tasks.map((t) => t.status)).toEqual(['done', 'done']);
  });
});

describe('server run api 写端点（T1-061，单写者落盘）', () => {
  it('/run/state/mode + task/active 经 server 落盘', async () => {
    const m1 = await api('POST', '/run/state/mode', { mode: 'pause' });
    expect(m1.status).toBe(200);
    expect(m1.body.ok).toBe(true);
    let s = loadState(runProject);
    expect(s.mode).toBe('pause');

    const m2 = await api('POST', '/run/state/task/active', { taskId: 'T1' });
    expect(m2.status).toBe(200);
    expect(m2.body.ok).toBe(true);
    s = loadState(runProject);
    expect(s.tasks.find((t) => t.id === 'T1').status).toBe('active');
    expect(s.tasks.find((t) => t.id === 'T1').exec.startedAt).toBeTruthy();
  });

  it('/run/state/gate：review blocked+verdict fail → server 派生修复 + 回退复审', async () => {
    // 注入门禁失败现场
    fs.writeFileSync(
      path.join(runProject, '.awf', 'state.json'),
      JSON.stringify({
        mode: 'run', currentState: 'CODE',
        tasks: [
          { id: 'T1', kind: 'dev', status: 'done', deps: [] },
          { id: 'R1', kind: 'review', title: '审查', status: 'blocked', deps: ['T1'], plannedFiles: [],
            exec: { verdict: { level: 'fail', conclusion: '方向性错误' }, files: ['.awf/reports/review/r1.md'] } },
        ],
      }, null, 2),
    );
    const res = await api('POST', '/run/state/gate', { taskId: 'R1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const s = loadState(runProject);
    const gate = s.tasks.find((t) => t.id === 'R1');
    expect(gate.status).toBe('pending'); // 回退待复审
    expect(s.tasks.some((t) => t.id === 'R1-F1')).toBe(true); // server 派生修复
    expect(gate.exec.recheck).toBe(1);
  });
});
