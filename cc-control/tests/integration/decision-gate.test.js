import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { makeApi } from '../helpers/http-api.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findNextTask } from '../../src/lib/state.js';

// ── mocks：注入到 server.cjs（原生 require 的 CJS 依赖无法用 vi.mock 拦截）──
const m = {
  tmux: {
    hasSession: vi.fn(() => true),
    sendText: vi.fn(),
    sendEnter: vi.fn(),
    sendCtrlC: vi.fn(),
    capture: vi.fn(() => 'pane'),
    SESSION: 'cc',
  },
  logger: {
    resetTranscript: vi.fn(),
    captureFromTranscript: vi.fn(),
    captureSubagentTranscript: vi.fn(),
    logChoice: vi.fn(),
    logPrompt: vi.fn(),
    logDecision: vi.fn(),
  },
};

class MockRunLogger {
  constructor() {}
  get enabled() { return false; }
  get path() { return ''; }
  resetTranscript() { m.logger.resetTranscript(); }
  captureFromTranscript() { m.logger.captureFromTranscript(); }
  captureSubagentTranscript(...a) { m.logger.captureSubagentTranscript(...a); }
  logChoice(...a) { m.logger.logChoice(...a); }
  logPrompt(...a) { m.logger.logPrompt(...a); }
  logDecision(...a) { m.logger.logDecision(...a); }
}

// ── 临时项目：state(version) + logs/<runStamp>（决策 store 据此对齐）+ config 可切换 ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-decision-gate-'));
const PROJ = path.join(TMP, 'proj');
const RUN_STAMP = '0.2.0-2026-09-07T00-50-00';
fs.mkdirSync(path.join(PROJ, '.awf', 'logs', RUN_STAMP, 'agents'), { recursive: true });
fs.writeFileSync(path.join(PROJ, '.awf', 'state.json'), JSON.stringify({ mode: 'run', version: '0.2.0' }));

function writeGate(on) {
  fs.writeFileSync(
    path.join(PROJ, '.awf', 'config.json'),
    JSON.stringify({ run: { agents: { max: 1 }, decision: { enabled: on } } }),
  );
}

process.env.CC_PROJECT = PROJ;
process.env.HOME = path.join(TMP, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
global.__CC_TMUX__ = m.tmux;
global.__CC_RUNLOGGER__ = { RunLogger: MockRunLogger };
global.__CC_RUN_DIAGNOSIS__ = { buildDiagnosisPrompt: () => '', diagnoseWithClaude: m.diagnose = vi.fn(), readDiagnosis: () => null, writeDiagnosis: () => {} };

const SERVER_PATH = fileURLToPath(new URL('../../src/server/server.cjs', import.meta.url));
const RUNS_DIR = path.join(PROJ, '.awf', 'decisions', 'runs');
const RUN_FILE = path.join(RUNS_DIR, `${RUN_STAMP}.jsonl`);

let server;
let api;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const mod = await import(SERVER_PATH);
  server = mod;
  const { url } = await server.start(0);
  api = makeApi(url, PROJ);
  writeGate(false);
});

afterAll(async () => {
  await server?.stop();
  for (const k of ['CC_PROJECT', 'HOME']) delete process.env[k];
  for (const g of ['__CC_TMUX__', '__CC_RUNLOGGER__', '__CC_RUN_DIAGNOSIS__']) delete global[g];
  fs.rmSync(TMP, { recursive: true, force: true });
});

// T1-118：本仓库可能已构建 src/server/public；断言 legacy 观测页的用例须钉住「未构建」态
const EMPTY_WEB_DIR = path.join(TMP, 'empty-web');
fs.mkdirSync(EMPTY_WEB_DIR, { recursive: true });

beforeEach(() => {
  process.env.CC_WEB_PUBLIC = EMPTY_WEB_DIR;
  server._resetForTest();
  vi.clearAllMocks();
  m.tmux.hasSession.mockReturnValue(true);
  fs.rmSync(RUNS_DIR, { recursive: true, force: true }); // 每个场景从空 store 开始
  // state 任务表复位（纠偏任务断言需从空开始，避免跨用例残留 pending 干扰 findNextTask）
  fs.writeFileSync(path.join(PROJ, '.awf', 'state.json'), JSON.stringify({ mode: 'run', version: '0.2.0', tasks: [] }));
});

async function registerMain() {
  await api('POST', '/hook', { event: 'SessionStart', session_id: 'sess-main' });
}

async function setBusy() {
  await api('POST', '/hook', { event: 'UserPromptSubmit', session_id: 'sess-main' });
}

function stopPayload(extra) {
  return api('POST', '/hook', { event: 'Stop', session_id: 'sess-main', ...extra });
}

function readDecisionLines() {
  if (!fs.existsSync(RUN_FILE)) return [];
  return fs.readFileSync(RUN_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const REQ_TAG = (q) => `请决定：<AWF_DECISION_REQUIRED>${q}</AWF_DECISION_REQUIRED>`;

function resultMessage(overrides = {}) {
  const result = {
    answer: '先做可逆验证再定',
    type: 'resolved',
    finality: 'final',
    real_question: '真正要决定的行动',
    decisive_factors: ['可逆性'],
    reconsider_when: ['新事实出现时'],
    ...overrides,
  };
  return `分析完成。\n<AWF_DECISION_RESULT>\n${JSON.stringify(result)}\n</AWF_DECISION_RESULT>`;
}

describe('decision gate — Stop 统一闸门', () => {
  it('gate off：含必需标记的 Stop 也走现状（ready + 采集，无 ccOutput、无落盘）', async () => {
    writeGate(false);
    await registerMain();
    await setBusy();
    const res = await stopPayload({ last_assistant_message: REQ_TAG('A or B?'), stop_hook_active: false });

    expect(res.body.ccOutput).toBeUndefined();
    expect((await api('GET', '/status')).body.state).toBe('ready');
    expect(server._getState().decisionGate).toBeNull();
    expect(m.logger.captureFromTranscript).toHaveBeenCalled();
    expect(readDecisionLines()).toHaveLength(0);
  });

  it('gate on ① 普通完成：不触发、不落盘、ready', async () => {
    writeGate(true);
    await registerMain();
    await setBusy();
    const res = await stopPayload({ last_assistant_message: '普通任务完成', stop_hook_active: false });

    expect(res.body.ccOutput).toBeUndefined();
    expect(server._getState().decisionGate).toBeNull();
    expect((await api('GET', '/status')).body.state).toBe('ready');
    expect(readDecisionLines()).toHaveLength(0);
  });

  it('gate on ② 触发：结尾含 <AWF_DECISION_REQUIRED> 且 !stop_hook_active → deciding + block ccOutput（reason=指令），busy 不翻转', async () => {
    writeGate(true);
    await registerMain();
    await setBusy();
    const res = await stopPayload({ last_assistant_message: REQ_TAG('选 A 还是 B？'), stop_hook_active: false });

    expect(res.body.ccOutput.decision).toBe('block');
    expect(res.body.ccOutput.reason).toContain('AWF_DECISION_RESULT');
    expect(res.body.ccOutput.reason).toContain('禁止再向用户提问');
    // 不 setReady：busy 延续（deciding）
    const st = server._getState();
    expect(st.decisionGate.phase).toBe('deciding');
    expect(st.state).toBe('busy');
    expect((await api('GET', '/status')).body.decisionGate.phase).toBe('deciding');
    // 尚未落盘
    expect(readDecisionLines()).toHaveLength(0);
  });

  it('gate on ③a 结果收尾：deciding 中 Stop 含有效 <AWF_DECISION_RESULT> → 落盘 + decisionResume + ready', async () => {
    writeGate(true);
    await registerMain();
    await setBusy();
    await stopPayload({ last_assistant_message: REQ_TAG('选 A 还是 B？'), stop_hook_active: false }); // 触发
    const res = await stopPayload({ last_assistant_message: resultMessage(), stop_hook_active: true });

    expect(res.body.ccOutput).toBeUndefined();
    const st = server._getState();
    expect(st.decisionGate).toBeNull();
    expect(st.state).toBe('ready');
    expect(st.decisionResume).toMatchObject({ type: 'resolved', answer: '先做可逆验证再定', fallback: false });
    expect(st.decisionResume.decision_id).toBeTruthy();

    const lines = readDecisionLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ status: 'pending_review', source: 'text' });
    expect(lines[0].result.answer).toBe('先做可逆验证再定');
    expect(lines[0].decision_id).toBe(st.decisionResume.decision_id);
  });

  it('gate on ③b 兜底：deciding 中 Stop 无有效结果 → deferred fallback 落盘 + decisionResume(fallback) + ready', async () => {
    writeGate(true);
    await registerMain();
    await setBusy();
    await stopPayload({ last_assistant_message: REQ_TAG('选 A 还是 B？'), stop_hook_active: false }); // 触发
    const res = await stopPayload({ last_assistant_message: '抱歉我无法完成该决策', stop_hook_active: true });

    expect(res.body.ccOutput).toBeUndefined();
    const st = server._getState();
    expect(st.decisionGate).toBeNull();
    expect(st.state).toBe('ready');
    expect(st.decisionResume.fallback).toBe(true);

    const lines = readDecisionLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].result).toMatchObject({ type: 'deferred', finality: 'provisional', fallback: true });
  });

  it('/status 暴露 decisionGate 与 decisionResume（空态/触发/闭合）', async () => {
    writeGate(true);
    await registerMain();
    const idle = (await api('GET', '/status')).body;
    expect(idle.decisionGate).toBeNull();
    expect(idle.decisionResume).toBeNull();

    await setBusy();
    await stopPayload({ last_assistant_message: REQ_TAG('q'), stop_hook_active: false });
    const during = (await api('GET', '/status')).body;
    expect(during.decisionGate.phase).toBe('deciding');

    await stopPayload({ last_assistant_message: resultMessage(), stop_hook_active: true });
    const done = (await api('GET', '/status')).body;
    expect(done.decisionGate).toBeNull();
    expect(done.decisionResume.decision_id).toBeTruthy();
    expect(done.state).toBe('ready');
  });

  it('防递归/防双捕获：结果已落盘后重复同 decision Stop 不重复落盘（幂等）', async () => {
    writeGate(true);
    await registerMain();
    await setBusy();
    await stopPayload({ last_assistant_message: REQ_TAG('q'), stop_hook_active: false });
    await stopPayload({ last_assistant_message: resultMessage(), stop_hook_active: true });
    // 同一事务不会再次进入 deciding；普通后续 Stop → ready，无新增行
    await stopPayload({ last_assistant_message: resultMessage(), stop_hook_active: false });
    expect(readDecisionLines()).toHaveLength(1);
  });
});

describe('decision gate — PreToolUse(AskUserQuestion) 决策化', () => {
  const ASK_BODY = {
    event: 'PreToolUse',
    session_id: 'sess-main',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: '选哪个方案？', options: [{ label: 'A' }, { label: 'B' }] }] },
  };
  const postAsk = (overrides = {}) => api('POST', '/hook', { ...ASK_BODY, ...overrides });

  it('gate off → 维持现状：setDecision 捕获（不拦截、无 ccOutput）', async () => {
    writeGate(false);
    await registerMain();
    const res = await postAsk();
    expect(res.body.ccOutput).toBeUndefined();
    expect(server._getState().decisionPending).toMatchObject({ question: '选哪个方案？', source: 'AskUserQuestion' });
  });

  it('gate on 非 deciding → deny，reason 指引改以 <AWF_DECISION_REQUIRED> 收尾（不进入 deciding、不捕获）', async () => {
    writeGate(true);
    await registerMain();
    const res = await postAsk();
    const hs = res.body.ccOutput?.hookSpecificOutput;
    expect(hs.permissionDecision).toBe('deny');
    expect(hs.permissionDecisionReason).toContain('AWF_DECISION_REQUIRED');
    expect(hs.permissionDecisionReason).toContain('最后一行');
    expect(hs.updatedInput.questions).toEqual([]);
    // gate on：不设 decisionPending；不进入 deciding（与文字入口在 Stop 闸门合一）
    expect(server._getState().decisionPending).toBeNull();
    expect(server._getState().decisionGate).toBeNull();
  });

  it('ask deny 后模型以标签收尾 → Stop 闸门② 进入 deciding（两入口合一）', async () => {
    writeGate(true);
    await registerMain();
    await setBusy();
    await postAsk(); // deny（非 deciding）
    expect(server._getState().decisionGate).toBeNull();
    // 模型按指引以 <AWF_DECISION_REQUIRED> 结束本回合
    const res = await stopPayload({ last_assistant_message: REQ_TAG('选哪个方案？'), stop_hook_active: false });
    expect(res.body.ccOutput.decision).toBe('block');
    expect(server._getState().decisionGate.phase).toBe('deciding');
    expect(server._getState().state).toBe('busy');
  });

  it('gate on 已在 deciding → 重复 AskUserQuestion 拒绝（决策闭合前禁再问），不重新置 deciding', async () => {
    writeGate(true);
    await registerMain();
    await setBusy();
    await stopPayload({ last_assistant_message: REQ_TAG('q'), stop_hook_active: false }); // 进入 deciding
    const res = await postAsk();
    const hs = res.body.ccOutput?.hookSpecificOutput;
    expect(hs.permissionDecision).toBe('deny');
    expect(hs.permissionDecisionReason).toContain('禁止再次发起用户提问');
    // 仍在 deciding（未重复进入），且未捕获新的 decisionPending
    expect(server._getState().decisionGate.phase).toBe('deciding');
    expect(server._getState().decisionPending).toBeNull();
  });
});

describe('决策闭环约束（closed-loop）', () => {
  it('普通完成不触发 gate：多次普通 Stop 均为 ready、无落盘、decisionGate 恒 null', async () => {
    writeGate(true);
    await registerMain();
    for (let i = 0; i < 3; i++) {
      await setBusy();
      const res = await stopPayload({ last_assistant_message: `第 ${i} 轮普通完成` });
      expect(res.body.ccOutput).toBeUndefined();
      expect(server._getState().decisionGate).toBeNull();
      expect((await api('GET', '/status')).body.state).toBe('ready');
    }
    expect(readDecisionLines()).toHaveLength(0);
  });

  it('文字入口一次事务只 block 一次：触发 → deciding；再次带标签 Stop（无结果）→ fallback 闭合，不再二次 block', async () => {
    writeGate(true);
    await registerMain();
    await setBusy();
    const first = await stopPayload({ last_assistant_message: REQ_TAG('q1'), stop_hook_active: false });
    expect(first.body.ccOutput.decision).toBe('block');
    expect(server._getState().decisionGate.phase).toBe('deciding');

    // 模型再次以必需标记结束但没给结果 → 不二次 block，落 fallback 并 ready（事务闭合）
    const second = await stopPayload({ last_assistant_message: REQ_TAG('q1 重问'), stop_hook_active: true });
    expect(second.body.ccOutput).toBeUndefined();
    const st = server._getState();
    expect(st.decisionGate).toBeNull();
    expect(st.state).toBe('ready');
    expect(st.decisionResume.fallback).toBe(true);
    expect(readDecisionLines()).toHaveLength(1);
  });

  it('AskUserQuestion deny → 标签收尾 → Stop block(deciding) → 结果落盘 一次 DC 闭环', async () => {
    writeGate(true);
    await registerMain();
    await setBusy();
    const ask = await api('POST', '/hook', {
      event: 'PreToolUse', session_id: 'sess-main', tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: '选 A 还是 B？', options: [{ label: 'A' }, { label: 'B' }] }] },
    });
    expect(ask.body.ccOutput.hookSpecificOutput.permissionDecision).toBe('deny');

    const block = await stopPayload({ last_assistant_message: REQ_TAG('选 A 还是 B？'), stop_hook_active: false });
    expect(block.body.ccOutput.decision).toBe('block');
    expect(server._getState().decisionGate.phase).toBe('deciding');

    const done = await stopPayload({ last_assistant_message: resultMessage(), stop_hook_active: true });
    expect(done.body.ccOutput).toBeUndefined();
    const st = server._getState();
    expect(st.decisionGate).toBeNull();
    expect(st.state).toBe('ready');
    expect(st.decisionResume.fallback).toBe(false);
    const lines = readDecisionLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].result.answer).toBe('先做可逆验证再定');
  });

  it('无 stop_hook_active 字段也能可靠判定（缺省视作首次可触发；deciding 后按结果/兜底闭合）', async () => {
    writeGate(true);
    await registerMain();
    await setBusy();
    // 不带 stop_hook_active 的触发 Stop
    const block = await stopPayload({ last_assistant_message: REQ_TAG('无字段触发') });
    expect(block.body.ccOutput.decision).toBe('block');
    expect(server._getState().decisionGate.phase).toBe('deciding');
    // 不带 stop_hook_active 的结果 Stop
    const done = await stopPayload({ last_assistant_message: resultMessage() });
    expect(done.body.ccOutput).toBeUndefined();
    const st = server._getState();
    expect(st.decisionGate).toBeNull();
    expect(st.state).toBe('ready');
    expect(readDecisionLines()).toHaveLength(1);
  });

  it('无结果必有兜底：deciding 中多次无结果 Stop 均收敛到单条 fallback，不悬空不重复', async () => {
    writeGate(true);
    await registerMain();
    await setBusy();
    await stopPayload({ last_assistant_message: REQ_TAG('q'), stop_hook_active: false });
    await stopPayload({ last_assistant_message: '给不出结论', stop_hook_active: true });
    // 已闭合 ready + fallback resume + 单条落盘
    const st = server._getState();
    expect(st.state).toBe('ready');
    expect(st.decisionResume.fallback).toBe(true);
    expect(readDecisionLines()).toHaveLength(1);
    expect(readDecisionLines()[0].result.type).toBe('deferred');
    // 后续普通 Stop 不再落盘（resume 随新普通完成清空）
    await stopPayload({ last_assistant_message: '后续完成', stop_hook_active: false });
    expect(readDecisionLines()).toHaveLength(1);
    expect(server._getState().decisionResume).toBeNull();
  });
});

describe('捕获记录字段完整性（供 Review 消费）', () => {
  it('一次真实捕获落一条完整 decision_completed(pending_review)：字段齐全', async () => {
    writeGate(true);
    await registerMain();
    await setBusy();
    await stopPayload({ last_assistant_message: REQ_TAG('q'), stop_hook_active: false });
    const msg = resultMessage({ confidence: 'high', risks: ['依赖外部定时'], unknowns: ['待验证'] });
    await stopPayload({ last_assistant_message: msg, stop_hook_active: true });

    const lines = readDecisionLines();
    expect(lines).toHaveLength(1);
    const rec = lines[0];
    expect(rec.event).toBe('decision_completed');
    expect(rec.status).toBe('pending_review');
    expect(rec.fallback).toBe(false);
    expect(rec.source).toBe('text');
    expect(rec.decision_id).toBeTruthy();
    expect(rec.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Review 消费的核心字段
    expect(rec.result).toMatchObject({
      answer: '先做可逆验证再定',
      type: 'resolved',
      finality: 'final',
      real_question: '真正要决定的行动',
      decisive_factors: ['可逆性'],
      reconsider_when: ['新事实出现时'],
      risks: ['依赖外部定时'],
      unknowns: ['待验证'],
      confidence: 'high',
    });
    // run 日志决策事件与存储记录时间对齐（decision_completed 用同一 created_at）
    const decLog = m.logger.logDecision.mock.calls.map((c) => c[0]).find((x) => x.event === 'decision_completed');
    expect(decLog).toMatchObject({ at: rec.created_at, decisionId: rec.decision_id, detail: 'resolved type=resolved' });
  });

  it('fallback 同样落完整 decision_completed：fallback:true + deferred 结果字段可 Review', async () => {
    writeGate(true);
    await registerMain();
    await setBusy();
    await stopPayload({ last_assistant_message: REQ_TAG('q'), stop_hook_active: false });
    await stopPayload({ last_assistant_message: '无法完成', stop_hook_active: true });

    const rec = readDecisionLines()[0];
    expect(rec.event).toBe('decision_completed');
    expect(rec.status).toBe('pending_review');
    expect(rec.fallback).toBe(true);
    expect(rec.result).toMatchObject({
      type: 'deferred',
      finality: 'provisional',
      fallback: true,
      confidence: 'low',
    });
    expect(rec.result.answer.length).toBeGreaterThan(0);
    expect(Array.isArray(rec.result.reconsider_when)).toBe(true);
  });
});

describe('Review 数据 API — list / override', () => {
  async function captureOne(overrides = {}) {
    writeGate(true);
    await registerMain();
    await setBusy();
    await stopPayload({ last_assistant_message: REQ_TAG('q'), stop_hook_active: false });
    await stopPayload({ last_assistant_message: resultMessage(overrides), stop_hook_active: true });
    return server._getState().decisionResume.decision_id;
  }

  it('GET /awf/decisions → 聚合倒序列表，含 decision_completed 记录', async () => {
    const id = await captureOne();
    const res = await api('GET', '/awf/decisions');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.total).toBe(1);
    expect(res.body.decisions[0]).toMatchObject({ event: 'decision_completed', decision_id: id, status: 'pending_review' });
  });

  it('POST /awf/decisions/<id>/override → 追加 decision_overridden，原记录保留', async () => {
    const id = await captureOne();
    const over = await api('POST', `/awf/decisions/${id}/override`, { instruction: '改成走 B 并重跑验证', original_answer: '先做可逆验证再定' });
    expect(over.status).toBe(200);
    expect(over.body.ok).toBe(true);
    expect(over.body.decision_id).toBe(id);

    const list = (await api('GET', '/awf/decisions')).body;
    expect(list.total).toBe(2);
    const original = list.decisions.find((d) => d.event === 'decision_completed');
    const ov = list.decisions.find((d) => d.event === 'decision_overridden');
    expect(original.decision_id).toBe(id);
    expect(ov).toMatchObject({ decision_id: id, instruction: '改成走 B 并重跑验证', original_answer: '先做可逆验证再定' });
  });

  it('override 校验：缺 instruction → 400；目标不存在 → 404', async () => {
    const bad = await api('POST', '/awf/decisions/D-none/override', {});
    expect(bad.status).toBe(400);
    const miss = await api('POST', '/awf/decisions/D-none/override', { instruction: 'x' });
    expect(miss.status).toBe(404);
    expect(miss.body.ok).toBe(false);
  });

  it('override → state 追加纠偏任务（kind=dev/source=decision_review），findNextTask 下一轮拾取', async () => {
    const id = await captureOne();
    const over = await api('POST', `/awf/decisions/${id}/override`, { instruction: '改成走 B 并重跑验证', original_answer: '先做可逆验证再定' });
    expect(over.status).toBe(200);
    expect(over.body.reviewTaskId).toBe(`${id}-REV`);

    const state = JSON.parse(fs.readFileSync(path.join(PROJ, '.awf', 'state.json'), 'utf8'));
    const task = state.tasks.find((t) => t.id === `${id}-REV`);
    expect(task).toBeTruthy();
    expect(task).toMatchObject({ kind: 'dev', status: 'pending', source: 'decision_review', deps: [], plannedFiles: [] });
    expect(task.wbsRef).toBeUndefined();
    expect(task.exec).toMatchObject({ decision_id: id, instruction: '改成走 B 并重跑验证', original_answer: '先做可逆验证再定' });
    // 单 agent runLoop 下一轮 findNextTask 拾取该 pending 纠偏任务
    expect(findNextTask(state).id).toBe(`${id}-REV`);
  });
});

// gate off 双路径回归基线：旧行为（AskUserQuestion 捕获 → answer 回写 → Stop 收尾）必须原样
describe('gate off 回归基线（旧路径）', () => {
  it('AskUser PreToolUse 捕获 decisionPending → PostToolUse answer 回写 → Stop 清空并 ready，无决策闸门介入', async () => {
    writeGate(false);
    await registerMain();
    const ask = await api('POST', '/hook', {
      event: 'PreToolUse', session_id: 'sess-main', tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: '选 A 还是 B？', options: [{ label: 'A' }, { label: 'B' }] }] },
    });
    expect(ask.body.ccOutput).toBeUndefined();
    expect(server._getState().decisionPending).toMatchObject({ question: '选 A 还是 B？', source: 'AskUserQuestion' });

    // 原生 UI 回答回写（旧路径）
    const post = await api('POST', '/hook', {
      event: 'PostToolUse', session_id: 'sess-main', tool_name: 'AskUserQuestion', tool_response: { answer: 'A' },
    });
    expect(post.body.ccOutput).toBeUndefined();
    expect(server._getState().decisionPending).toMatchObject({ answer: 'A', answered: true });

    // Stop → 清 decisionPending + ready，无 decisionGate/无落盘
    await stopPayload({ last_assistant_message: '按选择完成', stop_hook_active: false });
    const st = server._getState();
    expect(st.decisionPending).toBeNull();
    expect(st.state).toBe('ready');
    expect(st.decisionGate).toBeNull();
    expect(readDecisionLines()).toHaveLength(0);
  });
});
