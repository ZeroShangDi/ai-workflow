'use strict';

const http = require('http');
const fs = require('fs');
const tmuxlib = require('./tmux.cjs');

const PORT = Number(process.env.CC_PORT || 8787);
const READY_TIMEOUT_MS = Number(process.env.CC_READY_TIMEOUT_MS || 120000);
const ENTER_DELAY_MS = Number(process.env.CC_ENTER_DELAY_MS || 200);
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

  // ---- status ----
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

  return send(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`cc-control listening on http://127.0.0.1:${PORT} (session '${tmuxlib.SESSION}')`);
});
