import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── mocks：注入到 server.cjs（原生 require 的 CJS 依赖无法用 vi.mock 拦截）──

const m = {
  tmux: {
    hasSession: vi.fn(() => true),
    sendText: vi.fn(),
    sendEnter: vi.fn(),
    sendCtrlC: vi.fn(),
    capture: vi.fn(() => 'pane content'),
    SESSION: 'cc',
  },
  logger: {
    resetTranscript: vi.fn(),
    captureFromTranscript: vi.fn(),
    logChoice: vi.fn(),
    logPrompt: vi.fn(),
  },
};

class MockRunLogger {
  constructor() {}
  get enabled() { return false; }
  get path() { return ''; }
  resetTranscript() { m.logger.resetTranscript(); }
  captureFromTranscript() { m.logger.captureFromTranscript(); }
  logChoice(...args) { m.logger.logChoice(...args); }
  logPrompt(...args) { m.logger.logPrompt(...args); }
}

// ── 临时目录：state.json 存在/不存在 + HTML 文件存在性控制 ──

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-server-test-'));
const projectWithState = path.join(TMP, 'with-state');
const projectNoState = path.join(TMP, 'no-state');
fs.mkdirSync(path.join(projectWithState, '.awf'), { recursive: true });
fs.mkdirSync(path.join(projectNoState, '.awf'), { recursive: true });
fs.writeFileSync(
  path.join(projectWithState, '.awf', 'state.json'),
  JSON.stringify({ mode: 'run', version: '0.1.0', currentState: 'CODE', tasks: [{ id: 'T1', status: 'done' }] }),
);

const htmlOnlyUi = path.join(TMP, 'html-only-ui');    // 只有 ui.html → / 回退 ui
const htmlOnlyDash = path.join(TMP, 'html-only-dash'); // 只有 dashboard → /ui 500
const htmlEmpty = path.join(TMP, 'html-empty');        // 都没有 → 500
fs.mkdirSync(htmlOnlyUi, { recursive: true });
fs.mkdirSync(htmlOnlyDash, { recursive: true });
fs.mkdirSync(htmlEmpty, { recursive: true });
fs.writeFileSync(path.join(htmlOnlyUi, 'ui.html'), '<title>cc-control</title><div id="pill"></div>');
fs.writeFileSync(path.join(htmlOnlyDash, 'dashboard.html'), '<title>AWF Run — Dashboard</title><div id="taskList"></div>');

// ── env + 注入：必须在 import server.cjs 之前 ──
process.env.CC_PROJECT = projectWithState;
process.env.CC_READY_TIMEOUT_MS = '300';   // 加速 waitReady 超时路径
process.env.CC_ENTER_DELAY_MS = '0';       // submit 不等待
process.env.CC_LOCAL_CMD_MS = '60';        // /cmd fallback
global.__CC_TMUX__ = m.tmux;
global.__CC_RUNLOGGER__ = { RunLogger: MockRunLogger };

const SERVER_PATH = fileURLToPath(new URL('../../src/server/server.cjs', import.meta.url));
const DASHBOARD_PATH = fileURLToPath(new URL('../../src/server/dashboard.html', import.meta.url));

let server;
let api;

function makeApi(base) {
  return async function (method, pathname, body) {
    const headers = { connection: 'close' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + pathname, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text, contentType: res.headers.get('content-type') };
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const mod = await import(SERVER_PATH);
  server = mod;
  const { url } = await server.start(0);
  api = makeApi(url);
});

afterAll(async () => {
  await server?.stop();
  delete global.__CC_TMUX__;
  delete global.__CC_RUNLOGGER__;
  delete process.env.CC_HTML_DIR;
  for (const k of ['CC_PROJECT', 'CC_READY_TIMEOUT_MS', 'CC_ENTER_DELAY_MS', 'CC_LOCAL_CMD_MS']) {
    delete process.env[k];
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  server._resetForTest();
  vi.clearAllMocks();
  m.tmux.hasSession.mockReturnValue(true);
  process.env.CC_PROJECT = projectWithState;
  delete process.env.CC_HTML_DIR;
});

// ─────────────────────────────────────────────
// 路由测试（TC1–TC20）
// ─────────────────────────────────────────────

describe('路由', () => {
  it('TC1: GET / → 返回 dashboard.html', async () => {
    const res = await api('GET', '/');
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/html');
    expect(res.text).toContain('<title>AWF Run — Dashboard</title>');
    expect(res.text).toContain('id="taskList"');
  });

  it('TC2: GET / → dashboard 不存在时回退 ui.html', async () => {
    process.env.CC_HTML_DIR = htmlOnlyUi;
    const res = await api('GET', '/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>cc-control</title>');
    expect(res.text).not.toContain('AWF Run');
  });

  it('TC3: GET / → 两者都不存在 → 500', async () => {
    process.env.CC_HTML_DIR = htmlEmpty;
    const res = await api('GET', '/');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'no page found' });
  });

  it('TC4: GET /ui → 返回 ui.html', async () => {
    const res = await api('GET', '/ui');
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/html');
    expect(res.text).toContain('cc-control');
  });

  it('TC5: GET /ui → 不存在 → 500', async () => {
    process.env.CC_HTML_DIR = htmlOnlyDash;
    const res = await api('GET', '/ui');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'ui.html not found' });
  });

  it('TC6: GET /awf/state → 200 + JSON', async () => {
    const res = await api('GET', '/awf/state');
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('application/json');
    expect(res.body.mode).toBe('run');
    expect(res.body.currentState).toBe('CODE');
    expect(res.body.tasks).toHaveLength(1);
  });

  it('TC7: GET /awf/state → 文件不存在 → 404', async () => {
    process.env.CC_PROJECT = projectNoState;
    const res = await api('GET', '/awf/state');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('state.json not found');
  });

  it('TC8: GET /status → 返回 state/session/decisionPending', async () => {
    const res = await api('GET', '/status');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.state).toBe('ready');
    expect(res.body.session).toBe(true);
    expect(res.body.decisionPending).toBeNull();
  });

  it('TC9: GET /status?snapshot=true → 包含 snapshot', async () => {
    const res = await api('GET', '/status?snapshot=true');
    expect(res.status).toBe(200);
    expect(res.body.snapshot).toBe('pane content');
    expect(res.body.state).toBe('ready');
    expect(m.tmux.capture).toHaveBeenCalled();
  });

  it('TC10: POST /send → 正常发送 prompt', async () => {
    const res = await api('POST', '/send', { text: 'do something' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sent: 'do something' });
    expect(m.logger.captureFromTranscript).toHaveBeenCalled();
    expect(m.logger.logPrompt).toHaveBeenCalledWith('do something');
    expect(m.tmux.sendText).toHaveBeenCalledWith('do something');
    expect(m.tmux.sendEnter).toHaveBeenCalled();
    expect(server._getState().state).toBe('busy');
  });

  it('TC11: POST /send → text 为空 → 400', async () => {
    const res = await api('POST', '/send', { text: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('body must be {text: non-empty string}');
    expect(m.tmux.sendText).not.toHaveBeenCalled();
  });

  it('TC12: POST /send → session 不存在 → 503', async () => {
    m.tmux.hasSession.mockReturnValue(false);
    const res = await api('POST', '/send', { text: 'hi' });
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('tmux session');
    expect(m.tmux.sendText).not.toHaveBeenCalled();
  });

  it('TC13: POST /send → waitReady 超时 → 409', async () => {
    await api('POST', '/hook', { event: 'UserPromptSubmit' }); // state = busy
    const started = Date.now();
    const res = await api('POST', '/send', { text: 'hi' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('still busy (ready timeout)');
    expect(Date.now() - started).toBeGreaterThanOrEqual(250); // READY_TIMEOUT=300
    expect(m.tmux.sendText).not.toHaveBeenCalled();
  });

  it('TC14: POST /cmd → 正常发送命令', async () => {
    const res = await api('POST', '/cmd', { cmd: '/clear' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sent: '/clear' });
    expect(m.tmux.sendText).toHaveBeenCalledWith('/clear');
    expect(server._getState().state).toBe('busy');
    // LOCAL_CMD fallback(60ms) 恢复 ready
    await sleep(120);
    expect(server._getState().state).toBe('ready');
  });

  it('TC15: POST /cmd → cmd 为空 → 400', async () => {
    const res = await api('POST', '/cmd', {});
    expect(res.status).toBe(400);
    expect(m.tmux.sendText).not.toHaveBeenCalled();
  });

  it('TC16: POST /cmd → session 不存在 → 503', async () => {
    m.tmux.hasSession.mockReturnValue(false);
    const res = await api('POST', '/cmd', { cmd: '/clear' });
    expect(res.status).toBe(503);
    expect(m.tmux.sendText).not.toHaveBeenCalled();
  });

  it('TC17: POST /respond → 正常回应（跳过 waitReady）', async () => {
    await api('POST', '/choice', { question: 'Q', options: ['A', 'B'] });
    await api('POST', '/hook', { event: 'UserPromptSubmit' }); // state = busy
    const res = await api('POST', '/respond', { value: '1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sent: '1' });
    expect(m.logger.logChoice).toHaveBeenCalledWith('Q', '1');
    expect(m.tmux.sendText).toHaveBeenCalledWith('1');
  });

  it('TC18: POST /choice → 正常设置 decision', async () => {
    const res = await api('POST', '/choice', { question: '选择?', options: ['A', 'B'] });
    expect(res.status).toBe(200);
    const d = server._getState().decisionPending;
    expect(d.type).toBe('choice');
    expect(d.options).toEqual(['A', 'B']);
  });

  it('TC19: POST /ask → 正常设置 decision', async () => {
    const res = await api('POST', '/ask', { question: '输入?' });
    expect(res.status).toBe(200);
    const d = server._getState().decisionPending;
    expect(d.type).toBe('text');
    expect(d.question).toBe('输入?');
  });

  it('TC20: 未知路由 → 404', async () => {
    const res = await api('GET', '/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'not found' });
  });

  it('TC-CR1: POST /context-ready → 置位，/status 透出', async () => {
    const res = await api('POST', '/context-ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, contextReady: true });
    expect(server._getState().contextReady).toBe(true);
    const st = await api('GET', '/status');
    expect(st.body.contextReady).toBe(true);
  });

  it('TC-CR2: GET /context-ready → 返回标记并一次性消费（读后复位）', async () => {
    await api('POST', '/context-ready');
    const res1 = await api('GET', '/context-ready');
    expect(res1.body).toEqual({ ok: true, ready: true });
    expect(server._getState().contextReady).toBe(false); // 已消费
    const res2 = await api('GET', '/context-ready');
    expect(res2.body).toEqual({ ok: true, ready: false });
  });

  it('TC-CR3: GET /context-ready 未置位 → ready:false', async () => {
    const res = await api('GET', '/context-ready');
    expect(res.body).toEqual({ ok: true, ready: false });
  });
});

// ─────────────────────────────────────────────
// /stop 中断
// ─────────────────────────────────────────────

describe('/stop', () => {
  it('发送 Ctrl+C 并清除决策', async () => {
    server.setDecision({ type: 'choice', question: 'Q' });
    server.setBusy();
    const res = await api('POST', '/stop');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, stopped: true });
    expect(m.tmux.sendCtrlC).toHaveBeenCalled();
    expect(server._getState().decisionPending).toBeNull();
  });

  it('session 不存在 → 503', async () => {
    m.tmux.hasSession.mockReturnValue(false);
    const res = await api('POST', '/stop');
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('tmux session');
    expect(m.tmux.sendCtrlC).not.toHaveBeenCalled();
  });

  it('无 Stop hook 时 fallback 恢复 ready', async () => {
    server.setBusy();
    await api('POST', '/stop');
    expect(server._getState().state).toBe('busy'); // 立即仍是 busy，等 Stop hook 或 fallback
    await sleep(120); // LOCAL_CMD fallback = 60ms
    expect(server._getState().state).toBe('ready');
  });
});

// ─────────────────────────────────────────────
// 状态机（TC21–TC27）
// ─────────────────────────────────────────────

describe('状态机', () => {
  it('TC21: SessionStart → setReady 唤醒所有 waiters', async () => {
    server.setBusy();
    const p1 = server.waitReady(10000);
    const p2 = server.waitReady(10000);
    expect(server._getState().waiters).toHaveLength(2);

    const res = await api('POST', '/hook', { event: 'SessionStart' });
    expect(res.status).toBe(200);
    expect(await p1).toBe(true);
    expect(await p2).toBe(true);
    expect(server._getState().state).toBe('ready');
    expect(m.logger.resetTranscript).toHaveBeenCalled();
  });

  it('TC22: UserPromptSubmit → setBusy', async () => {
    const res = await api('POST', '/hook', { event: 'UserPromptSubmit' });
    expect(res.status).toBe(200);
    expect(server._getState().state).toBe('busy');
  });

  it('TC23: Stop → clearDecision + setReady', async () => {
    server.setDecision({ type: 'choice', question: 'Q' });
    server.setBusy();
    await api('POST', '/hook', { event: 'Stop' });
    expect(server._getState().decisionPending).toBeNull();
    expect(server._getState().state).toBe('ready');
    expect(m.logger.captureFromTranscript).toHaveBeenCalled();
  });

  it('TC24: ready→busy→ready 完整往返', async () => {
    await api('POST', '/send', { text: 'task' });
    let st = await api('GET', '/status');
    expect(st.body.state).toBe('busy');

    await api('POST', '/hook', { event: 'Stop' });
    st = await api('GET', '/status');
    expect(st.body.state).toBe('ready');
  });

  it('TC25: waitReady 当前 ready → 立即返回 true', async () => {
    const result = await server.waitReady(5000);
    expect(result).toBe(true);
    expect(server._getState().waiters).toHaveLength(0);
  });

  it('TC26: waitReady busy → setReady 后返回 true', async () => {
    server.setBusy();
    const p = server.waitReady(10000);
    setTimeout(() => server.setReady(), 30);
    expect(await p).toBe(true);
  });

  it('TC27: waitReady 超时 → false，waiter 移除', async () => {
    server.setBusy();
    const result = await server.waitReady(60);
    expect(result).toBe(false);
    expect(server._getState().waiters).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────
// /hook 事件（TC28–TC32）
// ─────────────────────────────────────────────

describe('/hook 事件', () => {
  it('TC28: /hook SessionStart → ready + resetTranscript', async () => {
    const res = await api('POST', '/hook', { event: 'SessionStart' });
    expect(res.body).toEqual({ ok: true, event: 'SessionStart', state: 'ready' });
    expect(m.logger.resetTranscript).toHaveBeenCalled();
  });

  it('TC29: /hook UserPromptSubmit → busy', async () => {
    const res = await api('POST', '/hook', { event: 'UserPromptSubmit' });
    expect(res.body).toEqual({ ok: true, event: 'UserPromptSubmit', state: 'busy' });
  });

  it('TC30: /hook Stop → clearDecision + ready', async () => {
    server.setDecision({ type: 'choice', question: 'Q' });
    server.setBusy();
    const res = await api('POST', '/hook', { event: 'Stop' });
    expect(res.body.state).toBe('ready');
    expect(server._getState().decisionPending).toBeNull();
  });

  it('TC31: /hook PreToolUse AskUserQuestion → setDecision', async () => {
    await api('POST', '/hook', {
      event: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [{ question: '选择方案', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }],
      },
    });
    const d = server._getState().decisionPending;
    expect(d.source).toBe('AskUserQuestion');
    expect(d.question).toBe('选择方案');
    expect(d.options).toEqual(['A', 'B']);
    expect(d.type).toBe('choice');
  });

  it('TC32: /hook PostToolUse AskUserQuestion → 更新 answer', async () => {
    await api('POST', '/hook', {
      event: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: '选择方案', options: [{ label: 'A' }, { label: 'B' }] }] },
    });
    await api('POST', '/hook', {
      event: 'PostToolUse',
      tool_name: 'AskUserQuestion',
      tool_response: { answer: 'A方案' },
    });
    const d = server._getState().decisionPending;
    expect(d.answer).toBe('A方案');
    expect(d.answered).toBe(true);
  });

  // ── M2: mainSessionId 隔离 + 子 agent 观测 ──

  it('TC33: SessionStart 透传 payload → 记录 mainSessionId', async () => {
    await api('POST', '/hook', { event: 'SessionStart', session_id: 'sess-main' });
    expect(server._getState().mainSessionId).toBe('sess-main');
    expect(server._getState().state).toBe('ready');
  });

  it('TC34: 子 agent 的 UserPromptSubmit（非主 session_id）不翻转主闩锁', async () => {
    await api('POST', '/hook', { event: 'SessionStart', session_id: 'sess-main' });
    const res = await api('POST', '/hook', { event: 'UserPromptSubmit', session_id: 'sess-sub' });
    expect(res.body.state).toBe('ready'); // 子 agent 事件被过滤
    expect(server._getState().state).toBe('ready');
  });

  it('TC35: 主 session 才驱动 busy/ready；子 agent Stop 不提前置 ready', async () => {
    await api('POST', '/hook', { event: 'SessionStart', session_id: 'sess-main' });
    await api('POST', '/hook', { event: 'UserPromptSubmit', session_id: 'sess-main' });
    expect(server._getState().state).toBe('busy');
    // 子 agent Stop（子 session）→ 不置 ready，仍 busy（闩锁只认主）
    await api('POST', '/hook', { event: 'Stop', session_id: 'sess-sub' });
    expect(server._getState().state).toBe('busy');
    // 主 Stop → ready
    await api('POST', '/hook', { event: 'Stop', session_id: 'sess-main' });
    expect(server._getState().state).toBe('ready');
  });

  it('TC36: SubagentStart/Stop 只进观测 registry，不驱动主闩锁', async () => {
    await api('POST', '/hook', { event: 'SubagentStart', session_id: 'sess-sub' });
    expect(server._getState().activeAgents).toBe(1);
    expect(server._getState().state).toBe('ready'); // 不翻转
    await api('POST', '/hook', { event: 'SubagentStop', session_id: 'sess-sub' });
    expect(server._getState().activeAgents).toBe(0);
  });

  it('TC37: /status 暴露 mainSessionId 与 activeAgents', async () => {
    await api('POST', '/hook', { event: 'SessionStart', session_id: 'sess-main' });
    await api('POST', '/hook', { event: 'SubagentStart', session_id: 'sess-sub' });
    const res = await api('GET', '/status');
    expect(res.body.mainSessionId).toBe('sess-main');
    expect(res.body.activeAgents).toBe(1);
  });

  // ── M2+: SubagentStop 落账（解析 last_assistant_message 的 RESULT → 写 state）──

  it('TC38: SubagentStop 落账——解析 RESULT 写 state（done + exec）', async () => {
    fs.writeFileSync(path.join(projectWithState, '.awf', 'state.json'), JSON.stringify({
      mode: 'run', currentState: 'CODE', tasks: [{ id: 'T1', status: 'pending' }],
    }));
    await api('POST', '/hook', {
      event: 'SubagentStop', session_id: 'sess-main', agent_id: 'agent-1',
      last_assistant_message: '完成。\n\nRESULT: {"taskId": "T1", "status": "done", "result": "做完了", "files": ["a.js"]}',
    });
    const s = JSON.parse(fs.readFileSync(path.join(projectWithState, '.awf', 'state.json'), 'utf-8'));
    expect(s.tasks[0].status).toBe('done');
    expect(s.tasks[0].exec).toEqual({ result: '做完了', files: ['a.js'] });
  });

  it('TC39: SubagentStop 无有效 RESULT → 不落账，state 不变', async () => {
    fs.writeFileSync(path.join(projectWithState, '.awf', 'state.json'), JSON.stringify({
      mode: 'run', currentState: 'CODE', tasks: [{ id: 'T1', status: 'pending' }],
    }));
    await api('POST', '/hook', {
      event: 'SubagentStop', session_id: 'sess-main', agent_id: 'agent-1',
      last_assistant_message: '我没按格式输出',
    });
    const s = JSON.parse(fs.readFileSync(path.join(projectWithState, '.awf', 'state.json'), 'utf-8'));
    expect(s.tasks[0].status).toBe('pending');
  });

  it('TC40: SubagentStop 落账失败（taskId 不存在）→ 写 subagent-failed.jsonl（补发依据）', async () => {
    fs.writeFileSync(path.join(projectWithState, '.awf', 'state.json'), JSON.stringify({
      mode: 'run', currentState: 'CODE', tasks: [{ id: 'T1', status: 'pending' }],
    }));
    await api('POST', '/hook', {
      event: 'SubagentStop', session_id: 'sess-main', agent_id: 'agent-bad',
      last_assistant_message: 'RESULT: {"taskId": "T999", "status": "done"}', // taskId 不存在
    });
    const logPath = path.join(projectWithState, '.awf', 'logs', 'subagent-failed.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);
    const rec = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim().split('\n').pop());
    expect(rec.agentId).toBe('agent-bad');
    expect(rec.resultTaskId).toBe('T999');
    expect(rec.reason).toContain('not found');
    // state 不变（落账失败）
    const s = JSON.parse(fs.readFileSync(path.join(projectWithState, '.awf', 'state.json'), 'utf-8'));
    expect(s.tasks[0].status).toBe('pending');
  });

  it('TC41: RESULT taskId 指向已 done 任务 → 拒绝 + 写失败记录（防错标假成功）', async () => {
    fs.writeFileSync(path.join(projectWithState, '.awf', 'state.json'), JSON.stringify({
      mode: 'run', currentState: 'CODE',
      tasks: [
        { id: 'T3', status: 'done' },               // 已完成（子 Agent 误把 taskId 写到这里）
        { id: 'X1', status: 'pending' },            // 真实任务，应落账
      ],
    }));
    await api('POST', '/hook', {
      event: 'SubagentStop', session_id: 'sess-main', agent_id: 'agent-x1',
      last_assistant_message: 'RESULT: {"taskId": "T3", "status": "done", "result": "创建 test/util.test.js"}', // 错写 T3
    });
    // T3 未被二次覆盖；X1 仍 pending（落账拒绝）
    const s = JSON.parse(fs.readFileSync(path.join(projectWithState, '.awf', 'state.json'), 'utf-8'));
    expect(s.tasks.find((t) => t.id === 'T3').status).toBe('done');
    expect(s.tasks.find((t) => t.id === 'X1').status).toBe('pending');
    // 失败记录（补发依据）
    const logPath = path.join(projectWithState, '.awf', 'logs', 'subagent-failed.jsonl');
    const rec = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim().split('\n').pop());
    expect(rec.agentId).toBe('agent-x1');
    expect(rec.resultTaskId).toBe('T3');
    expect(rec.reason).toContain('already done');
  });
});

// ─────────────────────────────────────────────
// dashboard.html（TC33–TC37）
// ─────────────────────────────────────────────

describe('dashboard.html', () => {
  let html;

  beforeAll(() => {
    html = fs.readFileSync(DASHBOARD_PATH, 'utf-8');
  });

  it('TC33: 文件存在且非空', () => {
    expect(fs.existsSync(DASHBOARD_PATH)).toBe(true);
    expect(fs.statSync(DASHBOARD_PATH).size).toBeGreaterThan(0);
  });

  it('TC34: 关键 DOM 元素', () => {
    const ids = ['projectName', 'currentPhase', 'progress', 'phaseChain', 'taskList', 'output', 'connStatus', 'errorBar'];
    for (const id of ids) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('TC35: PHASES 数组含 7 个权威阶段', () => {
    const match = html.match(/const PHASES = \[([^\]]*)\]/);
    expect(match).not.toBeNull();
    const phases = match[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(phases).toEqual(['PLAN', 'DESIGN', 'CODE', 'REVIEW', 'TEST', 'COMMIT', 'FINISH']);
    expect(phases).toHaveLength(7);
  });

  it('TC36: canon 函数逻辑（DEBUG/DOCS/DEV 归一化到 CODE）', () => {
    const match = html.match(/function canon\(p\) \{([\s\S]*?)\n\}/);
    expect(match).not.toBeNull();
    const canon = new Function('p', match[1]);
    expect(canon('CODE')).toBe('CODE');
    expect(canon('DEBUG')).toBe('CODE');
    expect(canon('DOCS')).toBe('CODE');
    expect(canon('DEV')).toBe('CODE');
    expect(canon('PLAN')).toBe('PLAN');
    expect(canon('REVIEW')).toBe('REVIEW');
    expect(canon('IDLE')).toBe('IDLE');
  });

  it('TC37: refresh 行为（fetch 调用 + 离线处理 + 去重 + setInterval）', () => {
    // 静态分析 refresh() 源码中的关键行为
    expect(html).toContain("const sr = await fetch('/awf/state')");
    expect(html).toContain("const ssr = await fetch('/status?snapshot=true')");
    expect(html).toContain("textContent = '离线'");
    expect(html).toContain('ss.snapshot !== lastSnapshot');
    expect(html).toContain('setInterval(refresh, 2000)');
  });

  it('TC38: 发送按钮 busy 时切换停止（/stop + handleSendOrStop）', () => {
    expect(html).toContain('handleSendOrStop');
    expect(html).toContain("fetch('/stop', { method: 'POST' })");
    expect(html).toContain('renderSendButton');
    expect(html).toContain("isBusy = !!ok && !!ss.session && ss.state === 'busy'");
  });
});
