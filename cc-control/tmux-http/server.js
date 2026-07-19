'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const tmuxlib = require('./tmux');

const PORT = Number(process.env.CC_PORT || 8787);
const READY_TIMEOUT_MS = Number(process.env.CC_READY_TIMEOUT_MS || 120000);
const ENTER_DELAY_MS = Number(process.env.CC_ENTER_DELAY_MS || 200);
const PROJECT_ROOT = process.env.CC_PROJECT || process.cwd();
const LOCAL_CMD_FALLBACK_MS = Number(process.env.CC_LOCAL_CMD_MS || 1500);

// ---- ready/busy state machine, driven by Claude Code hooks ----
let state = 'ready'; // 'ready' | 'busy'
let waiters = [];

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

  // hook callback: flip the state machine
  if (req.method === 'POST' && pathname === '/hook') {
    const body = (await readJson(req)) || {};
    const event = body.event || url.searchParams.get('event');
    if (event === 'UserPromptSubmit') setBusy();
    else if (event === 'Stop' || event === 'SessionStart') setReady();
    console.log(`[hook] ${event} -> ${state}`);
    return send(res, 200, { ok: true, event: event || null, state });
  }

  // ── awf state (read + write) ──
  const STATE_PATH = path.join(PROJECT_ROOT, '.awf', 'state.json');

  function readState() {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  }

  function writeState(s) {
    s.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
  }

  if (req.method === 'GET' && pathname === '/awf/state') {
    try {
      const stateJson = fs.readFileSync(STATE_PATH, 'utf-8');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(stateJson);
    } catch {
      return send(res, 404, { ok: false, error: '.awf/state.json not found' });
    }
  }

  if (req.method === 'POST' && pathname === '/awf/state') {
    const body = await readJson(req);
    if (!body || !body.action) {
      return send(res, 400, { ok: false, error: 'body must contain {action, ...}' });
    }

    try {
      const s = readState();
      const tasks = s.plan?.tasks || [];
      const milestones = s.milestones || [];

      switch (body.action) {
        // ── existing task actions ──
        case 'task-status': {
          const t = tasks.find(t => t.id == body.id);
          if (!t) return send(res, 404, { ok: false, error: `task ${body.id} not found` });
          t.status = body.status;
          break;
        }
        case 'task-result': {
          const t = tasks.find(t => t.id == body.id);
          if (!t) return send(res, 404, { ok: false, error: `task ${body.id} not found` });
          if (!t.exec) t.exec = {};
          if (body.result !== undefined) t.exec.result = body.result;
          if (body.files) t.exec.files = body.files;
          break;
        }
        case 'task-commit': {
          const t = tasks.find(t => t.id == body.id);
          if (!t) return send(res, 404, { ok: false, error: `task ${body.id} not found` });
          if (!t.commits) t.commits = [];
          t.commits.push({ hash: body.hash, message: body.message });
          break;
        }

        // ── new task CRUD ──
        case 'task-create': {
          if (!s.plan) s.plan = {};
          if (!s.plan.tasks) s.plan.tasks = [];
          if (s.plan.tasks.find(t => t.id == body.id)) {
            return send(res, 409, { ok: false, error: `task ${body.id} already exists` });
          }
          s.plan.tasks.push({
            id: body.id,
            desc: body.desc,
            prompt: body.prompt,
            wbsRef: body.wbsRef,
            deps: body.deps || [],
            status: 'pending',
          });
          break;
        }
        case 'task-update': {
          const t = tasks.find(t => t.id == body.id);
          if (!t) return send(res, 404, { ok: false, error: `task ${body.id} not found` });
          if (body.desc !== undefined) t.desc = body.desc;
          if (body.prompt !== undefined) t.prompt = body.prompt;
          if (body.wbsRef !== undefined) t.wbsRef = body.wbsRef;
          if (body.deps !== undefined) t.deps = body.deps;
          break;
        }
        case 'task-delete': {
          const idx = s.plan?.tasks?.findIndex(t => t.id == body.id);
          if (idx === undefined || idx === -1) {
            return send(res, 404, { ok: false, error: `task ${body.id} not found` });
          }
          s.plan.tasks.splice(idx, 1);
          break;
        }

        // ── plan metadata ──
        case 'plan-configure': {
          if (!s.plan) s.plan = {};
          if (body.summary !== undefined) s.plan.summary = body.summary;
          if (body.reqDoc !== undefined) s.plan.reqDoc = body.reqDoc;
          if (body.hasUI !== undefined) s.plan.hasUI = body.hasUI;
          if (body.inScope !== undefined) s.plan.inScope = body.inScope;
          if (body.outOfScope !== undefined) s.plan.outOfScope = body.outOfScope;
          if (body.acceptanceCriteria !== undefined) s.plan.acceptanceCriteria = body.acceptanceCriteria;
          break;
        }

        // ── WBS management ──
        case 'wbs-create': {
          if (!s.plan) s.plan = {};
          if (!s.plan.wbs) s.plan.wbs = [];
          if (s.plan.wbs.find(w => w.id == body.id)) {
            return send(res, 409, { ok: false, error: `wbs ${body.id} already exists` });
          }
          s.plan.wbs.push({
            id: body.id,
            name: body.name,
            desc: body.desc,
            acceptance: body.acceptance,
            deps: body.deps || [],
          });
          break;
        }
        case 'wbs-update': {
          const w = s.plan?.wbs?.find(w => w.id == body.id);
          if (!w) return send(res, 404, { ok: false, error: `wbs ${body.id} not found` });
          if (body.name !== undefined) w.name = body.name;
          if (body.desc !== undefined) w.desc = body.desc;
          if (body.acceptance !== undefined) w.acceptance = body.acceptance;
          if (body.deps !== undefined) w.deps = body.deps;
          break;
        }
        case 'wbs-delete': {
          const idx = s.plan?.wbs?.findIndex(w => w.id == body.id);
          if (idx === undefined || idx === -1) {
            return send(res, 404, { ok: false, error: `wbs ${body.id} not found` });
          }
          s.plan.wbs.splice(idx, 1);
          break;
        }

        // ── existing phase / milestone ──
        case 'phase': {
          s.currentState = body.phase;
          break;
        }
        case 'milestone': {
          const m = milestones.find(m => m.id == body.id);
          if (!m) return send(res, 404, { ok: false, error: `milestone ${body.id} not found` });
          m.status = body.status;
          break;
        }
        case 'milestone-create': {
          if (!s.milestones) s.milestones = [];
          if (s.milestones.find(m => m.id == body.id)) {
            return send(res, 409, { ok: false, error: `milestone ${body.id} already exists` });
          }
          s.milestones.push({
            id: body.id,
            desc: body.desc,
            status: body.status || 'active',
            tasks: body.tasks || [],
          });
          break;
        }

        default:
          return send(res, 400, { ok: false, error: `unknown action: ${body.action}` });
      }

      writeState(s);
      console.log(`[awf/state] ${body.action} ${body.id || body.phase || ''} -> ok`);
      return send(res, 200, { ok: true, action: body.action });
    } catch (err) {
      return send(res, 500, { ok: false, error: err.message });
    }
  }

  if (req.method === 'GET' && pathname === '/status') {
    const out = { ok: true, state, session: tmuxlib.hasSession() };
    if (url.searchParams.get('snapshot')) {
      try { out.snapshot = tmuxlib.capture(); } catch { out.snapshot = null; }
    }
    return send(res, 200, out);
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
    setBusy();
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

  if (req.method === 'POST' && pathname === '/key') {
    const body = await readJson(req);
    if (!body || typeof body.keys !== 'string' || body.keys.length === 0) {
      return send(res, 400, { ok: false, error: 'body must be {keys: non-empty string}' });
    }
    if (!tmuxlib.hasSession()) {
      return send(res, 503, { ok: false, error: `tmux session '${tmuxlib.SESSION}' not found; run bootstrap.sh` });
    }
    tmuxlib.sendKeys(body.keys);
    return send(res, 200, { ok: true, sent: body.keys });
  }

  // ---- one-shot (non-tmux): single claude -p call, returns stdout ----
  if (req.method === 'POST' && pathname === '/oneshot') {
    const body = await readJson(req);
    if (!body || typeof body.prompt !== 'string' || body.prompt.length === 0) {
      return send(res, 400, { ok: false, error: 'body must be {prompt: non-empty string}' });
    }

    const { spawn } = require('child_process');
    const proc = spawn('claude', ['-p', body.prompt], {
      cwd: body.cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });

    let output = '';
    proc.stdout.on('data', (c) => (output += c.toString()));

    proc.on('close', (code) => {
      if (code === 0) {
        send(res, 200, { ok: true, text: output.trim() });
      } else {
        send(res, 500, { ok: false, error: `claude -p exited ${code}`, text: output.trim() || null });
      }
    });

    proc.on('error', (err) => {
      send(res, 500, { ok: false, error: err.message });
    });

    return;
  }

  return send(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`cc-control listening on http://127.0.0.1:${PORT} (session '${tmuxlib.SESSION}')`);
});
