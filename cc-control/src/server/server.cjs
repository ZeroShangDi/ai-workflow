'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
// 测试注入点：vitest 无法 mock 被原生 require 加载的 CJS 依赖，提供显式注入钩子。
// 生产环境不设置 global.__CC_TMUX__/__CC_RUNLOGGER__，回落到真实模块。
const tmuxlib = global.__CC_TMUX__ || require('./tmux.cjs');
const { RunLogger } = global.__CC_RUNLOGGER__ || require('./run-logger.cjs');

const PROJECT_ROOT = process.env.CC_PROJECT || process.cwd();
const logger = new RunLogger(PROJECT_ROOT);
if (logger.enabled) console.log(`[server] run log: ${logger.path}`);

// ---- subagent 事件日志：SubagentStart/Stop 的完整 payload 追加写入（实证/观测用）----
const SUBAGENT_LOG = path.join(PROJECT_ROOT, '.awf', 'logs', 'subagent-events.jsonl');

function logSubagentEvent(event, body) {
  try {
    fs.mkdirSync(path.dirname(SUBAGENT_LOG), { recursive: true });
    fs.appendFileSync(SUBAGENT_LOG, JSON.stringify({ ts: new Date().toISOString(), event, body }) + '\n');
  } catch (e) {
    console.log(`[subagent-log] ${e.message}`);
  }
}

// ---- 落账失败记录：CLI 据此触发补发（SendMessage 恢复子 Agent 补齐 RESULT）----
const SUBAGENT_FAILED_LOG = path.join(PROJECT_ROOT, '.awf', 'logs', 'subagent-failed.jsonl');

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
const SUBAGENT_NEEDS_LOG = path.join(PROJECT_ROOT, '.awf', 'logs', 'subagent-needs-input.jsonl');

/** 解析子 Agent 的 NEEDS_INPUT（`NEEDS_INPUT: {json}`）；成功返回 { taskId, question, options?, context? }，否则 null */
function parseSubagentNeedsInput(body) {
  const msg = body.last_assistant_message || '';
  const m = msg.match(/NEEDS_INPUT:\s*(\{[\s\S]*\})/);
  if (!m) return null;
  try {
    const r = JSON.parse(m[1]);
    if (r && typeof r.taskId === 'string' && typeof r.question === 'string') return r;
  } catch { /* 解析失败 */ }
  return null;
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
    try { fs.writeFileSync(p, ''); } catch { /* 目录未创建/无权限时忽略 */ }
  }
}

// ---- SubagentStop 落账：解析子 Agent 固定格式 RESULT → 写 state ----
// 多 agent 滑动窗口的落账由 hook 驱动（用户定稿），不依赖主 Agent 收尾。
const STATE_PATH = path.join(PROJECT_ROOT, '.awf', 'state.json');
const STATE_LOCK = path.join(PROJECT_ROOT, '.awf', 'state.lock');

function withStateLock(fn) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const fd = fs.openSync(STATE_LOCK, 'wx');
      fs.closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() > deadline) throw new Error(`state.lock timeout: ${STATE_LOCK}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(STATE_LOCK); } catch {} }
}

/** 解析子 Agent 固定格式 RESULT（`RESULT: {json}`）；成功返回结果对象，失败返回 null */
function parseSubagentResult(body) {
  const msg = body.last_assistant_message || '';
  const m = msg.match(/RESULT:\s*(\{[\s\S]*\})/);
  if (!m) return null;
  try {
    const r = JSON.parse(m[1]);
    if (r && typeof r.taskId === 'string' && (r.status === 'done' || r.status === 'blocked' || r.status === 'failed' || r.status === 'fail')) return r;
  } catch { /* 解析失败 */ }
  return null;
}

/** SubagentStop 落账：写 state（task status + exec.result/files/commits）；返回 { ok, taskId?, reason?, recoverable? } */
function settleSubagent(body) {
  const result = parseSubagentResult(body);
  if (!result) return { ok: false, reason: 'no valid RESULT in last_assistant_message' };
  return withStateLock(() => {
    let s;
    try { s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); } catch { return { ok: false, reason: 'state.json unreadable', recoverable: false }; }
    const task = (s.tasks || []).find((t) => t.id === result.taskId);
    if (!task) return { ok: false, reason: `task ${result.taskId} not found` };
    // 指向已完成/已阻塞任务 → 拒绝：RESULT taskId 可能错写（如 X1 子 Agent 误写成已 done 的 T3），
    // 否则落账"假成功"（错标已有任务），真实任务永不落账且不触发补发。
    // recoverable:false → 良性（phantom 先落账/重复 Stop），不写失败记录、不触发 CLI 补发
    if (task.status === 'done' || task.status === 'blocked') {
      return { ok: false, reason: `task ${result.taskId} already ${task.status}（RESULT taskId 可能错写）`, recoverable: false };
    }
    if (!task.exec) task.exec = {};
    // failed/fail 是协议允许的终态（awf-worker.md: done|blocked|failed），但调度只认 blocked 为终态，映射之
    task.status = (result.status === 'failed' || result.status === 'fail') ? 'blocked' : result.status;
    if (result.result !== undefined) task.exec.result = result.result;
    if (result.files) task.exec.files = result.files;
    if (result.verdict !== undefined) task.exec.verdict = result.verdict;
    if (result.commits) { task.commits = task.commits || []; task.commits.push(...result.commits); }
    s.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
    return { ok: true, taskId: result.taskId, status: result.status };
  });
}

const PORT = Number(process.env.CC_PORT || 8787);
const READY_TIMEOUT_MS = Number(process.env.CC_READY_TIMEOUT_MS || 120000);
const ENTER_DELAY_MS = Number(process.env.CC_ENTER_DELAY_MS || 200);
const LOCAL_CMD_FALLBACK_MS = Number(process.env.CC_LOCAL_CMD_MS || 1500);
const DECISION_FALLBACK_MS = Number(process.env.CC_DECISION_FALLBACK_MS || 300000);
// dashboard/ui 目录：测试用 CC_HTML_DIR 指向临时目录以控制文件存在性
const htmlDir = () => process.env.CC_HTML_DIR || __dirname;

// ---- ready/busy state machine, driven by Claude Code hooks ----
let state = 'ready'; // 'ready' | 'busy'
let decisionPending = null; // null | { type: 'choice'|'text', question: string, options?: string[] }
let waiters = [];
let fallbackTimer = null; // /cmd /respond 的兜底恢复定时器（测试中需可清除）
let contextReady = false; // awf_context_ready 置位，CLI 一次性消费后 /clear
let mainSessionId = null; // 主 Claude 会话的 session_id（SessionStart 透传 payload 记录）
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

    if (event === 'SessionStart') {
      if (body.session_id && !mainSessionId) mainSessionId = body.session_id;
      setReady();
      logger.resetTranscript();
    } else if (event === 'UserPromptSubmit') {
      // 子 agent 的 prompt 不翻转主闩锁（子 agent 完成是 SubagentStop，不触发主 Stop，引用计数会悬挂）
      if (isMainSession(body)) setBusy();
    } else if (event === 'Stop') {
      if (isMainSession(body)) {
        clearDecision();
        setReady();
        logger.captureFromTranscript();
      }
    } else if (event === 'SubagentStart') {
      // 只观测，不驱动主闩锁。以 agent_id 键控（子 agent 共享父会话 session_id，用它做 key 会塌缩成一个）
      const key = body.agent_id || body.session_id || 'unknown';
      agents.set(key, { sessionId: body.session_id || null, status: 'running', startedAt: Date.now() });
      logSubagentEvent(event, body);
    } else if (event === 'SubagentStop') {
      const key = body.agent_id || body.session_id || 'unknown';
      const a = agents.get(key);
      if (a) a.status = 'stopped';
      logSubagentEvent(event, body);
      // 未跟踪的 Stop（无 SubagentStart：伪事件/非本 run 派发）仅观测，不落账、不写失败记录 ——
      // 否则会为不存在的子 Agent 生成失败记录 → CLI 补发到幽灵 agent，反复 RESET/等待
      if (!a) {
        console.log(`[subagent-stop] skip untracked agent ${key} (no SubagentStart)`);
      } else {
        // 决策上抛优先：NEEDS_INPUT → 写记录（不落账，任务等待；CLI 暂停补位、主 Agent 原生 AskUserQuestion）
        const needs = parseSubagentNeedsInput(body);
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

    // PreToolUse: 检测 AskUserQuestion，在执行前设置 decisionPending（不拦截）
    if (event === 'PreToolUse' && body.tool_name === 'AskUserQuestion') {
      const questions = body.tool_input?.questions;
      if (questions && questions.length > 0) {
        const q = questions[0];
        setDecision({
          type: q.multiSelect ? 'multiSelect' : 'choice',
          multiSelect: !!q.multiSelect,
          question: q.question,
          options: (q.options || []).map(o => o.label),
          header: q.header || null,
          source: 'AskUserQuestion',
        });
        console.log(`[hook] AskUserQuestion detected (PreToolUse): ${q.question}`);
      }
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
    return send(res, 200, { ok: true, event: event || null, state });
  }

  // ---- state.json ----
  if (req.method === 'GET' && pathname === '/awf/state') {
    const projectRoot = process.env.CC_PROJECT || process.cwd();
    const statePath = path.join(projectRoot, '.awf', 'state.json');
    try {
      const raw = fs.readFileSync(statePath, 'utf-8');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(raw);
    } catch (e) {
      return send(res, 404, { ok: false, error: `state.json not found at ${statePath}` });
    }
  }

  // ---- status ----
  if (req.method === 'GET' && pathname === '/status') {
    const out = {
      ok: true, state, session: tmuxlib.hasSession(), decisionPending, contextReady,
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

  // AI 通知：需要人做选择（带选项）
  if (req.method === 'POST' && pathname === '/choice') {
    const body = await readJson(req);
    if (!body || typeof body.question !== 'string') {
      return send(res, 400, { ok: false, error: 'body must be {question: string, options?: string[]}' });
    }
    setDecision({ type: 'choice', question: body.question, options: body.options || [], context: body.context || null });
    console.log(`[choice] ${body.question}`);
    return send(res, 200, { ok: true, decisionPending });
  }

  // AI 通知：需要人自由输入
  if (req.method === 'POST' && pathname === '/ask') {
    const body = await readJson(req);
    if (!body || typeof body.question !== 'string') {
      return send(res, 400, { ok: false, error: 'body must be {question: string}' });
    }
    setDecision({ type: 'text', question: body.question, context: body.context || null });
    console.log(`[ask] ${body.question}`);
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
  waiters = [];
  contextReady = false;
  mainSessionId = null;
  agents.clear();
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
