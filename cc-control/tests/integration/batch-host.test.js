import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 多 agent 宿主链路（run-host driveBatch → runScheduler → batch-transport）经真实 server 走通：
// 提交 run → 宿主按 cfg.agents.max>1 判定 batch → 派发（tmux 注入 subagentDispatch 提示词）
// → 完成感知（轮询 state）→ 落账 → run done。调度权在宿主，CLI/测试只提交与观察。
//
// 模型通道用 mock tmux 顶替：收到派发提示词 = 子 Agent 完成并落账（真实场景由 SubagentStop hook 落账）。

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-batch-host-'));
fs.mkdirSync(path.join(TMP, '.awf'), { recursive: true });
fs.writeFileSync(path.join(TMP, '.awf', 'config.json'), JSON.stringify({ run: { agents: { max: 2, maxModules: 2, maxPerModule: 2, maxPerFeature: 2 } } }));
fs.writeFileSync(path.join(TMP, '.awf', 'state.json'), JSON.stringify({
  mode: 'idle', currentState: 'CODE', version: '0.2.0',
  tasks: [
    { id: 'T1', kind: 'dev', title: '做 A', prompt: 'do A', plannedFiles: ['src/a.js'], status: 'pending', deps: [] },
    { id: 'T2', kind: 'dev', title: '做 B', prompt: 'do B', plannedFiles: ['src/b.js'], status: 'pending', deps: [] },
  ],
}, null, 2));

const STATE_PATH = path.join(TMP, '.awf', 'state.json');

/** 模拟子 Agent：收到派发提示词 → 对应任务落账 done（等价 SubagentStop hook 结算） */
function settleFromPrompt(text) {
  const m = /执行任务 ([\w-]+)/.exec(text);
  if (!m) return;
  const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  const t = s.tasks.find((x) => x.id === m[1]);
  if (!t) return;
  t.status = 'done';
  t.exec = { result: `mock settled ${t.id}`, files: t.plannedFiles };
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

// 主会话「回合结束」：真实环境由 Stop hook 置 ready；这里显式模拟，否则派发会卡在等就绪。
let setReadyFn = null;

const sent = [];
global.__CC_TMUX__ = {
  hasSession: () => true,
  sendText: (text) => {
    sent.push(text);
    queueMicrotask(() => { settleFromPrompt(text); setReadyFn?.(); });
  },
  sendEnter: () => {},
  sendCtrlC: () => {},
  capture: () => 'pane',
  SESSION: 'cc',
};
global.__CC_RUNLOGGER__ = { RunLogger: class { constructor() {} get enabled() { return false; } resetTranscript() {} captureFromTranscript() {} logPrompt() {} logChoice() {} logDecision() {} } };

process.env.CC_PROJECT = TMP;
process.env.CC_READY_TIMEOUT_MS = '500';
process.env.CC_ENTER_DELAY_MS = '0';
process.env.CC_BATCH_IDLE_TIMEOUT_MS = '8000';

const SERVER_PATH = fileURLToPath(new URL('../../src/server/server.cjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let api;

beforeAll(async () => {
  server = await import(SERVER_PATH);
  setReadyFn = () => server.setReady();
  const { url } = await server.start(0);
  api = async (method, pathname, body) => {
    const headers = { connection: 'close' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(url + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json };
  };
});

afterAll(async () => {
  await server?.stop();
  delete global.__CC_TMUX__;
  delete global.__CC_RUNLOGGER__;
  for (const k of ['CC_PROJECT', 'CC_READY_TIMEOUT_MS', 'CC_ENTER_DELAY_MS', 'CC_BATCH_IDLE_TIMEOUT_MS']) delete process.env[k];
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('batch 宿主链路 — 提交 → 派发 → 完成感知 → 落账', () => {
  it('cfg max>1 → 宿主 batch 模式派发子 Agent 并等到全部落账', async () => {
    const submitted = await api('POST', '/run/submit', {});
    expect(submitted.status).toBe(202);
    expect(submitted.body.mode).toBe('batch');

    // 等到 run 终态
    let run = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const r = await api('GET', `/run/status?runId=${submitted.body.runId}`);
      run = r.body?.run;
      if (run && (run.status === 'done' || run.status === 'error')) break;
    }

    expect(run?.error).toBeFalsy();
    expect(run?.status).toBe('done');
    expect(run?.counts).toMatchObject({ total: 2, done: 2 });

    // 派发确实注入了 subagentDispatch 提示词（含任务 ID），每个任务一次
    expect(sent.filter((t) => t.includes('执行任务 T1'))).toHaveLength(1);
    expect(sent.filter((t) => t.includes('执行任务 T2'))).toHaveLength(1);

    // 落账结果
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    expect(s.tasks.map((t) => t.status)).toEqual(['done', 'done']);
    expect(s.mode).toBe('idle'); // 宿主收尾复位（本 run 改的 mode 还原）
  }, 60000);
});
