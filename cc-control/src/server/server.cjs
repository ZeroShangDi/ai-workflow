'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
// 极简 WebSocket 助手（T1-091：/run/events 实时推送通道）
const { encodeTextFrame, upgrade: wsUpgrade } = require('./ws.cjs');
// 静态托管原语（T1-093：web 构建产物 SPA 静态托管）
const { createStaticHost } = require('./static.cjs');
// 测试注入点：vitest 无法 mock 被原生 require 加载的 CJS 依赖，提供显式注入钩子。
// 生产环境不设置 global.__CC_TMUX__/__CC_RUNLOGGER__，回落到真实模块。
const { createTmux } = require('./tmux.cjs');
const { RunLogger } = global.__CC_RUNLOGGER__ || require('./run-logger.cjs');
const { readRunMetrics, readRunMeta, resetRunMeta, updateRunMeta, mainTranscriptPath } = require('../lib/run-metrics.cjs');
const {
  buildDiagnosisPrompt, diagnoseWithClaude, readDiagnosis, writeDiagnosis,
} = global.__CC_RUN_DIAGNOSIS__ || require('../lib/run-diagnosis.cjs');
const { isDecisionEnabled } = require('../lib/decision-config.cjs');
const { parseDecisionResult } = require('./decision.cjs');
const gateRules = require('./decision-gate.cjs');
// 生产侧进 adapters 一律经端口契约这一道门（T1-117）；cc-shapes 是非端口的形状工具，同门出口
const { ccShapes, oneshot: oneshotPort } = require('../adapters/ports.cjs');
const extract = require('../lib/extract.cjs');
const interact = require('./interact.cjs');
const { DecisionStore } = require('./decision-store.cjs');
const decisionInstruction = require('./decision-instruction.cjs');
// T1-080：oneshot（claude -p）收口 server /oneshot——cc 经 oneshot adapter；测试可注入 global.__CC_ONESHOT__
const oneshotLib = global.__CC_ONESHOT__ || oneshotPort;
const storeCore = require('../lib/store-core.cjs'); // per-run state 通用路径原子读写（T1-078）
const { isIdleDue, idleDefaultMs } = require('../lib/server-idle.cjs');
const dynamicPlanning = require('./dynamic-planning/index.cjs');

// 单 server 多项目（用户裁定，主键=projectRoot）：每项目一份 ProjectCtx（磁盘锚点/mutable 槽/host），
// 请求带 ?p=<归一化 projectRoot> 路由；不带 p → boot 上下文（与旧单项目行为字节一致）。
const { createProjectRegistry } = require('./project-context.cjs');

/** tmux 工厂：测试注入 global.__CC_TMUX__（对象 mock）时直接复用；生产按会话名建实例（跨项目唯一） */
function tmuxFor(sessionName) {
  return global.__CC_TMUX__ || createTmux(sessionName);
}

// boot 上下文最先建立（projectRoot 由 env.CC_PROJECT||cwd 决定，等同旧定死的 PROJECT_ROOT）
const registry = createProjectRegistry({ env: process.env, tmuxFactory: tmuxFor, RunLogger });
const BOOT = () => registry.ctxFor(); // boot 上下文（no-p 请求 / 遗留单槽导出均定向它）
const PROJECT_ROOT = registry.ctxFor().projectRoot;
const PORT = registry.ctxFor().port; // 单 server 单端口（config port / CC_PORT）

const READY_TIMEOUT_MS = Number(process.env.CC_READY_TIMEOUT_MS || 120000);
const ENTER_DELAY_MS = Number(process.env.CC_ENTER_DELAY_MS || 200);
const LOCAL_CMD_FALLBACK_MS = Number(process.env.CC_LOCAL_CMD_MS || 1500);
const DECISION_FALLBACK_MS = Number(process.env.CC_DECISION_FALLBACK_MS || 300000);
let lastActivityAt = Date.now(); // T1-064 空闲回收：每次请求刷新

// ---- SubagentStop 落账：解析子 Agent 固定格式 RESULT → 写 state ----
/** 解析子 Agent 固定格式 RESULT（`RESULT: {json}`）；成功返回结果对象，失败返回 null */
function parseSubagentResult(body) {
  return extract.parseSubagentResult(body?.last_assistant_message);
}

/** 解析子 Agent 的 NEEDS_INPUT（`NEEDS_INPUT: {json}`）；成功返回 { taskId, question, options?, context? }，否则 null */
function parseSubagentNeedsInput(body) {
  return extract.parseNeedsInput(body?.last_assistant_message);
}

// ---- per-project 落账 / 日志（pcx 首参） ----

function logSubagentEvent(pcx, event, body) {
  try {
    fs.mkdirSync(path.dirname(pcx.subagentEventPath), { recursive: true });
    fs.appendFileSync(pcx.subagentEventPath, JSON.stringify({ ts: new Date().toISOString(), event, body }) + '\n');
  } catch (e) {
    console.log(`[subagent-log] ${e.message}`);
  }
}

function logSubagentFailure(pcx, body, settled) {
  try {
    fs.mkdirSync(path.dirname(pcx.subagentFailedPath), { recursive: true });
    fs.appendFileSync(pcx.subagentFailedPath, JSON.stringify({
      ts: new Date().toISOString(),
      agentId: body.agent_id || body.session_id || 'unknown',
      reason: settled.reason,
      resultTaskId: (parseSubagentResult(body) || {}).taskId || null,
    }) + '\n');
  } catch (e) {
    console.log(`[subagent-fail] ${e.message}`);
  }
}

function logSubagentNeedsInput(pcx, body, needs) {
  try {
    fs.mkdirSync(path.dirname(pcx.subagentNeedsPath), { recursive: true });
    fs.appendFileSync(pcx.subagentNeedsPath, JSON.stringify({
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

/** 每次 run 启动清空驱动 CLI 补发/决策的日志，避免跨 run 残留触发伪补发。 */
function resetRunLogs(pcx) {
  for (const p of [pcx.subagentFailedPath, pcx.subagentNeedsPath]) {
    try { fs.rmSync(p, { force: true }); } catch { /* 无权限时忽略 */ }
  }
}

/** SubagentStop 落账：写 state（task status + exec.result/files/commits）；返回 { ok, taskId?, reason?, recoverable? } */
function settleSubagent(pcx, body) {
  const result = parseSubagentResult(body);
  if (!result) return { ok: false, reason: 'no valid RESULT in last_assistant_message' };
  let out;
  pcx.stores.state.updateSync((s) => {
    if (!s) { out = { ok: false, reason: 'state.json unreadable', recoverable: false }; return false; }
    const task = (s.tasks || []).find((t) => t.id === result.taskId);
    if (!task) { out = { ok: false, reason: `task ${result.taskId} not found` }; return false; }
    if (task.status === 'done' || task.status === 'blocked') {
      out = { ok: false, reason: `task ${result.taskId} already ${task.status}（RESULT taskId 可能错写）`, recoverable: false };
      return false;
    }
    if (!task.exec) task.exec = {};
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

/** override → 向任务列表追加纠偏任务（kind=dev / source=decision_review） */
function appendDecisionReviewTask(pcx, { decision_id, instruction, original_answer }) {
  let out;
  pcx.stores.state.updateSync((s) => {
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

// ---- metrics / diagnosis（pcx 化） ----

function getMetricsSnapshot(pcx) {
  reconcileDiagnosisSession(pcx);
  if (Date.now() - pcx.metricsCache.at < 1000 && pcx.metricsCache.value) return pcx.metricsCache.value;
  pcx.metricsCache = {
    at: Date.now(),
    value: readRunMetrics(pcx.projectRoot, {
      mainSessionId: pcx.mainSessionId,
      activeAgents: [...pcx.agents.values()].filter((a) => a.status === 'running').length,
    }),
  };
  return pcx.metricsCache.value;
}

function reconcileDiagnosisSession(pcx) {
  const record = readDiagnosis(pcx.projectRoot);
  const snapshot = record?.status === 'running' ? record.metrics : null;
  const snapshotSessionId = snapshot?.sources?.mainSessionId;
  if (!snapshotSessionId || snapshotSessionId === pcx.mainSessionId) return;

  const meta = readRunMeta(pcx.projectRoot);
  const existingSubagents = meta.subagents || {};
  const restoredSubagents = Object.keys(existingSubagents).length > 0 ? existingSubagents : Object.fromEntries(
    (snapshot.sources.transcriptPaths || [])
      .filter((transcriptPath) => transcriptPath !== snapshot.sources.mainTranscriptPath)
      .map((transcriptPath) => {
        const agentId = path.basename(transcriptPath, '.jsonl');
        return [agentId, { agentId, status: 'unknown', transcriptPath }];
      }),
  );
  pcx.mainSessionId = snapshotSessionId;
  updateRunMeta(pcx.projectRoot, (current) => ({
    ...current,
    projectRoot: pcx.projectRoot,
    startedAt: snapshot.startedAt || current.startedAt || null,
    mainSessionId: snapshotSessionId,
    subagents: restoredSubagents,
    updatedAt: new Date().toISOString(),
  }));
  pcx.metricsCache = { at: 0, value: null };
  console.log('[diagnosis] restored main session from diagnostic snapshot');
}

function readProjectState(pcx) {
  return pcx.stores.state.readSync() || {};
}

async function startRunDiagnosis(pcx) {
  if (pcx.diagnosisInFlight) return { ok: false, error: 'diagnosis already running' };

  const metrics = getMetricsSnapshot(pcx);
  const stateSnapshot = readProjectState(pcx);
  const pending = writeDiagnosis(pcx.projectRoot, {
    status: 'running',
    requestedAt: new Date().toISOString(),
    metrics,
    state: stateSnapshot,
    runMeta: readRunMeta(pcx.projectRoot),
  });
  pcx.diagnosisInFlight = true;

  // oneshot 端口由调用方（装配根）注入：lib 不再直接依赖 adapters（T1-117 消除 lib → adapters 越界）
  Promise.resolve(diagnoseWithClaude(buildDiagnosisPrompt(metrics, stateSnapshot), pcx.projectRoot, { oneshot: oneshotPort }))
    .then((result) => {
      writeDiagnosis(pcx.projectRoot, {
        ...pending,
        status: result.ok ? 'complete' : 'failed',
        completedAt: new Date().toISOString(),
        diagnosis: result.diagnosis || null,
        error: result.ok ? null : result.error || 'unknown diagnosis error',
      });
    })
    .catch((error) => {
      writeDiagnosis(pcx.projectRoot, {
        ...pending,
        status: 'failed',
        completedAt: new Date().toISOString(),
        diagnosis: null,
        error: error.message,
      });
    })
    .finally(() => { pcx.diagnosisInFlight = false; });

  return { ok: true, diagnosis: pending };
}

// ---- ready/busy state machine（pcx 化） ----

/** 是否为影响主 ready/busy 的会话：mainSessionId 未记录或 payload 无 session_id 时向后兼容，全接受 */
function isMainSession(pcx, body) {
  return !pcx.mainSessionId || !body.session_id || body.session_id === pcx.mainSessionId;
}

/** T1-091：把决策闸门事件推入 run host 事件环（host 未装配时静默跳过） */
function publishHostEvent(pcx, type, payload) {
  if (pcx.runHost && typeof pcx.runHost.publish === 'function') {
    try { pcx.runHost.publish(type, payload); } catch { /* 推送失败不影响决策/执行主流程 */ }
  }
}

function setDecision(pcx, d) {
  const opening = pcx.decisionPending == null && d != null;
  pcx.decisionPending = d;
  if (opening) {
    publishHostEvent(pcx, 'decision.required', {
      type: d.type || null,
      question: d.question || null,
      options: d.options || null,
      source: d.source || null,
    });
  }
}

function clearDecision(pcx) {
  pcx.decisionPending = null;
}

function setReady(pcx) {
  pcx.state = 'ready';
  const pending = pcx.waiters;
  pcx.waiters = [];
  for (const fn of pending) fn();
}

function setBusy(pcx) {
  pcx.state = 'busy';
}

function waitReady(pcx, timeout) {
  if (pcx.state === 'ready') return Promise.resolve(true);
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
      pcx.waiters = pcx.waiters.filter((w) => w !== fn);
      resolve(false);
    }, timeout);
    pcx.waiters.push(fn);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function submit(pcx, text) {
  pcx.tmux.sendText(text);
  await sleep(ENTER_DELAY_MS);
  pcx.tmux.sendEnter();
}

/**
 * 注入一条 prompt 并等本回合收尾（/send 的 busy 语义 + 等回 ready）。
 * 就绪超时不抛（由上层回查 state 决定下一步），返回 false 表示本次未能注入/未等到收尾。
 */
async function sendPromptAndWait(pcx, text) {
  const ok = await waitReady(pcx, READY_TIMEOUT_MS);
  if (!ok) return false;
  pcx.logger.captureFromTranscript();
  setBusy(pcx);
  pcx.logger.logPrompt(text);
  await submit(pcx, text);
  return waitReady(pcx, READY_TIMEOUT_MS);
}

/**
 * 发送本地 slash 命令（/clear 等）：等就绪 → 标 busy → 注入 → 起超时兜底。
 * 本地命令不产生 Stop hook，故用 LOCAL_CMD_FALLBACK_MS 兜底回 ready。
 * @returns {Promise<boolean>} 是否已注入（false = 等就绪超时）
 */
async function sendLocalCmd(pcx, cmd) {
  const ok = await waitReady(pcx, READY_TIMEOUT_MS);
  if (!ok) return false;
  setBusy(pcx);
  await submit(pcx, cmd);
  if (pcx.fallbackTimer) clearTimeout(pcx.fallbackTimer);
  pcx.fallbackTimer = setTimeout(() => { if (pcx.state === 'busy') setReady(pcx); }, LOCAL_CMD_FALLBACK_MS);
  return true;
}

/** sid run 槽 hook 处理（T1-071：路由到独立内存态；gate 关等价 complete，gate 开全闸门留决策接入） */
function handleSidHook(pcx, sid, event, body, res) {
  const slot = pcx.runSlotFor(sid);
  console.log(`[hook:${sid}] ${event} -> ${slot.state}`);
  if (event === 'SessionStart') {
    slot.setReady();
  } else if (event === 'UserPromptSubmit') {
    slot.setBusy();
  } else if (event === 'Stop') {
    if (!pcx.decisionEnabled()) slot.clearDecision();
    slot.setReady();
  } else if (event === 'PreToolUse' && body?.tool_name === 'AskUserQuestion') {
    const questions = body?.tool_input?.questions;
    const q = Array.isArray(questions) ? questions[0] : null;
    if (q && !pcx.decisionEnabled()) {
      slot.setDecision({
        type: q.multiSelect ? 'multiSelect' : 'choice',
        multiSelect: !!q.multiSelect,
        question: q.question,
        options: (q.options || []).map((o) => o.label),
        header: q.header || null,
        source: 'AskUserQuestion',
      });
    }
  }
  return send(res, 200, { ok: true, event: event || null, state: slot.state, sid });
}

// ---- decision gate（v0.2.0，单 agent）：Stop 统一决策闸门（pcx 化） ----
function nextDecisionId(pcx) {
  return pcx.decisionSeqGen.nextId();
}

/** 无有效结果兜底（构造归位 decision-gate.deferredFallbackResult） */
function deferredFallbackResult() {
  return gateRules.deferredFallbackResult();
}

/** 捕获落盘 + 置 decisionResume */
function persistDecision(pcx, result, source) {
  const decisionId = nextDecisionId(pcx);
  const createdAt = new Date().toISOString();
  const record = gateRules.buildCompletedRecord({ decisionId, result, source, createdAt });
  const appended = pcx.newDecisionStore().append(record);
  if (!appended.appended) console.log(`[decision-gate] append skipped for ${decisionId}`);
  pcx.logger.logDecision({
    at: createdAt,
    decisionId,
    event: 'decision_completed',
    detail: result.fallback === true ? `fallback type=${result.type}` : `resolved type=${result.type}`,
  });
  pcx.decisionResume = {
    decision_id: decisionId,
    answer: result.answer,
    type: result.type,
    finality: result.finality,
    fallback: result.fallback === true,
  };
  publishHostEvent(pcx, 'decision.record', {
    decisionId,
    answer: result.answer ?? null,
    type: result.type ?? null,
    finality: result.finality ?? null,
    fallback: result.fallback === true,
  });
  return decisionId;
}

/** AskUserQuestion 的 PreToolUse 决策化（pcx 化） */
function handleAskUserQuestion(pcx, body) {
  const questions = body.tool_input?.questions;
  if (!questions || questions.length === 0) return null;

  const deciding = pcx.decisionGate?.phase === 'deciding';
  const action = gateRules.classifyAskQuestion({ enabled: pcx.decisionEnabled(), deciding, questions });

  if (action.kind === 'capture') {
    const q = action.question || questions[0];
    setDecision(pcx, {
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

/** Stop 统一闸门；返回可选 { ccOutput }（pcx 化） */
function handleStop(pcx, body) {
  const text = typeof body?.last_assistant_message === 'string' ? body.last_assistant_message : '';
  const deciding = pcx.decisionGate?.phase === 'deciding';
  const branch = gateRules.classifyStop({
    enabled: pcx.decisionEnabled(),
    text,
    deciding,
    stopHookActive: body?.stop_hook_active,
  });

  if (branch.branch === 'deciding') {
    const startedAt = new Date().toISOString();
    pcx.decisionGate = { phase: 'deciding', startedAt };
    pcx.decisionResume = null;
    pcx.logger.logDecision({ at: startedAt, decisionId: null, event: 'decision_started', detail: '决策入口（<AWF_DECISION_REQUIRED>）' });
    let instruction;
    try {
      instruction = decisionInstruction.readDecisionInstruction();
    } catch (e) {
      instruction = '决策模式：请产出 <AWF_DECISION_RESULT> 包裹的 Decision Result。';
    }
    return ccShapes.blockDecision(instruction);
  }

  if (branch.branch === 'resolve') {
    const parsed = parseDecisionResult(text);
    if (!parsed.valid) console.log(`[decision-gate] no valid result (${parsed.error}); deferred fallback`);
    persistDecision(pcx, parsed.valid ? parsed.result : deferredFallbackResult(), 'text');
    pcx.decisionGate = null;
    clearDecision(pcx);
    setReady(pcx);
    pcx.logger.captureFromTranscript();
    return null;
  }

  // complete
  clearDecision(pcx);
  pcx.decisionGate = null;
  pcx.decisionResume = null;
  setReady(pcx);
  pcx.logger.captureFromTranscript();
  return null;
}

// ---- 常驻 run host（T1-105）：每项目一份 ----

/** 单 agent 默认执行器（真实模型通道 v1）：发任务 prompt 到本项目交互会话 → 等任务自我结算。 */
function defaultSingleExecutor(pcx) {
  return {
    runTask: async ({ taskId, task, taskIndex = 1 }) => {
      const text = task.prompt || task.title || task.id;
      if (!pcx.tmux.hasSession()) throw new Error(`tmux session '${pcx.tmux.SESSION}' not found; run bootstrap.sh`);
      // pause 编排闩锁：w-monitor 暂停（awf_mode pause）后不得再派发新任务——这是 w-monitor.md
      // 「等待 CLI 不再派发新任务」与 run.js preservePause 的前提。多 agent 派发（batchTransportFor.send）
      // 与会话通道提示词（sessionChannel.send）都走了 waitWhilePaused，唯独单 agent 的主任务派发漏了，
      // 导致默认 max=1 路径在暂停期间照常推进（T1-108 真机 pause case 暴露）。
      const { waitWhilePaused } = await import('../lib/pause.js');
      // 派发闩锁：暂停期间不派发新任务；但若这个任务已被别处结算（done/blocked），不必再等
      const gate = await waitWhilePaused(pcx.projectRoot, {
        label: `dispatch:${taskId}`,
        log: pauseNoticeLog(pcx),
        isSettled: () => {
          const st = currentTaskStatus(pcx, taskId);
          return st === 'done' || st === 'blocked';
        },
      });
      if (gate.releasedBy === 'settled') {
        const st = currentTaskStatus(pcx, taskId);
        notice(pcx, 'pause', 'ok', `任务 ${taskId} 在暂停期间已结算（${st}），不再派发`);
        return { status: st };
      }
      const ready = await waitReady(pcx, READY_TIMEOUT_MS);
      if (!ready) throw new Error('still busy (ready timeout)');

      // 任务前上下文压缩检查（跳过首个任务；实测 ≥ 阈值或无实测才打扰 AI，见 task-channel.cjs）
      const channel = await sessionChannel(pcx);
      const prompt = await channel.maybeCompactContext(text, taskIndex);

      pcx.logger.captureFromTranscript();
      setBusy(pcx);
      pcx.logger.logPrompt(prompt);
      await submit(pcx, prompt);

      // 等任务自我结算：CC 仍在跑（busy）→ 不计时、永不误判超时（真 run 这类长任务可远超墙钟上限）；
      // 仅当 CC 已就绪(idle)且任务仍未结算时，累计「无变化窗口」，超窗才进入收尾协商
      // （docs/bugs/timeout-must-confirm-no-cc-change.md：需确认 CC 无变化才算超时）。
      let idleSince = null;
      for (;;) {
        await sleep(500);
        const s = pcx.stores.state.readSync();
        const t = s?.tasks?.find((x) => x.id === taskId);
        if (t && (t.status === 'done' || t.status === 'blocked')) return { status: t.status };
        // 等人工决策应答：人类思考无上限，不计时也不进收尾协商（否则会在用户思考时把任务判死）
        if (pcx.decisionPending && !pcx.decisionPending.answered) { idleSince = null; continue; }
        if (pcx.state === 'busy') { idleSince = null; continue; } // CC 仍在推进 → 重置无变化窗口
        const now = Date.now();
        if (idleSince == null) idleSince = now;
        else if (now - idleSince >= READY_TIMEOUT_MS) break; // CC 已停且无变化 → 交收尾协商
      }

      // 收尾协商（迁自重构前 cli/run.js）：wrapup → 最多 3 轮 taskSettle → 标 blocked 跳过。
      // 不再直接抛「未自我结算」——CC 忘记落账是常态，编排要能自愈并继续推进。
      const settled = await channel.settleTask(taskId);
      return { status: settled === 'done' ? 'done' : 'blocked' };
    },
  };
}

/**
 * 会话通道（每项目惰性单例，缓存于 pcx.taskChannel）：把 task-channel.cjs 的端口接到本项目现场。
 * prompts 走插件模板（plugin-bridge 边界唯一模块），state 走本项目 store，pause 走 lib/pause.js。
 */
function sessionChannel(pcx) {
  if (pcx.taskChannel) return pcx.taskChannel;
  pcx.taskChannel = (async () => {
    const bridge = await import('../lib/plugin-bridge.js');
    const { waitWhilePaused } = await import('../lib/pause.js');
    const fsp = require('fs/promises');
    const { createSessionChannel } = require('./task-channel.cjs');
    /** 发 prompt 并等会话回 ready（与重构前 cli/run.js sendPrompt 同语义：超时由上层的状态回查兜底） */
    const send = async (text, label = 'session-channel') => {
      await waitWhilePaused(pcx.projectRoot, { label, log: pauseNoticeLog(pcx) });
      return sendPromptAndWait(pcx, text);
    };
    return createSessionChannel({
      send,
      readTaskStatus: (id) => (pcx.stores.state.readSync()?.tasks || []).find((t) => t.id === id)?.status || null,
      markBlocked: (id) => pcx.stores.state.updateSync((s) => {
        const t = (s?.tasks || []).find((x) => x.id === id);
        if (!t) return false;
        t.status = 'blocked';
        return true;
      }),
      prompts: { wrapup: bridge.taskWrapup, settle: bridge.taskSettle, contextCheck: bridge.contextCheck },
      readUsagePct: async () => {
        try {
          const pct = JSON.parse(await fsp.readFile(path.join(pcx.projectRoot, '.awf', 'context', 'usage.json'), 'utf-8')).used_percentage;
          return typeof pct === 'number' ? pct : null;
        } catch { return null; }
      },
      readHandoffSnapshot: async () => {
        try { return await fsp.readFile(path.join(pcx.projectRoot, '.awf', 'context', 'handoff.md'), 'utf-8'); } catch { return null; }
      },
      consumeContextReady: () => { const r = pcx.contextReady; pcx.contextReady = false; return !!r; },
      // 本轮有无产出：主会话 transcript 字节数（拿不到会话 id/文件 → null，退化按轮数判定）
      readTurnBytes: () => {
        const file = mainTranscriptPath(pcx.projectRoot, pcx.mainSessionId);
        if (!file) return null;
        try { return fs.statSync(file).size; } catch { return null; }
      },
      // 是否正在等人工决策应答（awf_await_choice/await_input 或 AskUserQuestion 上抛后未答）
      isAwaitingHuman: () => !!pcx.decisionPending && !pcx.decisionPending.answered,
      // /clear 是本地 slash 命令（无 Stop hook）：走 sendLocalCmd 的 busy + 兜底回 ready 语义
      clearSession: () => sendLocalCmd(pcx, '/clear'),
      // 收尾协商自己拿这个闩锁等（带「目标任务已结算就放行」谓词）：事故就是在 send 里被闩住看不见
      waitWhilePaused: (opts = {}) => waitWhilePaused(pcx.projectRoot, { log: pauseNoticeLog(pcx), ...opts }),
      log: (level, msg) => notice(pcx, 'settle', level, msg),
    });
  })().catch((err) => {
    pcx.taskChannel = null;
    throw err;
  });
  return pcx.taskChannel;
}

/** 装配 run host（每项目惰性单例；失败记录原因不抛） */
async function bootstrapRunHost(pcx) {
  if (pcx.runHostReady) return pcx.runHostReady;
  pcx.runHostReady = (async () => {
    const override = global.__CC_RUN_HOST_DEPS__; // 测试整体覆盖
    let stateApi;
    let cfg;
    let chain;
    let schedulerFn;
    let gateFix;
    let executor;
    let batch;
    if (override) {
      stateApi = override.stateApi;
      cfg = override.cfg;
      chain = override.chain;
      schedulerFn = override.scheduler;
      gateFix = override.handleGateCompletion;
      executor = override.executor;
      batch = override.batch;
    } else {
      const state = await import('../lib/state.js');
      stateApi = {
        loadState: (r) => state.loadState(r),
        saveState: (r, s) => state.saveState(r, s),
        markTaskActive: (r, id) => state.markTaskActive(r, id),
        requeueTaskIfActive: (r, id) => state.requeueTaskIfActive(r, id),
        findNextTask: (s) => state.findNextTask(s),
        setWorkflowMode: (r, m) => state.setWorkflowMode(r, m),
        backupState: (r) => state.backupState(r), // run 结束版本归档（host drive 收尾调用）
      };
      const rc = await import('../lib/run-config.js');
      cfg = rc.loadRunConfig(pcx.projectRoot);
      const sch = await import('./run-scheduler.js');
      schedulerFn = sch.runScheduler;
      const gf = await import('./gate-fix.js');
      gateFix = gf.handleGateCompletion;
      chain = require('./run-driver.cjs');
      executor = defaultSingleExecutor(pcx);
      batch = await batchTransportFor(pcx, stateApi);
    }
    const { createRunHost } = require('./run-host.cjs');
    const host = createRunHost({
      projectRoot: pcx.projectRoot,
      cfg,
      state: stateApi,
      chain,
      handleGateCompletion: gateFix,
      scheduler: schedulerFn,
      executor,
      batch,
    });
    host.start();
    pcx.runHost = host;
    return host;
  })().catch((err) => {
    pcx.runHostBootErr = err;
    console.error(`[server] run host bootstrap 失败: ${err.message}`);
    return null;
  });
  return pcx.runHostReady;
}

/** 任一项目上下文宿主有 run 在驱动（空闲回收 / shutdown 判定） */
function anyHostActive() {
  for (const c of registry.all()) {
    if (!c.runHost) continue;
    try {
      const all = c.runHost.snapshot();
      if ((all?.runs || []).some((r) => r.status === 'queued' || r.status === 'running')) return true;
    } catch { /* ignore */ }
  }
  return false;
}

/** 惰性装载 state 写原语；测试可经 __CC_RUN_HOST_DEPS__.stateApi 覆盖 */
async function ensureRunStateApi(pcx) {
  if (pcx.runStateApiReady) return pcx.runStateApiReady;
  pcx.runStateApiReady = (async () => {
    const override = global.__CC_RUN_HOST_DEPS__?.stateApi;
    if (override) {
      pcx.runStateApi = {
        saveState: override.saveState || (() => false),
        replaceStateIfUnchanged: override.replaceStateIfUnchanged || null,
        setWorkflowMode: override.setWorkflowMode || (() => false),
        markTaskActive: override.markTaskActive || (() => false),
        backupState: override.backupState || (() => undefined),
      };
      return pcx.runStateApi;
    }
    const state = await import('../lib/state.js');
    pcx.runStateApi = {
      saveState: (r, s) => state.saveState(r, s),
      replaceStateIfUnchanged: (r, s, expected, fingerprint) => (
        state.replaceStateIfUnchanged(r, s, expected, fingerprint)
      ),
      setWorkflowMode: (r, m) => state.setWorkflowMode(r, m),
      markTaskActive: (r, id) => state.markTaskActive(r, id),
      backupState: (r) => state.backupState(r),
    };
    return pcx.runStateApi;
  })().catch((err) => {
    pcx.runStateApi = null;
    pcx.runStateApiReady = null;
    console.error(`[server] state api 装载失败: ${err.message}`);
    return null;
  });
  return pcx.runStateApiReady;
}

/**
 * 多 agent 传输（宿主侧）：把 batch-transport.cjs 的端口接到本项目现场。
 * 派发经会话注入 subagentDispatch 提示词（主会话派生后台子 Agent），完成感知轮询本项目 state
 * + 落账失败/决策上抛日志（pcx.subagent*Path）。调度权在 run-host（driveBatch → runScheduler）。
 */
async function batchTransportFor(pcx, stateApi) {
  const bridge = await import('../lib/plugin-bridge.js');
  const { waitWhilePaused } = await import('../lib/pause.js');
  const { createBatchTransport } = require('./batch-transport.cjs');
  return createBatchTransport({
    send: async (text, label = 'batch-send') => {
      await waitWhilePaused(pcx.projectRoot, { label, log: pauseNoticeLog(pcx) });
      // 派发不能静默丢失：主会话不就绪/未收尾 → 抛错让 run 显式失败，而不是让任务悬着等超时
      const ok = await sendPromptAndWait(pcx, text);
      if (!ok) throw new Error(`派发未送达（主会话未在超时内就绪/收尾）：${String(text).slice(0, 60)}…`);
    },
    prompts: { subagentDispatch: bridge.subagentDispatch, resend: bridge.subagentResend },
    markActive: (id) => stateApi.markTaskActive(pcx.projectRoot, id),
    releaseActive: (id) => stateApi.requeueTaskIfActive?.(pcx.projectRoot, id) ?? false,
    readTasks: () => pcx.stores.state.readSync()?.tasks || [],
    isBusy: () => pcx.state === 'busy',
    decisionPending: () => pcx.decisionPending,
    failedPath: pcx.subagentFailedPath,
    needsPath: pcx.subagentNeedsPath,
    eventsPath: pcx.subagentEventPath,
    waitWhilePaused: (opts = {}) => waitWhilePaused(pcx.projectRoot, { log: pauseNoticeLog(pcx), ...opts }),
    log: (level, msg) => notice(pcx, 'batch', level, msg),
  });
}

/** 门禁完成处理函数（server 进程内执行 gate-fix 同一实现；测试可经 deps 覆盖） */
async function runStateGateHandler() {
  const override = global.__CC_RUN_HOST_DEPS__?.handleGateCompletion;
  if (override) return override;
  const gf = await import('./gate-fix.js');
  return gf.handleGateCompletion;
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
function requirePaused(pcx, res) {
  const s = pcx.stores.state.readSync();
  if (s?.mode === 'pause') return true;
  send(res, 409, { ok: false, error: `intervention requires mode=pause (current: ${s?.mode || 'unknown'})` });
  return false;
}

// ---- T1-093 web 构建产物静态托管 ----
const WEB_PUBLIC_DEFAULT = path.join(__dirname, 'public');
function webPublicRoot() {
  return process.env.CC_WEB_PUBLIC || WEB_PUBLIC_DEFAULT;
}
function webIndexHtml() {
  try { return fs.readFileSync(path.join(webPublicRoot(), 'index.html')); } catch { return null; }
}

/**
 * 前端页面路径 —— 一律由 web/ 构建产物承载（T1-119）。
 * 退役前这些都各自读一个 legacy html（dashboard/decisions/diagnostics），theme.css/common.js 也由
 * server 单独托管；现在只剩 `src/server/public` 一个来源，别再往回加页面。
 */
const PAGE_PATHS = new Set([
  '/', '/dashboard', '/dashboard.html', '/diagnostics', '/diagnostics.html', '/decisions', '/decisions.html',
]);
/** 惰性实例；每次构建（无缓存）以让 CC_WEB_PUBLIC 覆盖即时生效 */
function webHostInstance() {
  if (!webIndexHtml()) return null;
  return createStaticHost({ root: webPublicRoot(), aliases: { '/': 'index.html' }, spa: 'index.html' });
}

/**
 * 编排层运维通知（T1-111 可观测 / T1-112 落盘）：一份进**本项目运行日志**（人读、w-monitor 读），
 * 一份进 **console** —— 自 T1-112 起 server 的 stdout/stderr 被接到 `.awf/logs/server.log`，
 * 于是「宿主在等什么、等多久」既在 run 日志里也在 server 日志里，不必再靠 transcript 反推。
 */
function notice(pcx, kind, level, msg) {
  pcx.logger?.logNotice?.(kind, `[${level}] ${msg}`);
  console.error(`[${kind}][${level}] ${msg}`);
}

/** pause 闩锁的日志出口 */
function pauseNoticeLog(pcx) {
  return (level, msg) => notice(pcx, 'pause', level, msg);
}

/** 读某任务当前状态（闩锁用它判断「我等的目标任务是否已被别处结算」） */
function currentTaskStatus(pcx, taskId) {
  return (pcx.stores.state.readSync()?.tasks || []).find((t) => t.id === taskId)?.status || null;
}

/** 每项目一份动态规划服务；协议/策略/记录均锚定对应 projectRoot。 */
function dynamicPlanningFor(pcx) {
  if (!pcx.dynamicPlanning) {
    pcx.dynamicPlanning = dynamicPlanning.createDynamicPlanningService({
      projectRoot: pcx.projectRoot,
      decisionPort: dynamicPlanning.createDynamicPlanningDecisionPort({
        storeFactory: () => pcx.newDecisionStore(),
      }),
    });
  }
  return pcx.dynamicPlanning;
}

// 解析一次请求的项目上下文：p 归一化；缺省 → boot（兼容存量无 p 请求/测试）
function resolveCtxForUrl(url) {
  return registry.resolveCtx({ p: url.searchParams.get('p') });
}

/**
 * 不读不写任何项目 state 的 server 全局端点：唯一的写类例外。
 * （其余写类端点缺 ?p 一律拒绝——见 writeNeedsProject）
 */
const PROJECT_AGNOSTIC_WRITES = new Set(['/shutdown']);

/**
 * 写类请求是否必须显式带 ?p。
 *
 * 事故背景（2026-09-10）：w-monitor 手写
 * `curl -X POST http://localhost:8787/run/state/mode -d '{"mode":"pause"}'`（**没带 ?p**），
 * resolveCtx 的 `p || bodyProjectRoot || projectRoot || boot` 静默兜底到 boot 项目
 * （= 启动 server 的那个项目），把正在跑的 cc-control run 暂停了 4 小时。
 *
 * 规则：非 GET/HEAD/OPTIONS 的请求必须显式声明项目作用域，不再兜底到 boot。
 * 正常调用方都带 p：hook 网关（bootstrap 注入 CC_PROJECT → `&p=`）、CLI（client 的 projectQuery）、
 * MCP（AWF_PROJECT_ROOT）。真正没有项目作用域的只有 /shutdown。
 */
function writeNeedsProject(method, pathname) {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  return !PROJECT_AGNOSTIC_WRITES.has(pathname);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  lastActivityAt = Date.now(); // 任何请求视为活动（空闲回收计时刷新）

  // 写类端点缺 ?p → 400，绝不兜底到 boot（T1-110）
  if (writeNeedsProject(req.method, pathname) && !url.searchParams.get('p')) {
    // 以前这里**不留痕**：hook 链整条断掉时，server 侧只剩「一条 [hook] 都没有」，分不清是没发还是被丢
    // （issue 009 —— run 卡 still busy 死亡却查不到原因）。故必须响。
    console.warn(`[hook] 拒绝写请求 ${req.method} ${pathname}：缺 ?p（来源 ${req.socket?.remoteAddress || '?'}）。`
      + '若这是 /hook，说明 hook 网关没拿到 CC_PROJECT（bootstrap 注入缺失）');
    return send(res, 400, {
      ok: false,
      error: `写类端点缺 ?p：拒绝兜底到 boot 项目（${registry.bootRoot}）。请显式带 ?p=<projectRoot>；`
        + 'hook 网关 / CLI / MCP 会自动带上。',
      endpoint: pathname,
    });
  }

  const pcx = resolveCtxForUrl(url); // 顶层解一次；后续分支均操作 pcx

  // 前端页面：只由 web/ 构建产物承载（T1-119 退役 legacy 观测页与 theme.css/common.js）。
  // 产物缺失时**明确告警** —— 不给空白页、也不静默 404：说清缺什么、怎么补。
  if (req.method === 'GET' && PAGE_PATHS.has(pathname)) {
    const idx = webIndexHtml();
    if (idx) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(idx);
    }
    const expected = path.join(webPublicRoot(), 'index.html');
    console.warn(`[web] 前端产物缺失：${expected} —— 请运行 npm run build（会构建 web/ → src/server/public）`);
    return send(res, 503, {
      ok: false,
      error: '前端产物缺失：请运行 npm run build（构建 web/ → src/server/public）',
      expected,
    });
  }

  // hook callback
  if (req.method === 'POST' && pathname === '/hook') {
    const body = (await readJson(req)) || {};
    const event = body.event || url.searchParams.get('event');
    let hookCcOutput = null;

    // T1-071：带 sid 的 hook → 按 sid 路由到该项目内独立 run 槽；无 sid 走该项目单槽
    const hookSid = url.searchParams.get('sid');
    if (hookSid) {
      handleSidHook(pcx, hookSid, event, body, res);
      return;
    }

    if (event === 'SessionStart') {
      if (pcx.diagnosisInFlight && body.session_id && body.session_id !== pcx.mainSessionId) {
        console.log(`[diagnosis] ignored isolated SessionStart ${body.session_id}`);
        return send(res, 200, { ok: true, event: event || null, state: pcx.state });
      }
      if (body.session_id && body.session_id !== pcx.mainSessionId) {
        resetRunLogs(pcx);
        resetRunMeta(pcx.projectRoot);
        pcx.metricsCache = { at: 0, value: null };
      }
      if (body.session_id) pcx.mainSessionId = body.session_id;
      pcx.sessionSeq += 1; // 会话启动序号（CLI 等「本次会话已就绪」的信号，见 run.js waitSessionStarted）
      updateRunMeta(pcx.projectRoot, (meta) => ({
        ...meta,
        projectRoot: pcx.projectRoot,
        startedAt: meta.startedAt || new Date().toISOString(),
        endedAt: null,
        mainSessionId: body.session_id || meta.mainSessionId || null,
        updatedAt: new Date().toISOString(),
      }));
      setReady(pcx);
      pcx.logger.resetTranscript();
    } else if (event === 'UserPromptSubmit') {
      if (isMainSession(pcx, body)) setBusy(pcx);
    } else if (event === 'Stop') {
      if (isMainSession(pcx, body)) {
        const out = handleStop(pcx, body);
        if (out) hookCcOutput = out.ccOutput;
      }
    } else if (event === 'SubagentStart') {
      logSubagentEvent(pcx, event, body);
      if (pcx.mainSessionId && body.session_id && body.session_id !== pcx.mainSessionId) {
        console.log(`[subagent-start] skip external session ${body.session_id}`);
      } else {
        const key = body.agent_id || body.session_id || 'unknown';
        pcx.agents.set(key, { sessionId: body.session_id || null, status: 'running', startedAt: Date.now() });
        updateRunMeta(pcx.projectRoot, (meta) => ({
          ...meta,
          projectRoot: pcx.projectRoot,
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
      logSubagentEvent(pcx, event, body);
      if (pcx.mainSessionId && body.session_id && body.session_id !== pcx.mainSessionId) {
        console.log(`[subagent-stop] skip external session ${body.session_id}`);
      } else {
        const a = pcx.agents.get(key);
        if (a) a.status = 'stopped';
        updateRunMeta(pcx.projectRoot, (meta) => ({
          ...meta,
          projectRoot: pcx.projectRoot,
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
      if (!a) {
        console.log(`[subagent-stop] skip untracked agent ${key} (no SubagentStart)`);
      } else {
        const needs = parseSubagentNeedsInput(body);
        const result = needs ? null : parseSubagentResult(body);
        pcx.logger.captureSubagentTranscript(body, needs?.taskId || result?.taskId, key);
        if (needs) {
          logSubagentNeedsInput(pcx, body, needs);
          console.log(`[subagent-needs] ${needs.taskId}: ${needs.question.slice(0, 40)}`);
        } else {
          const settled = settleSubagent(pcx, body);
          if (!settled.ok) {
            console.log(`[subagent-settle] ${settled.reason} (agent ${key})`);
            if (settled.recoverable !== false) logSubagentFailure(pcx, body, settled);
          } else {
            console.log(`[subagent-settle] ${settled.taskId} -> ${settled.status}`);
          }
        }
      }
      }
    }

    // PreToolUse(AskUserQuestion)
    if (event === 'PreToolUse' && body.tool_name === 'AskUserQuestion') {
      const out = handleAskUserQuestion(pcx, body);
      if (out) hookCcOutput = out.ccOutput;
    }

    // PostToolUse 兜底
    if (event === 'PostToolUse' && body.tool_name === 'AskUserQuestion') {
      const prev = pcx.decisionPending;
      const resp = body.tool_response;
      console.log(`[hook] AskUserQuestion answered, raw: ${JSON.stringify(resp).slice(0, 300)}`);
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
        setDecision(pcx, { ...prev, answer, answered: true });
      }
    }

    console.log(`[hook] ${event} -> ${pcx.state}`);
    const hookResp = { ok: true, event: event || null, state: pcx.state };
    if (hookCcOutput) hookResp.ccOutput = hookCcOutput;
    return send(res, 200, hookResp);
  }

  // ---- state.json ----
  if (req.method === 'GET' && pathname === '/awf/state') {
    const sid = url.searchParams.get('sid');
    const s = sid ? storeCore.readJsonSync(pcx.runStateFile(sid)) : pcx.stores.state.readSync();
    if (s == null) return send(res, 404, { ok: false, error: `state.json not found${sid ? ` for run ${sid}` : ''}` });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(s, null, 2));
  }

  if (req.method === 'GET' && pathname === '/awf/metrics') {
    return send(res, 200, { ok: true, metrics: getMetricsSnapshot(pcx) });
  }

  if (req.method === 'GET' && pathname === '/awf/diagnostics') {
    return send(res, 200, { ok: true, diagnosis: readDiagnosis(pcx.projectRoot) });
  }

  // 动态任务规划读取面：proposal 数据边界先稳定，未来 UI/复审器可直接消费。
  if (req.method === 'GET' && pathname === '/awf/dynamic-planning/proposals') {
    const proposalId = url.searchParams.get('proposalId');
    const service = dynamicPlanningFor(pcx);
    if (proposalId) {
      const proposal = service.get(proposalId);
      return proposal
        ? send(res, 200, { ok: true, proposal })
        : send(res, 404, { ok: false, error: `dynamic planning proposal not found: ${proposalId}` });
    }
    return send(res, 200, { ok: true, proposals: service.list() });
  }

  if (req.method === 'POST' && pathname === '/awf/diagnostics') {
    const result = await startRunDiagnosis(pcx);
    return send(res, result.ok ? 202 : 409, result);
  }

  // ---- Review 数据：决策聚合列表 ----
  if (req.method === 'GET' && pathname === '/awf/decisions') {
    const store = pcx.newDecisionStore();
    const decisions = store.listAll();
    return send(res, 200, { ok: true, total: decisions.length, decisions });
  }

  // 人工前置 decision：当前只接动态规划 subject。该入口不暴露给 AI MCP，
  // 人工结论是 decision_required proposal 的唯一执行授权。
  const decisionResolve = pathname.match(/^\/awf\/decisions\/([^/]+)\/resolve$/);
  if (req.method === 'POST' && decisionResolve) {
    const decisionId = decodeURIComponent(decisionResolve[1]);
    const body = (await readJson(req)) || {};
    try {
      const result = dynamicPlanningFor(pcx).resolveDecision(decisionId, body);
      return send(res, 200, { ok: true, ...result });
    } catch (error) {
      return send(res, 409, { ok: false, error: error.message });
    }
  }

  // ---- Review override ----
  if (req.method === 'POST' && pathname.startsWith('/awf/decisions/') && pathname.endsWith('/override')) {
    const decisionId = decodeURIComponent(pathname.slice('/awf/decisions/'.length, -'/override'.length));
    const body = (await readJson(req)) || {};
    const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
    if (!instruction) return send(res, 400, { ok: false, error: 'override 需要非空 instruction' });
    try {
      const store = pcx.newDecisionStore();
      const r = store.override(decisionId, {
        instruction,
        original_answer: typeof body.original_answer === 'string' ? body.original_answer : null,
      });
      pcx.logger.logDecision({
        at: new Date().toISOString(),
        decisionId,
        event: 'decision_overridden',
        detail: `instruction=${instruction.slice(0, 40)}`,
      });
      const task = appendDecisionReviewTask(pcx, {
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
    const statusSid = url.searchParams.get('sid');
    if (statusSid) {
      const slot = pcx.runSlotFor(statusSid);
      return send(res, 200, {
        ok: true, sid: statusSid,
        state: slot.state,
        decisionPending: slot.decisionPending,
        contextReady: slot.contextReady,
        projectRoot: pcx.projectRoot,
      });
    }
    const out = {
      ok: true, state: pcx.state, session: pcx.tmux.hasSession(), projectRoot: pcx.projectRoot,
      decisionPending: pcx.decisionPending, contextReady: pcx.contextReady,
      decisionGate: pcx.decisionGate, decisionResume: pcx.decisionResume,
      mainSessionId: pcx.mainSessionId,
      sessionSeq: pcx.sessionSeq,
      activeAgents: [...pcx.agents.values()].filter((a) => a.status === 'running').length,
    };
    // 单 server 多项目：无 p（boot）请求增量返回已注册项目列表；?p 请求不带该列表
    if (!url.searchParams.get('p')) out.projects = registry.list();
    if (url.searchParams.get('snapshot')) {
      try { out.snapshot = pcx.tmux.capture(); } catch { out.snapshot = null; }
    }
    return send(res, 200, out);
  }

  // 上下文压缩快照就绪标记
  if (req.method === 'POST' && pathname === '/context-ready') {
    pcx.contextReady = true;
    console.log('[context-ready] 快照就绪，待 CLI /clear');
    return send(res, 200, { ok: true, contextReady: pcx.contextReady });
  }

  if (req.method === 'GET' && pathname === '/context-ready') {
    const ready = pcx.contextReady;
    pcx.contextReady = false;
    return send(res, 200, { ok: true, ready });
  }

  // AI 通知：需要人做选择
  if (req.method === 'POST' && pathname === '/choice') {
    const body = await readJson(req);
    const v = interact.validateDecisionRequest('choice', body);
    if (!v.ok) return send(res, 400, { ok: false, error: v.error });
    setDecision(pcx, v.decision);
    console.log(`[choice] ${v.decision.question}`);
    return send(res, 200, { ok: true, decisionPending: pcx.decisionPending });
  }

  // AI 通知：需要人自由输入
  if (req.method === 'POST' && pathname === '/ask') {
    const body = await readJson(req);
    const v = interact.validateDecisionRequest('text', body);
    if (!v.ok) return send(res, 400, { ok: false, error: v.error });
    setDecision(pcx, v.decision);
    console.log(`[ask] ${v.decision.question}`);
    return send(res, 200, { ok: true, decisionPending: pcx.decisionPending });
  }

  if (req.method === 'POST' && pathname === '/send') {
    const body = await readJson(req);
    if (!body || typeof body.text !== 'string' || body.text.length === 0) {
      return send(res, 400, { ok: false, error: 'body must be {text: non-empty string}' });
    }
    if (!pcx.tmux.hasSession()) {
      return send(res, 503, { ok: false, error: `tmux session '${pcx.tmux.SESSION}' not found; run bootstrap.sh` });
    }
    const ok = await waitReady(pcx, READY_TIMEOUT_MS);
    if (!ok) return send(res, 409, { ok: false, error: 'still busy (ready timeout)' });
    pcx.logger.captureFromTranscript();
    setBusy(pcx);
    pcx.logger.logPrompt(body.text);
    await submit(pcx, body.text);
    return send(res, 200, { ok: true, sent: body.text });
  }

  if (req.method === 'POST' && pathname === '/cmd') {
    const body = await readJson(req);
    if (!body || typeof body.cmd !== 'string' || body.cmd.length === 0) {
      return send(res, 400, { ok: false, error: 'body must be {cmd: non-empty string}' });
    }
    if (!pcx.tmux.hasSession()) {
      return send(res, 503, { ok: false, error: `tmux session '${pcx.tmux.SESSION}' not found; run bootstrap.sh` });
    }
    const ok = await sendLocalCmd(pcx, body.cmd);
    if (!ok) return send(res, 409, { ok: false, error: 'still busy (ready timeout)' });
    return send(res, 200, { ok: true, sent: body.cmd });
  }

  // w-monitor 受控介入
  if (req.method === 'POST' && pathname === '/intervene') {
    const body = await readJson(req);
    if (!body || typeof body.text !== 'string' || body.text.length === 0) {
      return send(res, 400, { ok: false, error: 'body must be {text: non-empty string, reason?: string}' });
    }
    if (!requirePaused(pcx, res)) return;
    if (!pcx.tmux.hasSession()) {
      return send(res, 503, { ok: false, error: `tmux session '${pcx.tmux.SESSION}' not found; run bootstrap.sh` });
    }
    pcx.logger.logPrompt(`[w-monitor intervention] ${body.reason || 'unspecified'}\n${body.text}`);
    setBusy(pcx);
    await submit(pcx, body.text);
    return send(res, 200, { ok: true, sent: body.text, intervention: true });
  }

  // w-monitor 升级中断
  if (req.method === 'POST' && pathname === '/intervene/interrupt') {
    const body = (await readJson(req)) || {};
    if (!requirePaused(pcx, res)) return;
    if (!pcx.tmux.hasSession()) {
      return send(res, 503, { ok: false, error: `tmux session '${pcx.tmux.SESSION}' not found; run bootstrap.sh` });
    }
    pcx.tmux.sendCtrlC();
    clearDecision(pcx);
    if (pcx.fallbackTimer) clearTimeout(pcx.fallbackTimer);
    pcx.fallbackTimer = setTimeout(() => { if (pcx.state === 'busy') setReady(pcx); }, LOCAL_CMD_FALLBACK_MS);
    return send(res, 200, { ok: true, interrupted: true, reason: body.reason || null });
  }

  // 中断当前正在运行的 Claude 流
  if (req.method === 'POST' && pathname === '/stop') {
    if (!pcx.tmux.hasSession()) {
      return send(res, 503, { ok: false, error: `tmux session '${pcx.tmux.SESSION}' not found; run bootstrap.sh` });
    }
    pcx.tmux.sendCtrlC();
    clearDecision(pcx);
    if (pcx.fallbackTimer) clearTimeout(pcx.fallbackTimer);
    pcx.fallbackTimer = setTimeout(() => { if (pcx.state === 'busy') setReady(pcx); }, LOCAL_CMD_FALLBACK_MS);
    return send(res, 200, { ok: true, stopped: true });
  }

  // CLI 回应决策
  if (req.method === 'POST' && pathname === '/respond') {
    const body = await readJson(req);
    if (!body || typeof body.value !== 'string' || body.value.length === 0) {
      clearDecision(pcx);
      return send(res, 400, { ok: false, error: 'body must be {value: non-empty string}' });
    }
    if (!pcx.tmux.hasSession()) {
      clearDecision(pcx);
      return send(res, 503, { ok: false, error: `tmux session '${pcx.tmux.SESSION}' not found; run bootstrap.sh` });
    }
    if (!pcx.decisionPending) {
      const ok = await waitReady(pcx, READY_TIMEOUT_MS);
      if (!ok) return send(res, 409, { ok: false, error: 'still busy (ready timeout)' });
    }
    const hadDecision = !!pcx.decisionPending;
    const question = pcx.decisionPending ? pcx.decisionPending.question : null;
    setBusy(pcx);
    if (hadDecision) {
      pcx.logger.logChoice(question, body.value);
    }
    clearDecision(pcx);
    await submit(pcx, body.value);
    const fallbackMs = hadDecision ? DECISION_FALLBACK_MS : LOCAL_CMD_FALLBACK_MS;
    if (pcx.fallbackTimer) clearTimeout(pcx.fallbackTimer);
    pcx.fallbackTimer = setTimeout(() => {
      if (pcx.state === 'busy') setReady(pcx);
    }, fallbackMs);
    return send(res, 200, { ok: true, sent: body.value });
  }

  // ---- run host：提交 run / 状态快照 / 轮询事件 ----
  if (req.method === 'POST' && pathname === '/run/submit') {
    const body = (await readJson(req)) || {};
    await bootstrapRunHost(pcx);
    if (!pcx.runHost) return send(res, 503, { ok: false, error: `run host 未就绪: ${pcx.runHostBootErr?.message || 'unknown'}` });
    const runId = typeof body.runId === 'string' && body.runId.length > 0 ? body.runId : undefined;
    const mode = body.mode === 'single' || body.mode === 'batch' ? body.mode : undefined; // CLI --multi-agent 显式指定
    const r = pcx.runHost.submitRun({ runId, mode });
    if (!r.ok) return send(res, 409, { ok: false, error: r.error, runId: r.runId });
    return send(res, 202, { ok: true, runId: r.runId, mode: r.mode });
  }

  if (req.method === 'GET' && pathname === '/run/status') {
    await bootstrapRunHost(pcx);
    if (!pcx.runHost) return send(res, 503, { ok: false, error: `run host 未就绪: ${pcx.runHostBootErr?.message || 'unknown'}` });
    const runId = url.searchParams.get('runId') || undefined;
    return send(res, 200, pcx.runHost.snapshot(runId));
  }

  if (req.method === 'GET' && pathname === '/run/events') {
    await bootstrapRunHost(pcx);
    if (!pcx.runHost) return send(res, 503, { ok: false, error: `run host 未就绪: ${pcx.runHostBootErr?.message || 'unknown'}` });
    const afterSeqRaw = url.searchParams.get('afterSeq');
    const afterSeq = Number(afterSeqRaw);
    const q = {
      afterSeq: Number.isInteger(afterSeq) && afterSeq >= 0 ? afterSeq : 0,
      runId: url.searchParams.get('runId') || undefined,
    };
    return send(res, 200, pcx.runHost.pollEvents(q));
  }

  // ---- server run api 写端点 ----
  if (req.method === 'POST' && pathname === '/run/dynamic-planning/proposals') {
    const body = (await readJson(req)) || {};
    try {
      const proposal = dynamicPlanningFor(pcx).propose(body);
      const applied = proposal.status === 'applied_review_pending';
      return send(res, applied ? 200 : 202, { ok: true, applied, proposal });
    } catch (e) {
      return send(res, 409, { ok: false, error: e.message });
    }
  }

  const dynamicAction = pathname.match(/^\/run\/dynamic-planning\/proposals\/([^/]+)\/(approve|reject)$/);
  if (req.method === 'POST' && dynamicAction) {
    const proposalId = decodeURIComponent(dynamicAction[1]);
    const action = dynamicAction[2];
    const body = (await readJson(req)) || {};
    try {
      const service = dynamicPlanningFor(pcx);
      const proposal = action === 'approve'
        ? service.approve(proposalId, body)
        : service.reject(proposalId, body);
      return send(res, 200, { ok: true, proposal });
    } catch (e) {
      return send(res, 409, { ok: false, error: e.message });
    }
  }

  if (req.method === 'POST' && pathname === '/run/state/mode') {
    const body = (await readJson(req)) || {};
    if (!body || typeof body.mode !== 'string' || !['run', 'idle', 'pause'].includes(body.mode)) {
      return send(res, 400, { ok: false, error: 'body must be {mode: run|idle|pause}' });
    }
    await ensureRunStateApi(pcx);
    if (!pcx.runStateApi) return send(res, 503, { ok: false, error: 'state api 未就绪' });
    const ok = pcx.runStateApi.setWorkflowMode(pcx.projectRoot, body.mode);
    return send(res, 200, { ok: !!ok, mode: body.mode });
  }

  if (req.method === 'POST' && pathname === '/run/state/task/active') {
    const body = (await readJson(req)) || {};
    if (!body || typeof body.taskId !== 'string' || body.taskId.length === 0) {
      return send(res, 400, { ok: false, error: 'body must be {taskId: non-empty string}' });
    }
    await ensureRunStateApi(pcx);
    if (!pcx.runStateApi) return send(res, 503, { ok: false, error: 'state api 未就绪' });
    const ok = pcx.runStateApi.markTaskActive(pcx.projectRoot, body.taskId);
    return send(res, 200, { ok: !!ok, taskId: body.taskId });
  }

  if (req.method === 'POST' && pathname === '/run/state/gate') {
    const body = (await readJson(req)) || {};
    if (!body || typeof body.taskId !== 'string' || body.taskId.length === 0) {
      return send(res, 400, { ok: false, error: 'body must be {taskId: non-empty string}' });
    }
    const s = pcx.stores.state.readSync();
    const task = s?.tasks?.find((x) => x.id === body.taskId) || null;
    if (!task) return send(res, 200, { ok: true, applied: false, reason: 'task not found' });
    const handler = await runStateGateHandler();
    await handler(pcx.projectRoot, body.taskId, task);
    return send(res, 200, { ok: true, applied: true, taskId: body.taskId });
  }

  if (req.method === 'POST' && pathname === '/run/state/backup') {
    await ensureRunStateApi(pcx);
    if (!pcx.runStateApi) return send(res, 503, { ok: false, error: 'state api 未就绪' });
    pcx.runStateApi.backupState(pcx.projectRoot);
    return send(res, 200, { ok: true });
  }

  // T1-077：awf-state MCP 语义保留、底层写收口 server 单写者
  if (req.method === 'POST' && pathname === '/run/state/apply') {
    const body = (await readJson(req)) || {};
    const state = body?.state;
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return send(res, 400, { ok: false, error: 'body must be {state: object}' });
    }
    await ensureRunStateApi(pcx);
    const sid = url.searchParams.get('sid');
    try {
      if (sid) {
        pcx.writeRunStateSid(sid, state);
      } else {
        if (!pcx.runStateApi) return send(res, 503, { ok: false, error: 'state api 未就绪' });
        if (Object.prototype.hasOwnProperty.call(body, 'expectedLastUpdated')) {
          if (!pcx.runStateApi.replaceStateIfUnchanged) {
            return send(res, 503, { ok: false, error: 'state CAS api 未就绪' });
          }
          if (typeof body.expectedStateFingerprint !== 'string' || !body.expectedStateFingerprint) {
            return send(res, 400, {
              ok: false,
              error: 'CAS apply requires expectedStateFingerprint',
            });
          }
          const applied = pcx.runStateApi.replaceStateIfUnchanged(
            pcx.projectRoot,
            state,
            body.expectedLastUpdated,
            body.expectedStateFingerprint,
          );
          if (applied?.conflict) {
            return send(res, 409, {
              ...applied,
              error: 'state 已被其他写者更新，请重新读取后重试',
            });
          }
          return send(res, 200, applied);
        }
        // 兼容旧调用方；新版 MCP 总会携带 expectedLastUpdated。
        pcx.runStateApi.saveState(pcx.projectRoot, state);
      }
      return send(res, 200, { ok: true });
    } catch (e) {
      return send(res, 500, { ok: false, error: `state 落盘失败: ${e.message}` });
    }
  }

  // T1-080：awf-oneshot 经 server
  if (req.method === 'POST' && pathname === '/oneshot') {
    const body = (await readJson(req)) || {};
    if (!body || typeof body.prompt !== 'string' || body.prompt.length === 0) {
      return send(res, 400, { ok: false, error: 'body must be {prompt: non-empty string}' });
    }
    const r = await oneshotLib.runOneShot({ prompt: body.prompt, cwd: typeof body.cwd === 'string' ? body.cwd : undefined, timeoutMs: 300000 })
      .catch((e) => ({ ok: false, error: e.message }));
    return send(res, 200, r);
  }

  // 优雅关闭（T1-064）
  if (req.method === 'POST' && pathname === '/shutdown') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, shutting: true }));
    setTimeout(() => {
      stop().then(() => { if (require.main === module) process.exit(0); });
    }, 60);
    return;
  }

  // T1-093：web 构建产物静态托管
  if (req.method === 'GET') {
    const host = webHostInstance();
    if (host && host.serve(req, res, pathname)) return;
  }

  return send(res, 404, { ok: false, error: 'not found' });
});

// ---- lifecycle ----
// WebSocket 升级：/run/events 实时事件推送（T1-091）
server.on('upgrade', (req, socket) => {
  let pathname = '/';
  try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch { /* 保持默认 */ }
  if (pathname !== '/run/events') {
    try { socket.destroy(); } catch { /* ignore */ }
    return;
  }
  const pcx = (() => { try { return resolveCtxForUrl(new URL(req.url, 'http://localhost')); } catch { return BOOT(); } })();
  bootstrapRunHost(pcx)
    .then(() => {
      if (!pcx.runHost) { try { socket.destroy(); } catch { /* ignore */ } return; }
      const unsub = pcx.runHost.subscribe((event) => {
        try {
          if (socket.writable) socket.write(encodeTextFrame(JSON.stringify(event)));
        } catch { /* ignore */ }
      });
      wsUpgrade(req, socket, { onClose: unsub, onError: unsub });
    })
    .catch(() => { try { socket.destroy(); } catch { /* ignore */ } });
});

function start(port = PORT) {
  for (const c of registry.all()) resetRunLogs(c);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const addr = server.address();
      // T1-112：落进 .awf/logs/server.log，确认「哪次 spawn 起的 server、在哪个项目」
      console.log(`[server] listening http://127.0.0.1:${addr.port} project=${PROJECT_ROOT} pid=${process.pid} at ${new Date().toISOString()}`);
      resolve({ port: addr.port, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function stop() {
  for (const c of registry.all()) {
    if (c.runHost) { try { c.runHost.stop(); } catch { /* ignore */ } }
  }
  return new Promise((resolve) => {
    server.close(() => resolve());
    if (server.closeAllConnections) server.closeAllConnections();
  });
}

// ---- test helpers（定向 boot 上下文，与旧单槽导出等价） ----
function _getState() {
  const b = BOOT();
  return {
    state: b.state, decisionPending: b.decisionPending, waiters: [...b.waiters], contextReady: b.contextReady,
    decisionGate: b.decisionGate, decisionResume: b.decisionResume,
    mainSessionId: b.mainSessionId,
    activeAgents: [...b.agents.values()].filter((a) => a.status === 'running').length,
  };
}

function _resetForTest() {
  registry.reset();
  // run-meta 复位到 boot 项目（与旧行为一致）
  resetRunMeta(BOOT().projectRoot);
}

module.exports = {
  server, start, stop, _getState, _resetForTest,
  setDecision: (d) => setDecision(BOOT(), d),
  clearDecision: () => clearDecision(BOOT()),
  setReady: () => setReady(BOOT()),
  setBusy: () => setBusy(BOOT()),
  waitReady: (timeout) => waitReady(BOOT(), timeout),
};

if (require.main === module) {
  const bootPcx = BOOT();
  for (const c of registry.all()) resetRunLogs(c);
  server.listen(PORT, '127.0.0.1', () => {
    // T1-112：这行与后续所有 console 输出都落进 .awf/logs/server.log（由 CLI spawn 时接管 stdio），
    // 带上 pid/项目是为了事后能对上「哪次 spawn 起的 server、在给哪个项目干活」。
    console.log(`cc-control listening on http://127.0.0.1:${PORT} (session '${bootPcx.runSessionName}')`
      + ` pid=${process.pid} project=${PROJECT_ROOT} at ${new Date().toISOString()}`);
  });

  // T1-064/067 常驻空闲回收：全部项目无 run 驱动且空闲超时 → 自动关闭
  const idleMs = idleDefaultMs();
  if (idleMs > 0) {
    const idleCheckMs = Number(process.env.CC_SERVER_IDLE_CHECK_MS || 60000);
    const idleTimer = setInterval(() => {
      if (anyHostActive()) return;
      if (isIdleDue({ now: Date.now(), lastActivityAt, idleMs })) {
        clearInterval(idleTimer);
        console.log(`[server] 空闲 ${Math.round(idleMs / 60000)}min 无活动且无 run 驱动，自动关闭（常驻回收）`);
        stop().then(() => process.exit(0));
      }
    }, idleCheckMs);
    if (idleTimer.unref) idleTimer.unref();
  }
}
