import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';

// ── mocks：注入到 server.cjs（vitest 无法 mock 被原生 require 的 CJS 依赖，用注入钩子）──

const m = {
  tmux: {
    hasSession: vi.fn(() => true),
    sendText: vi.fn(),
    sendEnter: vi.fn(),
    capture: vi.fn(() => 'mock pane content'),
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

// ── env + 注入：必须在 import server.cjs 之前设置（模块顶层读取）──
process.env.CC_PROJECT = '/tmp/cc-decision-test';
process.env.CC_READY_TIMEOUT_MS = '300';       // 加速 waitReady 超时路径
process.env.CC_ENTER_DELAY_MS = '0';           // submit 不等待
process.env.CC_LOCAL_CMD_MS = '60';            // 无 decision 的 fallback
process.env.CC_DECISION_FALLBACK_MS = '60';    // 有 decision 的 fallback（默认 5min）

global.__CC_TMUX__ = m.tmux;
global.__CC_RUNLOGGER__ = { RunLogger: MockRunLogger };

const SERVER_PATH = fileURLToPath(new URL('../../src/server/server.cjs', import.meta.url));

let server;      // server.cjs 导出的状态机函数 + start/stop
let api;         // HTTP 请求助手

function makeApi(base) {
  return async function (method, path, body) {
    const headers = { connection: 'close' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text };
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
  for (const k of ['CC_PROJECT', 'CC_READY_TIMEOUT_MS', 'CC_ENTER_DELAY_MS', 'CC_LOCAL_CMD_MS', 'CC_DECISION_FALLBACK_MS']) {
    delete process.env[k];
  }
});

beforeEach(() => {
  server._resetForTest();
  vi.clearAllMocks();
  m.tmux.hasSession.mockReturnValue(true);
});

// ─────────────────────────────────────────────
// decision 状态机（TC5–TC10，直接调用导出函数）
// ─────────────────────────────────────────────

describe('decision 状态机', () => {
  it('TC5: setDecision / clearDecision 正确设置/清空', () => {
    server.setDecision({ type: 'choice', question: 'Q' });
    expect(server._getState().decisionPending).toEqual({ type: 'choice', question: 'Q' });
    server.clearDecision();
    expect(server._getState().decisionPending).toBeNull();
  });

  it('TC6: setReady 唤醒所有 waiters', async () => {
    server.setBusy();
    const ps = [server.waitReady(10000), server.waitReady(10000), server.waitReady(10000)];
    expect(server._getState().waiters).toHaveLength(3);

    server.setReady();
    expect(await Promise.all(ps)).toEqual([true, true, true]);
    expect(server._getState().waiters).toHaveLength(0);
    expect(server._getState().state).toBe('ready');
  });

  it('TC7: waitReady — 当前 ready 立即返回 true', async () => {
    const result = await server.waitReady(5000);
    expect(result).toBe(true);
    expect(server._getState().waiters).toHaveLength(0);
  });

  it('TC8: waitReady — 当前 busy → setReady 后唤醒', async () => {
    server.setBusy();
    const p = server.waitReady(10000);
    setTimeout(() => server.setReady(), 30);
    expect(await p).toBe(true);
  });

  it('TC9: waitReady — 超时未唤醒 → false，waiter 移除', async () => {
    server.setBusy();
    const result = await server.waitReady(60);
    expect(result).toBe(false);
    expect(server._getState().waiters).toHaveLength(0);
  });

  it('TC10: setBusy → state=busy', () => {
    server.setBusy();
    expect(server._getState().state).toBe('busy');
  });
});

// ─────────────────────────────────────────────
// /hook 路由（TC11–TC17）
// ─────────────────────────────────────────────

describe('/hook 路由', () => {
  it('TC11: SessionStart → setReady + resetTranscript', async () => {
    server.setBusy();
    const res = await api('POST', '/hook', { event: 'SessionStart' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, event: 'SessionStart', state: 'ready' });
    expect(server._getState().state).toBe('ready');
    expect(m.logger.resetTranscript).toHaveBeenCalled();
  });

  it('TC12: UserPromptSubmit → setBusy', async () => {
    const res = await api('POST', '/hook', { event: 'UserPromptSubmit' });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('busy');
    expect(server._getState().state).toBe('busy');
  });

  it('TC13: Stop → clearDecision + setReady + captureTranscript', async () => {
    server.setDecision({ type: 'choice', question: 'Q', options: ['A'] });
    server.setBusy();
    const res = await api('POST', '/hook', { event: 'Stop' });
    expect(res.status).toBe(200);
    expect(server._getState().decisionPending).toBeNull();
    expect(server._getState().state).toBe('ready');
    expect(m.logger.captureFromTranscript).toHaveBeenCalled();
  });

  it('TC14: PreToolUse AskUserQuestion → setDecision', async () => {
    const res = await api('POST', '/hook', {
      event: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [{
          question: '选择方案',
          multiSelect: false,
          options: [{ label: '方案A' }, { label: '方案B' }],
          header: '方案选择',
        }],
      },
    });
    expect(res.status).toBe(200);
    expect(server._getState().decisionPending).toEqual({
      type: 'choice',
      multiSelect: false,
      question: '选择方案',
      options: ['方案A', '方案B'],
      header: '方案选择',
      source: 'AskUserQuestion',
    });
  });

  // 前置：先通过 PreToolUse 建立一个 source=AskUserQuestion 的 decision
  async function seedAskUserQuestion() {
    await api('POST', '/hook', {
      event: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: '选择方案', options: [{ label: '方案A' }, { label: '方案B' }] }] },
    });
  }

  it('TC15: PostToolUse 已回答 → answer + answered，原字段保留', async () => {
    await seedAskUserQuestion();
    const res = await api('POST', '/hook', {
      event: 'PostToolUse',
      tool_name: 'AskUserQuestion',
      tool_response: { answer: '方案A' },
    });
    expect(res.status).toBe(200);
    const d = server._getState().decisionPending;
    expect(d.answer).toBe('方案A');
    expect(d.answered).toBe(true);
    expect(d.type).toBe('choice');
    expect(d.question).toBe('选择方案');
    expect(d.source).toBe('AskUserQuestion');
  });

  it('TC16: PostToolUse tool_response 为 string', async () => {
    await seedAskUserQuestion();
    await api('POST', '/hook', {
      event: 'PostToolUse',
      tool_name: 'AskUserQuestion',
      tool_response: '直接答案',
    });
    expect(server._getState().decisionPending.answer).toBe('直接答案');
  });

  it('TC17: PostToolUse tool_response 为 {answers:{}} → join values', async () => {
    await seedAskUserQuestion();
    await api('POST', '/hook', {
      event: 'PostToolUse',
      tool_name: 'AskUserQuestion',
      tool_response: { answers: { q1: 'A', q2: 'B' } },
    });
    expect(server._getState().decisionPending.answer).toBe('A, B');
  });
});

// ─────────────────────────────────────────────
// /choice /ask /respond 路由（TC18–TC25）
// ─────────────────────────────────────────────

describe('/choice /ask /respond 路由', () => {
  it('TC18: /choice 正常设置 decision', async () => {
    const res = await api('POST', '/choice', { question: '选择方案', options: ['A', 'B'], context: 'ctx' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(server._getState().decisionPending).toEqual({
      type: 'choice',
      question: '选择方案',
      options: ['A', 'B'],
      context: 'ctx',
    });
  });

  it('TC19: /choice question 为空 → 400', async () => {
    const res = await api('POST', '/choice', { options: ['A'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(server._getState().decisionPending).toBeNull();
  });

  it('TC20: /ask 正常设置 decision(type=text)', async () => {
    const res = await api('POST', '/ask', { question: '请输入名称', context: '可选' });
    expect(res.status).toBe(200);
    const d = server._getState().decisionPending;
    expect(d.type).toBe('text');
    expect(d.question).toBe('请输入名称');
    expect(d.context).toBe('可选');
    expect(d).not.toHaveProperty('options');
  });

  it('TC21: /ask question 为空 → 400', async () => {
    const res = await api('POST', '/ask', {});
    expect(res.status).toBe(400);
  });

  it('TC22: /respond 有 decisionPending → 跳过 waitReady', async () => {
    await api('POST', '/choice', { question: 'Q', options: ['A', 'B'] });
    await api('POST', '/hook', { event: 'UserPromptSubmit' }); // state = busy
    const res = await api('POST', '/respond', { value: '1' });
    // 若未跳过 waitReady：busy 状态下会等 READY_TIMEOUT(300ms) 后返回 409
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sent: '1' });
    expect(m.tmux.sendText).toHaveBeenCalledWith('1');
    expect(m.tmux.sendEnter).toHaveBeenCalled();
    expect(m.logger.logChoice).toHaveBeenCalledWith('Q', '1');
  });

  it('TC23: /respond 无 decisionPending → 正常 waitReady', async () => {
    const res = await api('POST', '/respond', { value: 'done' });
    expect(res.status).toBe(200);
    expect(m.tmux.sendText).toHaveBeenCalledWith('done');
    expect(m.logger.logChoice).not.toHaveBeenCalled();
    // LOCAL_CMD fallback(60ms) 恢复 ready
    await sleep(120);
    expect(server._getState().state).toBe('ready');
  });

  it('TC23b: /respond 无 decision 且 state=busy → waitReady 超时返回 409', async () => {
    await api('POST', '/hook', { event: 'UserPromptSubmit' }); // state = busy
    const res = await api('POST', '/respond', { value: 'cmd' });
    expect(res.status).toBe(409);
    expect(m.tmux.sendText).not.toHaveBeenCalled();
  });

  it('TC24: /respond value 为空 → clearDecision + 400', async () => {
    await api('POST', '/choice', { question: 'Q', options: ['A'] });
    const res = await api('POST', '/respond', { value: '' });
    expect(res.status).toBe(400);
    expect(server._getState().decisionPending).toBeNull();
    expect(m.tmux.sendText).not.toHaveBeenCalled();
  });

  it('TC25: /respond session 不存在 → 503', async () => {
    await api('POST', '/choice', { question: 'Q', options: ['A'] });
    m.tmux.hasSession.mockReturnValue(false);
    const res = await api('POST', '/respond', { value: '1' });
    expect(res.status).toBe(503);
    expect(server._getState().decisionPending).toBeNull();
    expect(m.tmux.sendText).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// 完整链路（TC26–TC28）
// ─────────────────────────────────────────────

describe('完整链路', () => {
  it('TC26: AskUserQuestion 完整闭环', async () => {
    // 1. PreToolUse → decision
    const h = await api('POST', '/hook', {
      event: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: '选择方案', options: [{ label: 'A' }, { label: 'B' }] }] },
    });
    expect(h.status).toBe(200);
    expect(server._getState().decisionPending.source).toBe('AskUserQuestion');

    // 2. /status 暴露 decisionPending
    const st = await api('GET', '/status');
    expect(st.body.decisionPending).not.toBeNull();

    // 3. /respond（有 decision → 跳过 waitReady）
    const r = await api('POST', '/respond', { value: '1' });
    expect(r.status).toBe(200);
    expect(m.tmux.sendText).toHaveBeenCalledWith('1');

    // 4. Stop → 清理
    await api('POST', '/hook', { event: 'Stop' });
    expect(server._getState().state).toBe('ready');
    expect(server._getState().decisionPending).toBeNull();
  });

  it('TC27: /choice → /respond 闭环', async () => {
    const c = await api('POST', '/choice', { question: 'Q', options: ['A', 'B'] });
    expect(c.status).toBe(200);

    const st = await api('GET', '/status');
    expect(st.body.decisionPending.type).toBe('choice');

    const r = await api('POST', '/respond', { value: 'A' });
    expect(r.status).toBe(200);
    expect(m.tmux.sendText).toHaveBeenCalledWith('A');

    await api('POST', '/hook', { event: 'Stop' });
    expect(server._getState().decisionPending).toBeNull();
  });

  it('TC28: /ask(text) → /respond 闭环', async () => {
    const a = await api('POST', '/ask', { question: '输入名称' });
    expect(a.status).toBe(200);

    const st = await api('GET', '/status');
    expect(st.body.decisionPending.type).toBe('text');

    const r = await api('POST', '/respond', { value: 'myname' });
    expect(r.status).toBe(200);
    expect(m.tmux.sendText).toHaveBeenCalledWith('myname');
  });
});

// ─────────────────────────────────────────────
// 边界：fallback timer + /status（TC29–TC31）
// ─────────────────────────────────────────────

describe('边界', () => {
  it('TC29: /respond fallback — 有 decision → 恢复 ready + clearDecision', async () => {
    await api('POST', '/choice', { question: 'Q', options: ['A'] });
    const r = await api('POST', '/respond', { value: '1' });
    expect(r.status).toBe(200);
    expect(server._getState().state).toBe('busy'); // Stop 未到，fallback 兜底

    await sleep(120); // DECISION_FALLBACK_MS=60 已触发
    expect(server._getState().state).toBe('ready');
    expect(server._getState().decisionPending).toBeNull();
  });

  it('TC30: /respond fallback — 无 decision → 恢复 ready，不清 decision', async () => {
    const r = await api('POST', '/respond', { value: 'cmd' });
    expect(r.status).toBe(200);
    expect(server._getState().decisionPending).toBeNull();

    await sleep(120); // LOCAL_CMD_FALLBACK_MS=60 已触发
    expect(server._getState().state).toBe('ready');
    expect(server._getState().decisionPending).toBeNull();
  });

  it('TC31: /status 返回 decisionPending 字段', async () => {
    await api('POST', '/choice', { question: '测试', options: ['A'] });
    await api('POST', '/hook', { event: 'UserPromptSubmit' });

    const res = await api('GET', '/status');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('busy');
    expect(res.body.decisionPending).not.toBeNull();
    expect(res.body.decisionPending.question).toBe('测试');
    expect(res.body.decisionPending.options).toEqual(['A']);
  });
});
