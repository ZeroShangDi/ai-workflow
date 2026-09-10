import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 单 agent 执行器：等人工决策应答期间不得被收尾协商判死。
// 2026-09-10 现场：CC 调 awf_await_choice（该工具立即返回，CC 随即结束回合）→ decisionPending 落地，
// 执行器只看会话 busy/ready、不看决策 → 会话 idle 满窗口即进收尾协商 → 8 分钟内标 blocked、
// run 结束 → 用户之后做出的选择喂给了已经结束的 run。

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-single-dec-'));
const STATE_PATH = path.join(TMP, '.awf', 'state.json');
fs.mkdirSync(path.join(TMP, '.awf'), { recursive: true });
fs.writeFileSync(STATE_PATH, JSON.stringify({
  mode: 'idle', currentState: 'CODE', version: '0.2.0',
  tasks: [{ id: 'T1', kind: 'dev', title: '做 A', prompt: 'do A', plannedFiles: ['src/a.js'], status: 'pending', deps: [] }],
}, null, 2));

const sent = [];
global.__CC_TMUX__ = {
  hasSession: () => true,
  sendText: (t) => { sent.push(t); },
  sendEnter: () => {},
  sendCtrlC: () => {},
  capture: () => 'pane',
  SESSION: 'cc',
};
global.__CC_RUNLOGGER__ = {
  RunLogger: class {
    constructor() {}
    get enabled() { return false; }
    resetTranscript() {} captureFromTranscript() {} logPrompt() {} logChoice() {} logDecision() {}
  },
};

process.env.CC_PROJECT = TMP;
process.env.CC_READY_TIMEOUT_MS = '700'; // 无变化窗口压到 0.7s，便于在测试里触发误判
process.env.CC_ENTER_DELAY_MS = '0';
process.env.CC_SESSION_READY_TIMEOUT_MS = '0';

const SERVER_PATH = fileURLToPath(new URL('../../src/server/server.cjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let api;

beforeAll(async () => {
  server = await import(SERVER_PATH);
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
  for (const k of ['CC_PROJECT', 'CC_READY_TIMEOUT_MS', 'CC_ENTER_DELAY_MS', 'CC_SESSION_READY_TIMEOUT_MS']) delete process.env[k];
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('单 agent 执行器 — 等人工决策应答期间不判死', () => {
  it('决策未应答时既不标 blocked，也不补发收尾/追问', async () => {
    const submitted = await api('POST', '/run/submit', {});
    expect(submitted.status).toBe(202);

    // 等任务 prompt 送达（执行器已提交）
    for (let i = 0; i < 40 && sent.length === 0; i++) await sleep(50);
    expect(sent).toHaveLength(1);

    // 会话回合结束 + CC 上抛决策（awf_await_choice 语义：工具立即返回，CC 不再动作）
    server.setReady();
    const dec = await api('POST', '/choice', { question: '选哪个？', options: ['A', 'B'] });
    expect(dec.body.ok).toBe(true);

    // 远超无变化窗口（0.7s）地等待：修复前这里会进收尾协商并最终标 blocked
    await sleep(3500);

    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    expect(s.tasks[0].status).not.toBe('blocked');
    expect(sent.filter((t) => t.includes('收尾') || t.includes('三选一'))).toHaveLength(0);

    // 收尾：应答 + 任务落账，让 run 正常结束
    await api('POST', '/respond', { value: 'A' });
    for (let i = 0; i < 20; i++) {
      const st = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
      if (st.tasks[0].status === 'active') break;
      await sleep(50);
    }
    const st2 = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    st2.tasks[0].status = 'done';
    st2.tasks[0].exec = { result: 'ok', files: ['src/a.js'] };
    fs.writeFileSync(STATE_PATH, JSON.stringify(st2, null, 2));
    for (let i = 0; i < 40; i++) {
      const r = await api('GET', '/run/status?runId=default');
      if (r.body?.run?.status === 'done') break;
      await sleep(100);
    }
  }, 30000);
});
