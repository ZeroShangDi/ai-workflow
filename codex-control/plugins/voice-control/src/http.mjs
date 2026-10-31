import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

import { parseCursor, serializeSseEvent } from './events.mjs';
import { publicError, VoiceControlError } from './errors.mjs';

const JSON_LIMIT = 1024 * 1024;
const HEARTBEAT_MS = 15_000;

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

function securityHeaders() {
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "media-src 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

function corsHeaders(req, allowedOrigins) {
  const origin = req.headers.origin;
  if (!origin) return {};
  if (!allowedOrigins.has(origin) && !allowedOrigins.has('*')) return {};
  return {
    'Access-Control-Allow-Origin': allowedOrigins.has('*') ? '*' : origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Last-Event-ID',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function writeJson(req, res, status, body, allowedOrigins) {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    ...securityHeaders(),
    ...corsHeaders(req, allowedOrigins),
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > JSON_LIMIT) {
    throw new VoiceControlError('request_too_large', 'Request body is too large', { status: 413 });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > JSON_LIMIT) {
      throw new VoiceControlError('request_too_large', 'Request body is too large', { status: 413 });
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new VoiceControlError('invalid_json', 'Request body must be valid JSON', { status: 400 });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VoiceControlError('invalid_json', 'Request body must be a JSON object', {
      status: 400,
    });
  }
  return parsed;
}

async function serveStatic(req, res, url, webRoot, allowedOrigins) {
  const asset = STATIC_FILES.get(url.pathname);
  if (!asset) {
    writeJson(req, res, 404, {
      ok: false,
      error: { code: 'not_found', message: 'Not found' },
    }, allowedOrigins);
    return;
  }
  const [file, contentType] = asset;
  const body = await fs.readFile(path.join(webRoot, file));
  res.writeHead(200, {
    ...securityHeaders(),
    ...corsHeaders(req, allowedOrigins),
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'Content-Length': body.length,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
}

function streamEvents(req, res, url, app, allowedOrigins) {
  const sessionId = url.pathname.split('/')[3];
  app.getSession(sessionId);
  const afterValue = resolveReplayCursor(url, req.headers);
  parseCursor(afterValue, 'after');

  res.writeHead(200, {
    ...securityHeaders(),
    ...corsHeaders(req, allowedOrigins),
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n: connected\n\n');

  let ended = false;
  let heartbeat = null;
  let subscription = null;
  const cleanup = () => {
    if (heartbeat) clearInterval(heartbeat);
    subscription?.unsubscribe();
  };
  const finish = (payload = { reason: 'closed' }) => {
    if (ended) return;
    ended = true;
    cleanup();
    res.write(`event: stream.end\ndata: ${JSON.stringify(payload)}\n\n`);
    res.end();
  };

  subscription = app.subscribeEvents(sessionId, {
    after: afterValue,
    onEvent(event) {
      if (!ended) res.write(serializeSseEvent(event));
    },
    onEnd(payload) {
      finish(payload);
    },
  });
  if (subscription.closed) {
    finish({ reason: 'closed' });
    return;
  }

  heartbeat = setInterval(() => {
    if (!ended) res.write(`: heartbeat ${Date.now()}\n\n`);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  res.on('close', () => {
    ended = true;
    cleanup();
  });
}

export function resolveReplayCursor(url, headers = {}) {
  return headers['last-event-id']
    ?? url.searchParams.get('after')
    ?? 0;
}

export function createVoiceHttpServer({
  app,
  webRoot = path.resolve(import.meta.dirname, '..', 'web'),
  allowedOrigins = [],
  onError = (error) => console.error(error),
} = {}) {
  if (!app) throw new Error('app is required');
  const origins = new Set(allowedOrigins);

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://voice-control.local');
      if (req.method === 'OPTIONS') {
        const cors = corsHeaders(req, origins);
        if (req.headers.origin && !Object.keys(cors).length) {
          throw new VoiceControlError('origin_not_allowed', 'Origin is not allowed', { status: 403 });
        }
        res.writeHead(204, {
          ...securityHeaders(),
          ...cors,
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }

      if (url.pathname === '/api/health' && req.method === 'GET') {
        writeJson(req, res, 200, app.health(), origins);
        return;
      }
      if (url.pathname === '/api/config/triggers' && req.method === 'GET') {
        writeJson(req, res, 200, { ok: true, ...app.getTriggerConfig() }, origins);
        return;
      }
      if (url.pathname === '/api/config/triggers' && req.method === 'PUT') {
        const body = await readJson(req);
        writeJson(req, res, 200, { ok: true, ...app.replaceTriggerConfig(body) }, origins);
        return;
      }
      if (url.pathname === '/api/voice/session' && req.method === 'POST') {
        writeJson(req, res, 201, { ok: true, ...app.createVoiceSession() }, origins);
        return;
      }
      if (url.pathname === '/api/voice/offer' && req.method === 'POST') {
        const body = await readJson(req);
        writeJson(req, res, 200, { ok: true, ...await app.voiceOffer(body) }, origins);
        return;
      }
      if (url.pathname === '/api/open' && req.method === 'POST') {
        const body = await readJson(req);
        writeJson(req, res, 201, { ok: true, session: app.createSession(body) }, origins);
        return;
      }
      if (url.pathname === '/api/close' && req.method === 'POST') {
        const body = await readJson(req);
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        if (!sessionId) {
          throw new VoiceControlError('invalid_request', 'sessionId is required', { status: 400 });
        }
        writeJson(req, res, 200, { ok: true, session: app.closeSession(sessionId) }, origins);
        return;
      }
      if (url.pathname === '/api/tunnel' && req.method === 'POST') {
        const body = await readJson(req);
        writeJson(req, res, 202, { ok: true, ...app.tunnel(body) }, origins);
        return;
      }
      if (url.pathname === '/api/notices' && req.method === 'GET') {
        writeJson(req, res, 200, {
          ok: true,
          notices: app.listNotices({ sessionId: url.searchParams.get('sessionId') }),
        }, origins);
        return;
      }
      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        const body = await readJson(req);
        writeJson(req, res, 201, { ok: true, session: app.createSession(body) }, origins);
        return;
      }

      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(events|chat|close))?$/);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const action = sessionMatch[2] || null;
        if (!action && req.method === 'GET') {
          writeJson(req, res, 200, { ok: true, session: app.getSession(sessionId) }, origins);
          return;
        }
        if (action === 'events' && req.method === 'GET') {
          streamEvents(req, res, url, app, origins);
          return;
        }
        if (action === 'events' && req.method === 'POST') {
          const body = await readJson(req);
          const result = app.appendEvent(sessionId, body);
          writeJson(req, res, result.duplicate ? 200 : 201, {
            ok: true,
            duplicate: result.duplicate,
            event: result.event,
          }, origins);
          return;
        }
        if (action === 'chat' && req.method === 'POST') {
          const body = await readJson(req);
          writeJson(req, res, 200, { ok: true, ...await app.chat(sessionId, body) }, origins);
          return;
        }
        if (action === 'close' && req.method === 'POST') {
          writeJson(req, res, 200, { ok: true, session: app.closeSession(sessionId) }, origins);
          return;
        }
      }

      const triggerMatch = url.pathname.match(/^\/api\/triggers\/([^/]+)\/dispatch$/);
      if (triggerMatch && req.method === 'POST') {
        const triggerId = decodeURIComponent(triggerMatch[1]);
        const body = await readJson(req);
        const result = app.dispatchTrigger(triggerId, body);
        writeJson(req, res, result.duplicate ? 200 : 202, {
          ok: true,
          duplicate: result.duplicate,
          event: result.event,
        }, origins);
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        throw new VoiceControlError('not_found', 'Not found', { status: 404 });
      }
      if (!['GET', 'HEAD'].includes(req.method)) {
        throw new VoiceControlError('method_not_allowed', 'Method not allowed', { status: 405 });
      }
      await serveStatic(req, res, url, webRoot, origins);
    } catch (error) {
      if (res.headersSent) {
        onError(error);
        res.end();
        return;
      }
      const failure = publicError(error);
      if (failure.status >= 500) onError(error);
      writeJson(req, res, failure.status, failure.body, origins);
    }
  });
}
