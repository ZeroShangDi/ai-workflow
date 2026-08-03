'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const tmuxlib = require('./tmux.cjs');
const { appendLog } = require('../cli/utils/log-writer.cjs');
const os = require('os');

const LOG_PATH = process.env.AWF_LOG_PATH || null;
const PROJECT_ROOT = process.env.CC_PROJECT || process.cwd();

// ---- transcript helpers (file-position based, avoids content dedup issues) ----
let transcriptFile = null;
let transcriptPos = 0;
let sessionStartTime = Date.now();

function getTranscriptFile() {
  const slug = PROJECT_ROOT.replace(/\//g, '-');
  const dir = path.join(os.homedir(), '.claude', 'projects', slug);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) return null;
  // 只返回 session 启动后创建/更新的文件，避免读到旧 session 的 transcript
  if (sessionStartTime && files[0].mtime < sessionStartTime) return null;
  return path.join(dir, files[0].name);
}

function captureResponses() {
  if (!LOG_PATH) return;
  const fp = getTranscriptFile();
  if (!fp) return;
  // 新文件或首次调用，重置位置
  if (fp !== transcriptFile) {
    transcriptFile = fp;
    transcriptPos = 0;
  }
  const content = fs.readFileSync(fp, 'utf-8');
  if (content.length <= transcriptPos) return;
  const newContent = content.slice(transcriptPos);
  transcriptPos = content.length;
  const lines = newContent.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'assistant') {
        const texts = [];
        for (const block of (entry.message?.content || [])) {
          if (block.type === 'text' && block.text) texts.push(block.text);
        }
        if (texts.length > 0) {
          appendLog(LOG_PATH, { type: 'RESPONSE', body: texts.join('') });
        }
      }
    } catch {}
  }
}

const PORT = Number(process.env.CC_PORT || 8787);
const READY_TIMEOUT_MS = Number(process.env.CC_READY_TIMEOUT_MS || 120000);
const ENTER_DELAY_MS = Number(process.env.CC_ENTER_DELAY_MS || 200);
const LOCAL_CMD_FALLBACK_MS = Number(process.env.CC_LOCAL_CMD_MS || 1500);

// ---- ready/busy state machine, driven by Claude Code hooks ----
let state = 'ready'; // 'ready' | 'busy'
let decisionPending = null; // null | { type: 'choice'|'text', question: string, options?: string[] }
let waiters = [];

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
      const html = fs.readFileSync(__dirname + '/dashboard.html');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch {
      try {
        const html = fs.readFileSync(__dirname + '/ui.html');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      } catch {
        return send(res, 500, { ok: false, error: 'no page found' });
      }
    }
  }

  if (req.method === 'GET' && pathname === '/ui') {
    try {
      const html = fs.readFileSync(__dirname + '/ui.html');
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

    if (event === 'UserPromptSubmit') setBusy();
    else if (event === 'Stop') {
      if (decisionPending?.answered) clearDecision();
      setReady();
      captureResponses();
    } else if (event === 'SessionStart') {
      setReady();
      sessionStartTime = Date.now();
      transcriptFile = null;
      transcriptPos = 0;
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

    // PostToolUse: 兜底（如果没拦截成功，原生 UI 回答后更新结果）+ 记录 CHOICE
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
        if (LOG_PATH) appendLog(LOG_PATH, { type: 'CHOICE', question: prev.question, answer });
      }
    }

    console.log(`[hook] ${event} -> ${state}`);
    return send(res, 200, { ok: true, event: event || null, state });
  }

  // task context for logging

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
    const out = { ok: true, state, session: tmuxlib.hasSession(), decisionPending };
    if (url.searchParams.get('snapshot')) {
      try { out.snapshot = tmuxlib.capture(); } catch { out.snapshot = null; }
    }
    return send(res, 200, out);
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
    captureResponses();
    setBusy();
    // PROMPT 必须在 submit 之前写入日志，否则 Stop hook 的响应可能先写入
    if (LOG_PATH) appendLog(LOG_PATH, { type: 'PROMPT', body: body.text });
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
    setTimeout(() => { if (state === 'busy') setReady(); }, LOCAL_CMD_FALLBACK_MS);
    return send(res, 200, { ok: true, sent: body.cmd });
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
    setBusy();
    // 不清除 decisionPending，留给 PostToolUse 处理（记录 CHOICE 等）
    await submit(body.value);
    // 等待 CC 自然完成，不用 fallback timer
    return send(res, 200, { ok: true, sent: body.value });
  }

  return send(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`cc-control listening on http://127.0.0.1:${PORT} (session '${tmuxlib.SESSION}')`);
});
