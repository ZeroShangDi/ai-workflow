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
  JSON.stringify({ mode: 'run', version: '0.1.0', currentState: 'CODE', plan: { tasks: [{ id: 'T1', status: 'done' }] } }),
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
    expect(res.body.plan.tasks).toHaveLength(1);
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

  it('TC35: PHASES 数组含 8 个阶段', () => {
    const match = html.match(/const PHASES = \[([^\]]*)\]/);
    expect(match).not.toBeNull();
    const phases = match[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(phases).toEqual(['PLAN', 'DESIGN', 'CODE', 'DEV', 'REVIEW', 'TEST', 'COMMIT', 'FINISH']);
    expect(phases).toHaveLength(8);
  });

  it('TC36: canon 函数逻辑', () => {
    const match = html.match(/function canon\(p\) \{([\s\S]*?)\n\}/);
    expect(match).not.toBeNull();
    const canon = new Function('p', match[1]);
    expect(canon('CODE')).toBe('DEV');
    expect(canon('DEBUG')).toBe('DEV');
    expect(canon('DOCS')).toBe('DEV');
    expect(canon('PLAN')).toBe('PLAN');
    expect(canon('REVIEW')).toBe('REVIEW');
  });

  it('TC37: refresh 行为（fetch 调用 + 离线处理 + 去重 + setInterval）', () => {
    // 静态分析 refresh() 源码中的关键行为
    expect(html).toContain("const sr = await fetch('/awf/state')");
    expect(html).toContain("const ssr = await fetch('/status?snapshot=true')");
    expect(html).toContain("textContent = '离线'");
    expect(html).toContain('ss.snapshot !== lastSnapshot');
    expect(html).toContain('setInterval(refresh, 2000)');
  });
});
