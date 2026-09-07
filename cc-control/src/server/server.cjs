'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
// 测试注入点：vitest 无法 mock 被原生 require 加载的 CJS 依赖，提供显式注入钩子。
// 生产环境不设置 global.__CC_TMUX__/__CC_RUNLOGGER__，回落到真实模块。
const tmuxlib = global.__CC_TMUX__ || require('./tmux.cjs');
const { RunLogger } = global.__CC_RUNLOGGER__ || require('./run-logger.cjs');
const { readRunMetrics, readRunMeta, resetRunMeta, updateRunMeta } = require('../lib/run-metrics.cjs');
const {
  buildDiagnosisPrompt, diagnoseWithClaude, readDiagnosis, writeDiagnosis,
} = global.__CC_RUN_DIAGNOSIS__ || require('../lib/run-diagnosis.cjs');
const { isDecisionEnabled } = require('../lib/decision-config.cjs');
const { parseDecisionResult } = require('./decision.cjs');
const gateRules = require('./decision-gate.cjs');
const ccShapes = require('../adapters/cc-shapes.cjs');
const extract = require('../lib/extract.cjs');
const interact = require('./interact.cjs');
const { DecisionStore } = require('./decision-store.cjs');
const decisionInstruction = require('./decision-instruction.cjs');
// run-context 装配：server 当前承载单 run（无 sid），项目根/路径/端口/会话名统一经装配器派生。
// 多 run 分槽（每 run 独立上下文）由 T1-068/T1-071 接入。
const { buildRunContext } = require('../lib/run-context.cjs');
const ctx = buildRunContext({ env: process.env });

const PROJECT_ROOT = ctx.projectRoot;
const logger = new RunLogger(PROJECT_ROOT);
if (logger.enabled) console.log(`[server] run logs: ${logger.dir}`);

// ---- subagent 事件日志：SubagentStart/Stop 的完整 payload 追加写入（实证/观测用）----
const SUBAGENT_LOG = path.join(ctx.logsDir, 'subagent-events.jsonl');

function logSubagentEvent(event, body) {
  try {
    fs.mkdirSync(path.dirname(SUBAGENT_LOG), { recursive: true });
    fs.appendFileSync(SUBAGENT_LOG, JSON.stringify({ ts: new Date().toISOString(), event, body }) + '\n');
  } catch (e) {
    console.log(`[subagent-log] ${e.message}`);
  }
}

// ---- 落账失败记录：CLI 据此触发补发（SendMessage 恢复子 Agent 补齐 RESULT）----
const SUBAGENT_FAILED_LOG = path.join(ctx.logsDir, 'subagent-failed.jsonl');

function logSubagentFailure(body, settled) {
  try {
    fs.mkdirSync(path.dirname(SUBAGENT_FAILED_LOG), { recursive: true });
    fs.appendFileSync(SUBAGENT_FAILED_LOG, JSON.stringify({
      ts: new Date().toISOString(),
      agentId: body.agent_id || body.session_id || 'unknown',
      reason: settled.reason,
      resultTaskId: (parseSubagentResult(body) || {}).taskId || null,
    }) + '\n');
  } catch (e) {
    console.log(`[subagent-fail] ${e.message}`);
  }
}

// ---- 决策上抛记录（NEEDS_INPUT）：CLI 据此暂停补位、主 Agent 原生 AskUserQuestion 问用户 ----
const SUBAGENT_NEEDS_LOG = path.join(ctx.logsDir, 'subagent-needs-input.jsonl');

/** 解析子 Agent 的 NEEDS_INPUT（`NEEDS_INPUT: {json}`）；成功返回 { taskId, question, options?, context? }，否则 null */
function parseSubagentNeedsInput(body) {
  // 提取逻辑归位 extract.cjs
  return extract.parseNeedsInput(body?.last_assistant_message);
}

/** 写决策上抛记录（不落账，任务保持等待；CLI 暂停补位直到决策解决） */
function logSubagentNeedsInput(body, needs) {
  try {
    fs.mkdirSync(path.dirname(SUBAGENT_NEEDS_LOG), { recursive: true });
    fs.appendFileSync(SUBAGENT_NEEDS_LOG, JSON.stringify({
      ts: new Date().toISOString(),
      agentId: body.agent_id || body.session_id || 'unknown',
      taskId: needs.taskId,
      question: needs.question,
      options: needs.options || [],
      context: needs.context || null,
    }) + '\n');
  } catch (e) {
    console.log(`[subagent-needs] ${e.message}`);
  }
}

/** 每次 run 启动清空驱动 CLI 补发/决策的日志，避免跨 run 残留触发伪补发。
 *  仅清驱动类日志（failed/needs）；subagent-events.jsonl 是纯观测日志，保留便于取证。 */
function resetRunLogs() {
  for (const p of [SUBAGENT_FAILED_LOG, SUBAGENT_NEEDS_LOG]) {
    try { fs.rmSync(p, { force: true }); } catch { /* 无权限时忽略 */ }
  }
}

// ---- SubagentStop 落账：解析子 Agent 固定格式 RESULT → 写 state ----
// 多 agent 滑动窗口的落账由 hook 驱动（用户定稿），不依赖主 Agent 收尾。
// run state 写读统一经 store.state（JsonFileStore：state.lock + 原子写，承接 store.cjs / store-core）
const runStores = require('../lib/store.cjs').createRunStores(ctx);

/** 解析子 Agent 固定格式 RESULT（`RESULT: {json}`）；成功返回结果对象，失败返回 null */
function parseSubagentResult(body) {
  // 提取逻辑归位 extract.cjs（RESULT/状态集单源）
  return extract.parseSubagentResult(body?.last_assistant_message);
}

/** SubagentStop 落账：写 state（task status + exec.result/files/commits）；返回 { ok, taskId?, reason?, recoverable? } */
function settleSubagent(body) {
  const result = parseSubagentResult(body);
  if (!result) return { ok: false, reason: 'no valid RESULT in last_assistant_message' };
  let out;
  runStores.state.updateSync((s) => {
    // s = null 表示缺失/非法 → 不落账
    if (!s) { out = { ok: false, reason: 'state.json unreadable', recoverable: false }; return false; }
    const task = (s.tasks || []).find((t) => t.id === result.taskId);
    if (!task) { out = { ok: false, reason: `task ${result.taskId} not found` }; return false; }
    // 指向已完成/已阻塞任务 → 拒绝：RESULT taskId 可能错写（如 X1 子 Agent 误写成已 done 的 T3），
    // 否则落账"假成功"（错标已有任务），真实任务永不落账且不触发补发。
    // recoverable:false → 良性（phantom 先落账/重复 Stop），不写失败记录、不触发 CLI 补发
    if (task.status === 'done' || task.status === 'blocked') {
      out = { ok: false, reason: `task ${result.taskId} already ${task.status}（RESULT taskId 可能错写）`, recoverable: false };
      return false;
    }
    if (!task.exec) task.exec = {};
    // failed/fail 是协议允许的终态（awf-worker.md: done|blocked|failed），但调度只认 blocked 为终态，映射之
    task.status = (result.status === 'failed' || result.status === 'fail') ? 'blocked' : result.status;
    task.exec.completedAt = new Date().toISOString();
    if (result.result !== undefined) task.exec.result = result.result;
    if (result.files) task.exec.files = result.files;
    if (result.verdict !== undefined) task.exec.verdict = result.verdict;
    if (result.architecture !== undefined) task.exec.architecture = result.architecture;
    if (result.commits) { task.commits = task.commits || []; task.commits.push(...result.commits); }
    s.lastUpdated = new Date().toISOString();
    out = { ok: true, taskId: result.taskId, status: result.status };
    return true;
  });
  return out;
}

/** override → 向任务列表追加纠偏任务（kind=dev / source=decision_review，携带 decision_id/instruction/original_answer）。
 *  store.state.updateSync 锁内读改写；deps/plannedFiles 空 = 保守串行；不写 wbsRef（非原 WBS 叶子）。 */
function appendDecisionReviewTask({ decision_id, instruction, original_answer }) {
  let out;
  runStores.state.updateSync((s) => {
    if (!s) { out = { ok: false, error: 'state.json unreadable' }; return false; }
    const id = `${decision_id}-REV`;
    const existing = (s.tasks || []).find((t) => t.id === id);
    if (existing) { out = { ok: true, taskId: id, existing: true }; return false; }

    const task = {
      id,
      kind: 'dev',
      status: 'pending',
      title: `决策纠偏：${instruction.length > 28 ? `${instruction.slice(0, 28)}…` : instruction}`,
      source: 'decision_review',
      prompt: `决策纠偏（decision ${decision_id}）：人工 override 指令——${instruction}。原决策 answer：${original_answer || '(无)'}。请据此对受影响产物执行修正并落账。`,
      deps: [],
      plannedFiles: [],
      constraints: [],
      acceptance: `按 override 指令完成 ${decision_id} 的纠偏`,
      exec: { decision_id, instruction, original_answer: original_answer || null },
    };

    s.tasks = s.tasks || [];
    s.tasks.push(task);
    s.lastUpdated = new Date().toISOString();
    out = { ok: true, taskId: id };
    return true;
  });
  return out;
}

const PORT = ctx.port; // 单源：config port（CC_PORT 覆盖），经 run-context 装配
const READY_TIMEOUT_MS = Number(process.env.CC_READY_TIMEOUT_MS || 120000);
const ENTER_DELAY_MS = Number(process.env.CC_ENTER_DELAY_MS || 200);
const LOCAL_CMD_FALLBACK_MS = Number(process.env.CC_LOCAL_CMD_MS || 1500);
const DECISION_FALLBACK_MS = Number(process.env.CC_DECISION_FALLBACK_MS || 300000);
// dashboard/ui 目录：测试用 CC_HTML_DIR 指向临时目录以控制文件存在性
const htmlDir = () => process.env.CC_HTML_DIR || __dirname;
let metricsCache = { at: 0, value: null };
let diagnosisInFlight = false;

function getMetricsSnapshot() {
  reconcileDiagnosisSession();
  if (Date.now() - metricsCache.at < 1000 && metricsCache.value) return metricsCache.value;
  metricsCache = {
    at: Date.now(),
    value: readRunMetrics(PROJECT_ROOT, {
      mainSessionId,
      activeAgents: [...agents.values()].filter((a) => a.status === 'running').length,
    }),
  };
  return metricsCache.value;
}

function reconcileDiagnosisSession() {
  const record = readDiagnosis(PROJECT_ROOT);
  const snapshot = record?.status === 'running' ? record.metrics : null;
  const snapshotSessionId = snapshot?.sources?.mainSessionId;
  if (!snapshotSessionId || snapshotSessionId === mainSessionId) return;

  const meta = readRunMeta(PROJECT_ROOT);
  const existingSubagents = meta.subagents || {};
  const restoredSubagents = Object.keys(existingSubagents).length > 0 ? existingSubagents : Object.fromEntries(
    (snapshot.sources.transcriptPaths || [])
      .filter((transcriptPath) => transcriptPath !== snapshot.sources.mainTranscriptPath)
      .map((transcriptPath) => {
        const agentId = path.basename(transcriptPath, '.jsonl');
        return [agentId, { agentId, status: 'unknown', transcriptPath }];
      }),
  );
  mainSessionId = snapshotSessionId;
  updateRunMeta(PROJECT_ROOT, (current) => ({
    ...current,
    projectRoot: PROJECT_ROOT,
    startedAt: snapshot.startedAt || current.startedAt || null,
    mainSessionId: snapshotSessionId,
    subagents: restoredSubagents,
    updatedAt: new Date().toISOString(),
  }));
  metricsCache = { at: 0, value: null };
  console.log('[diagnosis] restored main session from diagnostic snapshot');
}

function readProjectState() {
  return runStores.state.readSync() || {};
}

async function startRunDiagnosis() {
  if (diagnosisInFlight) return { ok: false, error: 'diagnosis already running' };

  const metrics = getMetricsSnapshot();
  const stateSnapshot = readProjectState();
  const pending = writeDiagnosis(PROJECT_ROOT, {
    status: 'running',
    requestedAt: new Date().toISOString(),
    metrics,
    state: stateSnapshot,
    runMeta: readRunMeta(PROJECT_ROOT),
  });
  diagnosisInFlight = true;

  Promise.resolve(diagnoseWithClaude(buildDiagnosisPrompt(metrics, stateSnapshot), PROJECT_ROOT))
    .then((result) => {
      writeDiagnosis(PROJECT_ROOT, {
        ...pending,
        status: result.ok ? 'complete' : 'failed',
        completedAt: new Date().toISOString(),
        diagnosis: result.diagnosis || null,
        error: result.ok ? null : result.error || 'unknown diagnosis error',
      });
    })
    .catch((error) => {
      writeDiagnosis(PROJECT_ROOT, {
        ...pending,
        status: 'failed',
        completedAt: new Date().toISOString(),
        diagnosis: null,
        error: error.message,
      });
    })
    .finally(() => { diagnosisInFlight = false; });

  return { ok: true, diagnosis: pending };
}

// ---- ready/busy state machine, driven by Claude Code hooks ----
let state = 'ready'; // 'ready' | 'busy'
let decisionPending = null; // null | { type: 'choice'|'text', question: string, options?: string[] }
let waiters = [];
let fallbackTimer = null; // /cmd /respond 的兜底恢复定时器（测试中需可清除）
let contextReady = false; // awf_context_ready 置位，CLI 一次性消费后 /clear
let mainSessionId = readRunMeta(PROJECT_ROOT).mainSessionId || null; // 主 Claude 会话的 session_id（SessionStart 透传 payload 记录）
const agents = new Map(); // 子 agent 观测: key(session_id/agent_id) → { sessionId, status, startedAt }

/** 是否为影响主 ready/busy 的会话：mainSessionId 未记录或 payload 无 session_id 时向后兼容，全接受 */
function isMainSession(body) {
  return !mainSessionId || !body.session_id || body.session_id === mainSessionId;
}

function setDecision(d) {
  decisionPending = d;
}

function clearDecision() {
  decisionPending = null;
}

// ---- decision gate（v0.2.0，单 agent）：Stop 统一决策闸门 ----
// gate 关（缺省）→ Stop 行为与现状完全一致（clearDecision + setReady + 采集）。
// gate 开 → Stop 进入统一闸门三分支：
//   ① 普通完成（结束文本无必需标记）→ clearDecision + setReady + 采集；
//   ② 结束文本以 <AWF_DECISION_REQUIRED>…</…> 结尾 且 !stop_hook_active → phase=deciding，
//      不 setReady（保持 busy 延续），返回 block ccOutput（continuePrompt = 决策模式指令，当前会话继续产出结果）；
//   ③ deciding 中再 Stop：含有效 <AWF_DECISION_RESULT> → parse → store 落盘 → decisionResume → setReady；
//      无有效结果 → 构造 deferred fallback 落盘 → decisionResume → setReady。
// 闸门期间不额外翻转 ready/busy，防止 CLI 在决策事务未闭合时提前派发。
let decisionGate = null; // null | { phase: 'deciding', startedAt }
let decisionResume = null; // 最近一次闭合决策摘要（/status 暴露）；新事务开始时清空
// 决策 id 生成规则归位 decision-gate（createDecisionSeq）
const decisionSeqGen = gateRules.createDecisionSeq();
function nextDecisionId() {
  return decisionSeqGen.nextId();
}

/** 无有效结果兜底（构造归位 decision-gate.deferredFallbackResult） */
function deferredFallbackResult() {
  return gateRules.deferredFallbackResult();
}

/** 捕获落盘 + 置 decisionResume（正式结果与 fallback 共用；落一条完整 decision_completed 记录） */
function persistDecision(result, source) {
  const decisionId = nextDecisionId();
  const createdAt = new Date().toISOString();
  // decision_completed 记录构造归位 decision-gate.buildCompletedRecord
  const record = gateRules.buildCompletedRecord({ decisionId, result, source, createdAt });
  const appended = new DecisionStore(PROJECT_ROOT).append(record);
  if (!appended.appended) console.log(`[decision-gate] append skipped for ${decisionId}`);
  logger.logDecision({
    at: createdAt,
    decisionId,
    event: 'decision_completed',
    detail: result.fallback === true ? `fallback type=${result.type}` : `resolved type=${result.type}`,
  });
  decisionResume = {
    decision_id: decisionId,
    answer: result.answer,
    type: result.type,
    finality: result.finality,
    fallback: result.fallback === true,
  };
  return decisionId;
}

/**
 * AskUserQuestion 的 PreToolUse 决策化。
 *   gate 关 → 维持现状：setDecision 捕获（不拦截）；
 *   gate 开 & 非 deciding → deny，reason 指引模型把问题以 <AWF_DECISION_REQUIRED>…</…> 放本回合最后一行收尾
 *     （勿再问/勿继续），与文字入口在 Stop 闸门 ② 处合一；
 *   gate 开 & deciding → 重复提问拒绝（决策闭合前禁再问），不重新置 deciding。
 * deny reason 不内嵌 DC 决策模式指令（那由 Stop block 的 continuePrompt 注入）。
 */
function handleAskUserQuestion(body) {
  const questions = body.tool_input?.questions;
  if (!questions || questions.length === 0) return null;

  const deciding = decisionGate?.phase === 'deciding';
  const action = gateRules.classifyAskQuestion({ enabled: isDecisionEnabled(PROJECT_ROOT), deciding, questions });

  if (action.kind === 'capture') {
    const q = action.question || questions[0];
    setDecision({
      type: q.multiSelect ? 'multiSelect' : 'choice',
      multiSelect: !!q.multiSelect,
      question: q.question,
      options: (q.options || []).map((o) => o.label),
      header: q.header || null,
      source: 'AskUserQuestion',
    });
    console.log(`[hook] AskUserQuestion detected (PreToolUse): ${q.question}`);
    return null;
  }
  if (action.kind === 'deny_deciding') {
    console.log('[hook] AskUserQuestion denied (deciding): 决策闭合前禁再问');
    return action.output;
  }
  console.log('[hook] AskUserQuestion denied (gate on): 改以决策标签收尾');
  return action.output;
}

/** Stop 统一闸门；返回可选 { ccOutput }（② 触发时 block 当前会话让其产出结果） */
function handleStop(body) {
  const text = typeof body?.last_assistant_message === 'string' ? body.last_assistant_message : '';
  const deciding = decisionGate?.phase === 'deciding';
  const branch = gateRules.classifyStop({
    enabled: isDecisionEnabled(PROJECT_ROOT),
    text,
    deciding,
    stopHookActive: body?.stop_hook_active,
  });

  if (branch.branch === 'deciding') {
    // ② 触发
    const startedAt = new Date().toISOString();
    decisionGate = { phase: 'deciding', startedAt };
    decisionResume = null;
    logger.logDecision({ at: startedAt, decisionId: null, event: 'decision_started', detail: '决策入口（<AWF_DECISION_REQUIRED>）' });
    let instruction;
    try {
      instruction = decisionInstruction.readDecisionInstruction();
    } catch (e) {
      instruction = '决策模式：请产出 <AWF_DECISION_RESULT> 包裹的 Decision Result。';
    }
    return ccShapes.blockDecision(instruction);
  }

  if (branch.branch === 'resolve') {
    // ③ deciding 中收尾：有效结果捕获，否则 deferred fallback；随后 ready
    const parsed = parseDecisionResult(text);
    if (!parsed.valid) console.log(`[decision-gate] no valid result (${parsed.error}); deferred fallback`);
    persistDecision(parsed.valid ? parsed.result : deferredFallbackResult(), 'text');
    decisionGate = null;
    clearDecision();
    setReady();
    logger.captureFromTranscript();
    return null;
  }

  // complete：gate 关 或 ① 普通完成 —— 清 decisionPending + ready + transcript 采集
  clearDecision();
  decisionGate = null;
  decisionResume = null;
  setReady();
  logger.captureFromTranscript();
  return null;
}

function setReady() {
  state = 'ready';
  const pending = waiters;
  waiters = [];
  for (const fn of pending) fn();
}

function setBusy() {
  state = 'busy';
}

function waitReady(timeout) {
  if (state === 'ready') return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const fn = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      waiters = waiters.filter((w) => w !== fn);
      resolve(false);
    }, timeout);
    waiters.push(fn);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function submit(text) {
  tmuxlib.sendText(text);
  await sleep(ENTER_DELAY_MS);
  tmuxlib.sendEnter();
}

// ---- HTTP plumbing ----
function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body);
}

/** 自动介入只允许在 CLI pause 闩锁已生效后执行。 */
function requirePaused(res) {
  const s = runStores.state.readSync();
  if (s?.mode === 'pause') return true;
  send(res, 409, { ok: false, error: `intervention requires mode=pause (current: ${s?.mode || 'unknown'})` });
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // dashboard (default) + control panel
  if (req.method === 'GET' && pathname === '/') {
    try {
      const html = fs.readFileSync(htmlDir() + '/dashboard.html');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch {
      try {
        const html = fs.readFileSync(htmlDir() + '/ui.html');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      } catch {
        return send(res, 500, { ok: false, error: 'no page found' });
      }
    }
  }

  if (req.method === 'GET' && pathname === '/diagnostics') {
    try {
      const html = fs.readFileSync(htmlDir() + '/diagnostics.html');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch {
      return send(res, 500, { ok: false, error: 'diagnostics.html not found' });
    }
  }

  if (req.method === 'GET' && pathname === '/decisions.html') {
    try {
      const html = fs.readFileSync(htmlDir() + '/decisions.html');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch {
      return send(res, 500, { ok: false, error: 'decisions.html not found' });
    }
  }

  if (req.method === 'GET' && pathname === '/ui') {
    try {
      const html = fs.readFileSync(htmlDir() + '/ui.html');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch {
      return send(res, 500, { ok: false, error: 'ui.html not found' });
    }
  }

  // hook callback: life-cycle + AskUserQuestion capture
  if (req.method === 'POST' && pathname === '/hook') {
    const body = (await readJson(req)) || {};
    const event = body.event || url.searchParams.get('event');
    let hookCcOutput = null; // server 需回传的 hook 输出（decision gate block/deny），gateway 透传到 stdout

    if (event === 'SessionStart') {
      if (diagnosisInFlight && body.session_id && body.session_id !== mainSessionId) {
        console.log(`[diagnosis] ignored isolated SessionStart ${body.session_id}`);
        return send(res, 200, { ok: true, event: event || null, state });
      }
      if (body.session_id && body.session_id !== mainSessionId) {
        resetRunLogs();
        resetRunMeta(PROJECT_ROOT);
        metricsCache = { at: 0, value: null };
      }
      if (body.session_id) mainSessionId = body.session_id;
      updateRunMeta(PROJECT_ROOT, (meta) => ({
        ...meta,
        projectRoot: PROJECT_ROOT,
        startedAt: meta.startedAt || new Date().toISOString(),
        endedAt: null,
        mainSessionId: body.session_id || meta.mainSessionId || null,
        updatedAt: new Date().toISOString(),
      }));
      setReady();
      logger.resetTranscript();
    } else if (event === 'UserPromptSubmit') {
      // 子 agent 的 prompt 不翻转主闩锁（子 agent 完成是 SubagentStop，不触发主 Stop，引用计数会悬挂）
      if (isMainSession(body)) setBusy();
    } else if (event === 'Stop') {
      if (isMainSession(body)) {
        const out = handleStop(body);
        if (out) hookCcOutput = out.ccOutput;
      }
    } else if (event === 'SubagentStart') {
      logSubagentEvent(event, body);
      // 只接纳 tmux 主会话派生的 worker。外部 w-monitor 会话的 probe/repair 也会上报
      // Subagent hooks，但绝不能进入 worker 落账/补发链路。
      if (mainSessionId && body.session_id && body.session_id !== mainSessionId) {
        console.log(`[subagent-start] skip external session ${body.session_id}`);
      } else {
        // 只观测，不驱动主闩锁。以 agent_id 键控（子 agent 共享父会话 session_id，用它做 key 会塌缩成一个）
        const key = body.agent_id || body.session_id || 'unknown';
        agents.set(key, { sessionId: body.session_id || null, status: 'running', startedAt: Date.now() });
        updateRunMeta(PROJECT_ROOT, (meta) => ({
          ...meta,
          projectRoot: PROJECT_ROOT,
          subagents: {
            ...(meta.subagents || {}),
            [key]: {
              ...(meta.subagents || {})[key],
              agentId: key,
              sessionId: body.session_id || null,
              status: 'running',
              startedAt: ((meta.subagents || {})[key] || {}).startedAt || new Date().toISOString(),
              stoppedAt: null,
              transcriptPath: body.agent_transcript_path || ((meta.subagents || {})[key] || {}).transcriptPath || null,
            },
          },
          updatedAt: new Date().toISOString(),
        }));
      }
    } else if (event === 'SubagentStop') {
      const key = body.agent_id || body.session_id || 'unknown';
      logSubagentEvent(event, body);
      if (mainSessionId && body.session_id && body.session_id !== mainSessionId) {
        console.log(`[subagent-stop] skip external session ${body.session_id}`);
      } else {
        const a = agents.get(key);
        if (a) a.status = 'stopped';
        updateRunMeta(PROJECT_ROOT, (meta) => ({
          ...meta,
          projectRoot: PROJECT_ROOT,
          subagents: {
            ...(meta.subagents || {}),
            [key]: {
              ...(meta.subagents || {})[key],
              agentId: key,
              sessionId: body.session_id || ((meta.subagents || {})[key] || {}).sessionId || null,
              status: 'stopped',
              startedAt: ((meta.subagents || {})[key] || {}).startedAt || new Date().toISOString(),
              stoppedAt: new Date().toISOString(),
              transcriptPath: body.agent_transcript_path || ((meta.subagents || {})[key] || {}).transcriptPath || null,
            },
          },
          updatedAt: new Date().toISOString(),
        }));
      // 未跟踪的 Stop（无 SubagentStart：伪事件/非本 run 派发）仅观测，不落账、不写失败记录 ——
      // 否则会为不存在的子 Agent 生成失败记录 → CLI 补发到幽灵 agent，反复 RESET/等待
      if (!a) {
        console.log(`[subagent-stop] skip untracked agent ${key} (no SubagentStart)`);
      } else {
        // 决策上抛优先：NEEDS_INPUT → 写记录（不落账，任务等待；CLI 暂停补位、主 Agent 原生 AskUserQuestion）
        const needs = parseSubagentNeedsInput(body);
        const result = needs ? null : parseSubagentResult(body);
        // 子 Agent 的完整对话只在其 Stop hook 中可可靠定位；按 taskId/agentId 归档。
        logger.captureSubagentTranscript(body, needs?.taskId || result?.taskId, key);
        if (needs) {
          logSubagentNeedsInput(body, needs);
          console.log(`[subagent-needs] ${needs.taskId}: ${needs.question.slice(0, 40)}`);
        } else {
          // 落账：解析 RESULT → 写 state；失败记录（CLI 据此补发）
          const settled = settleSubagent(body);
          if (!settled.ok) {
            console.log(`[subagent-settle] ${settled.reason} (agent ${key})`);
            // recoverable:false = 良性（already done / state 不可读），不触发补发
            if (settled.recoverable !== false) logSubagentFailure(body, settled);
          } else {
            console.log(`[subagent-settle] ${settled.taskId} -> ${settled.status}`);
          }
        }
      }
      }
    }

    // PreToolUse(AskUserQuestion)：gate 关=捕获现状（不拦截）；gate 开=deny（redirect 到决策标签 / deciding 内拒绝）
    if (event === 'PreToolUse' && body.tool_name === 'AskUserQuestion') {
      const out = handleAskUserQuestion(body);
      if (out) hookCcOutput = out.ccOutput;
    }

    // PostToolUse: 兜底（如果没拦截成功，原生 UI 回答后更新结果）
    if (event === 'PostToolUse' && body.tool_name === 'AskUserQuestion') {
      const prev = decisionPending;
      const resp = body.tool_response;
      console.log(`[hook] AskUserQuestion answered, raw: ${JSON.stringify(resp).slice(0,300)}`);
      if (prev && prev.source === 'AskUserQuestion') {
        let answer = '';
        if (typeof resp === 'string') {
          answer = resp;
        } else if (resp?.answers && typeof resp.answers === 'object') {
          answer = Object.values(resp.answers).join(', ');
        } else if (resp?.answer) {
          answer = String(resp.answer);
        } else {
          answer = JSON.stringify(resp);
        }
        setDecision({ ...prev, answer, answered: true });
      }
    }

    console.log(`[hook] ${event} -> ${state}`);
    const hookResp = { ok: true, event: event || null, state };
    if (hookCcOutput) hookResp.ccOutput = hookCcOutput;
    return send(res, 200, hookResp);
  }

  // ---- state.json ----
  if (req.method === 'GET' && pathname === '/awf/state') {
    const s = runStores.state.readSync();
    if (s == null) return send(res, 404, { ok: false, error: `state.json not found at ${ctx.statePath}` });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(s, null, 2));
  }

  if (req.method === 'GET' && pathname === '/awf/metrics') {
    return send(res, 200, { ok: true, metrics: getMetricsSnapshot() });
  }

  if (req.method === 'GET' && pathname === '/awf/diagnostics') {
    return send(res, 200, { ok: true, diagnosis: readDiagnosis(PROJECT_ROOT) });
  }

  if (req.method === 'POST' && pathname === '/awf/diagnostics') {
    const result = await startRunDiagnosis();
    return send(res, result.ok ? 202 : 409, result);
  }

  // ---- Review 数据：决策聚合列表（各 run 倒序）----
  if (req.method === 'GET' && pathname === '/awf/decisions') {
    const store = new DecisionStore(PROJECT_ROOT);
    const decisions = store.listAll(); // 已按 runStamp 倒序扁平聚合
    return send(res, 200, { ok: true, total: decisions.length, decisions });
  }

  // ---- Review override：追加 decision_overridden 事件（不改写原记录）----
  if (req.method === 'POST' && pathname.startsWith('/awf/decisions/') && pathname.endsWith('/override')) {
    const decisionId = decodeURIComponent(pathname.slice('/awf/decisions/'.length, -'/override'.length));
    const body = (await readJson(req)) || {};
    const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
    if (!instruction) return send(res, 400, { ok: false, error: 'override 需要非空 instruction' });
    try {
      const r = new DecisionStore(PROJECT_ROOT).override(decisionId, {
        instruction,
        original_answer: typeof body.original_answer === 'string' ? body.original_answer : null,
      });
      logger.logDecision({
        at: new Date().toISOString(),
        decisionId,
        event: 'decision_overridden',
        detail: `instruction=${instruction.slice(0, 40)}`,
      });
      const task = appendDecisionReviewTask({
        decision_id: decisionId,
        instruction,
        original_answer: typeof body.original_answer === 'string' ? body.original_answer : null,
      });
      if (!task.ok) return send(res, 500, { ok: false, error: `override 已记录但纠偏任务追加失败：${task.error}`, decision_id: decisionId });
      return send(res, 200, { ok: true, decision_id: decisionId, runStamp: r.runStamp, reviewTaskId: task.taskId });
    } catch (e) {
      return send(res, 404, { ok: false, error: e.message });
    }
  }

  // ---- status ----
  if (req.method === 'GET' && pathname === '/status') {
    const out = {
      ok: true, state, session: tmuxlib.hasSession(), projectRoot: PROJECT_ROOT, decisionPending, contextReady,
      decisionGate, decisionResume,
      mainSessionId,
      activeAgents: [...agents.values()].filter((a) => a.status === 'running').length,
    };
    if (url.searchParams.get('snapshot')) {
      try { out.snapshot = tmuxlib.capture(); } catch { out.snapshot = null; }
    }
    return send(res, 200, out);
  }

  // 上下文压缩快照就绪标记：AI 写快照后经 awf_context_ready → POST 置位，CLI 读后消费
  if (req.method === 'POST' && pathname === '/context-ready') {
    contextReady = true;
    console.log('[context-ready] 快照就绪，待 CLI /clear');
    return send(res, 200, { ok: true, contextReady });
  }

  // 一次性消费：读取后立即复位，避免重复触发
  if (req.method === 'GET' && pathname === '/context-ready') {
    const ready = contextReady;
    contextReady = false;
    return send(res, 200, { ok: true, ready });
  }

  // AI 通知：需要人做选择（带选项）——决策模型构造经 interact.validateDecisionRequest
  if (req.method === 'POST' && pathname === '/choice') {
    const body = await readJson(req);
    const v = interact.validateDecisionRequest('choice', body);
    if (!v.ok) return send(res, 400, { ok: false, error: v.error });
    setDecision(v.decision);
    console.log(`[choice] ${v.decision.question}`);
    return send(res, 200, { ok: true, decisionPending });
  }

  // AI 通知：需要人自由输入——决策模型构造经 interact.validateDecisionRequest
  if (req.method === 'POST' && pathname === '/ask') {
    const body = await readJson(req);
    const v = interact.validateDecisionRequest('text', body);
    if (!v.ok) return send(res, 400, { ok: false, error: v.error });
    setDecision(v.decision);
    console.log(`[ask] ${v.decision.question}`);
    return send(res, 200, { ok: true, decisionPending });
  }

  if (req.method === 'POST' && pathname === '/send') {
    const body = await readJson(req);
    if (!body || typeof body.text !== 'string' || body.text.length === 0) {
      return send(res, 400, { ok: false, error: 'body must be {text: non-empty string}' });
    }
    if (!tmuxlib.hasSession()) {
      return send(res, 503, { ok: false, error: `tmux session '${tmuxlib.SESSION}' not found; run bootstrap.sh` });
    }
    const ok = await waitReady(READY_TIMEOUT_MS);
    if (!ok) return send(res, 409, { ok: false, error: 'still busy (ready timeout)' });
    // 捕获上一任务的尾部响应，必须在 PROMPT 之前写入
    logger.captureFromTranscript();
    setBusy();
    // PROMPT 必须在 submit 之前写入日志，否则 Stop hook 的响应可能先写入
    logger.logPrompt(body.text);
    await submit(body.text);
    return send(res, 200, { ok: true, sent: body.text });
  }

  if (req.method === 'POST' && pathname === '/cmd') {
    const body = await readJson(req);
    if (!body || typeof body.cmd !== 'string' || body.cmd.length === 0) {
      return send(res, 400, { ok: false, error: 'body must be {cmd: non-empty string}' });
    }
    if (!tmuxlib.hasSession()) {
      return send(res, 503, { ok: false, error: `tmux session '${tmuxlib.SESSION}' not found; run bootstrap.sh` });
    }
    const ok = await waitReady(READY_TIMEOUT_MS);
    if (!ok) return send(res, 409, { ok: false, error: 'still busy (ready timeout)' });
    setBusy();
    await submit(body.cmd);
    // Local commands (e.g. /clear) may not emit a Stop hook; recover after a fallback.
    if (fallbackTimer) clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => { if (state === 'busy') setReady(); }, LOCAL_CMD_FALLBACK_MS);
    return send(res, 200, { ok: true, sent: body.cmd });
  }

  // w-monitor 受控介入：允许在 busy 时排队发送恢复提示，但必须先暂停 CLI 编排。
  if (req.method === 'POST' && pathname === '/intervene') {
    const body = await readJson(req);
    if (!body || typeof body.text !== 'string' || body.text.length === 0) {
      return send(res, 400, { ok: false, error: 'body must be {text: non-empty string, reason?: string}' });
    }
    if (!requirePaused(res)) return;
    if (!tmuxlib.hasSession()) {
      return send(res, 503, { ok: false, error: `tmux session '${tmuxlib.SESSION}' not found; run bootstrap.sh` });
    }
    logger.logPrompt(`[w-monitor intervention] ${body.reason || 'unspecified'}\n${body.text}`);
    setBusy();
    await submit(body.text);
    return send(res, 200, { ok: true, sent: body.text, intervention: true });
  }

  // w-monitor 升级中断：与 dashboard 的人工 /stop 分离，自动调用必须受 pause 闩锁保护。
  if (req.method === 'POST' && pathname === '/intervene/interrupt') {
    const body = (await readJson(req)) || {};
    if (!requirePaused(res)) return;
    if (!tmuxlib.hasSession()) {
      return send(res, 503, { ok: false, error: `tmux session '${tmuxlib.SESSION}' not found; run bootstrap.sh` });
    }
    tmuxlib.sendCtrlC();
    clearDecision();
    if (fallbackTimer) clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => { if (state === 'busy') setReady(); }, LOCAL_CMD_FALLBACK_MS);
    return send(res, 200, { ok: true, interrupted: true, reason: body.reason || null });
  }

  // 中断当前正在运行的 Claude 流（等价于交互式 Ctrl+C）
  if (req.method === 'POST' && pathname === '/stop') {
    if (!tmuxlib.hasSession()) {
      return send(res, 503, { ok: false, error: `tmux session '${tmuxlib.SESSION}' not found; run bootstrap.sh` });
    }
    tmuxlib.sendCtrlC();
    clearDecision();
    // Ctrl+C 中断可能不触发 Stop hook，兜底恢复 ready
    if (fallbackTimer) clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => { if (state === 'busy') setReady(); }, LOCAL_CMD_FALLBACK_MS);
    return send(res, 200, { ok: true, stopped: true });
  }

  // CLI 回应决策（有 decisionPending 时跳过 ready 检查，避免死锁）
  if (req.method === 'POST' && pathname === '/respond') {
    const body = await readJson(req);
    if (!body || typeof body.value !== 'string' || body.value.length === 0) {
      clearDecision();
      return send(res, 400, { ok: false, error: 'body must be {value: non-empty string}' });
    }
    if (!tmuxlib.hasSession()) {
      clearDecision();
      return send(res, 503, { ok: false, error: `tmux session '${tmuxlib.SESSION}' not found; run bootstrap.sh` });
    }
    // 有 pending decision 时 CC 正在等待用户输入，不检查 ready（否则死锁）
    if (!decisionPending) {
      const ok = await waitReady(READY_TIMEOUT_MS);
      if (!ok) return send(res, 409, { ok: false, error: 'still busy (ready timeout)' });
    }
    const hadDecision = !!decisionPending;
    const question = decisionPending ? decisionPending.question : null;
    setBusy();
    // 记录 CHOICE（所有决策统一走 /respond，不再分散在 CLI）
    if (hadDecision) {
      logger.logChoice(question, body.value);
    }
    // 用户已回应，立即清除决策，UI 切回输入模式（ready 恢复由 Stop 钩子/fallback 负责）
    clearDecision();
    await submit(body.value);
    // fallback timer：Stop hook 可能因 curl 超时等原因未触发，兜底恢复 ready
    const fallbackMs = hadDecision ? DECISION_FALLBACK_MS : LOCAL_CMD_FALLBACK_MS;
    if (fallbackTimer) clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => {
      if (state === 'busy') setReady();
    }, fallbackMs);
    return send(res, 200, { ok: true, sent: body.value });
  }

  return send(res, 404, { ok: false, error: 'not found' });
});

// ---- lifecycle: CLI 以子进程方式运行；测试中可显式 start/stop ----
function start(port = PORT) {
  resetRunLogs();
  metricsCache = { at: 0, value: null };
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const addr = server.address();
      resolve({ port: addr.port, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function stop() {
  return new Promise((resolve) => {
    server.close(() => resolve());
    if (server.closeAllConnections) server.closeAllConnections();
  });
}

// ---- test helpers ----
function _getState() {
  return {
    state, decisionPending, waiters: [...waiters], contextReady,
    decisionGate, decisionResume,
    mainSessionId,
    activeAgents: [...agents.values()].filter((a) => a.status === 'running').length,
  };
}

function _resetForTest() {
  if (fallbackTimer) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
  state = 'ready';
  decisionPending = null;
  decisionGate = null;
  decisionResume = null;
  decisionSeqGen.reset();
  waiters = [];
  contextReady = false;
  mainSessionId = null;
  agents.clear();
  metricsCache = { at: 0, value: null };
  resetRunMeta(PROJECT_ROOT);
  diagnosisInFlight = false;
}

module.exports = {
  server, start, stop, _getState, _resetForTest,
  setDecision, clearDecision, setReady, setBusy, waitReady,
};

if (require.main === module) {
  resetRunLogs();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`cc-control listening on http://127.0.0.1:${PORT} (session '${tmuxlib.SESSION}')`);
  });
}
