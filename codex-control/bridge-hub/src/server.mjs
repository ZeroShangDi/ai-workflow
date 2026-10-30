import http from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { loadConfig, validateHubConfig } from './config.mjs';
import { HubError, publicError } from './errors.mjs';
import { Hub } from './hub.mjs';
import {
  boundedInteger,
  safeEqual,
} from './util.mjs';

const BODY_LIMIT = 1024 * 1024;

function jsonHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, jsonHeaders({ 'Content-Length': Buffer.byteLength(body) }));
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      const error = new Error('request body is too large');
      error.type = 'entity.too.large';
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new HubError(400, 'invalid_json', 'request body must be valid JSON');
  }
}

function bearer(request) {
  const value = request.headers.authorization || '';
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

function routeSegments(pathname) {
  return pathname.split('/').filter(Boolean);
}

function listParam(url, name) {
  return url.searchParams.getAll(name).flatMap((item) => item.split(',')).filter(Boolean);
}

async function proxyEvents(hub, url, request, response) {
  const segments = routeSegments(url.pathname);
  const sessionId = segments[3];
  const controller = new AbortController();
  response.on('close', () => {
    if (!response.writableEnded) controller.abort();
  });
  const cmbResponse = await hub.adapter.openEvents(sessionId, { signal: controller.signal });
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (!cmbResponse.body) {
    response.end();
    return;
  }
  Readable.fromWeb(cmbResponse.body).pipe(response);
}

async function handle(hub, request, response, { apiToken = null } = {}) {
  const url = new URL(request.url, 'http://hub.invalid');
  if (request.method === 'GET' && url.pathname === '/health') {
    return sendJson(response, 200, {
      ok: true,
      service: 'bridge-hub',
      eventCursor: String(hub.events.lastCursor),
    });
  }
  if (apiToken && !safeEqual(bearer(request), apiToken)) {
    throw new HubError(401, 'unauthorized', 'a valid bearer token is required');
  }

  const segments = routeSegments(url.pathname);
  const method = request.method;

  if (method === 'GET' && url.pathname === '/api/status') {
    return sendJson(response, 200, hub.status());
  }

  if (method === 'POST' && url.pathname === '/api/v1/transcripts') {
    const result = hub.recordTranscript(await readBody(request));
    return sendJson(response, result.duplicate ? 200 : 201, result);
  }

  if (method === 'GET' && url.pathname === '/api/v1/chat/latest-user-transcript') {
    return sendJson(response, 200, {
      transcript: hub.latestUserTranscript({
        sessionId: url.searchParams.get('sessionId'),
        consumer: url.searchParams.get('consumer'),
      }),
    });
  }

  if (method === 'GET' && url.pathname === '/api/v1/chat/pending') {
    const interaction = hub.getPending({
      sessionId: url.searchParams.get('sessionId'),
      interactionId: url.searchParams.get('interactionId'),
      consumer: url.searchParams.get('consumer'),
    });
    if (!interaction) {
      throw new HubError(404, 'interaction_not_found', 'interaction does not exist');
    }
    return sendJson(response, 200, { interaction });
  }

  if (method === 'POST' && url.pathname === '/api/v1/chat/work/create') {
    return sendJson(response, 200, await hub.createWork(await readBody(request)));
  }
  if (method === 'GET' && url.pathname === '/api/v1/chat/work/find') {
    return sendJson(response, 200, await hub.findWork({
      consumer: url.searchParams.get('consumer'),
      query: url.searchParams.get('query') || '',
      limit: url.searchParams.get('limit') || 20,
    }));
  }
  if (method === 'GET' && url.pathname === '/api/v1/chat/work/status') {
    return sendJson(response, 200, await hub.getStatus({
      consumer: url.searchParams.get('consumer'),
      sessionId: url.searchParams.get('sessionId'),
      workId: url.searchParams.get('workId'),
    }));
  }
  if (method === 'POST' && url.pathname === '/api/v1/chat/work/send') {
    return sendJson(response, 200, await hub.sendWorkMessage(await readBody(request)));
  }
  if (method === 'GET' && url.pathname === '/api/v1/chat/work/read') {
    return sendJson(response, 200, await hub.readWork({
      consumer: url.searchParams.get('consumer'),
      sessionId: url.searchParams.get('sessionId'),
      workId: url.searchParams.get('workId'),
      view: url.searchParams.get('view') || 'history',
      after: url.searchParams.get('after') || '0',
      limit: boundedInteger(url.searchParams.get('limit'), {
        fallback: 50,
        minimum: 1,
        maximum: 100,
        field: 'limit',
      }),
    }));
  }
  if (method === 'GET' && url.pathname === '/api/v1/chat/events') {
    const sessionId = url.searchParams.get('sessionId');
    const result = hub.readEvents({
      after: url.searchParams.get('after') || '0',
      limit: boundedInteger(url.searchParams.get('limit'), {
        fallback: 100,
        minimum: 1,
        maximum: 100,
        field: 'limit',
      }),
      consumer: url.searchParams.get('consumer') || null,
      topics: listParam(url, 'topic'),
    });
    if (!sessionId) return sendJson(response, 200, result);
    return sendJson(response, 200, {
      ...result,
      events: result.events.filter((event) => (
        event.scope?.controlSessionId === sessionId
        || event.scope?.sessionId === sessionId
      )),
    });
  }
  if (method === 'POST' && url.pathname === '/api/v1/chat/work/answer') {
    return sendJson(response, 200, await hub.resolveAnswer(await readBody(request)));
  }
  if (method === 'POST' && url.pathname === '/api/v1/chat/work/approve') {
    return sendJson(response, 200, await hub.resolveApproval(await readBody(request)));
  }
  if (method === 'POST' && url.pathname === '/api/v1/chat/work/stop') {
    return sendJson(response, 200, await hub.stopWork(await readBody(request)));
  }
  if (method === 'POST' && url.pathname === '/api/v1/chat/work/progress') {
    return sendJson(response, 200, await hub.emitProgress(await readBody(request)));
  }
  if (method === 'POST' && url.pathname === '/api/v1/chat/work/request-input') {
    return sendJson(response, 200, await hub.requestInput(await readBody(request)));
  }
  if (method === 'POST' && url.pathname === '/api/v1/chat/work/request-approval') {
    return sendJson(response, 200, await hub.requestApproval(await readBody(request)));
  }
  if (method === 'POST' && url.pathname === '/api/v1/chat/work/artifact') {
    return sendJson(response, 200, await hub.publishArtifact(await readBody(request)));
  }
  if (method === 'POST' && url.pathname === '/api/v1/chat/work/finish') {
    return sendJson(response, 200, await hub.finishWork(await readBody(request)));
  }
  if (method === 'POST' && url.pathname === '/api/v1/chat/announcement/ack') {
    return sendJson(response, 200, await hub.ackAnnouncement(await readBody(request)));
  }

  if (method === 'POST' && url.pathname === '/api/events') {
    const result = hub.appendEvent(await readBody(request));
    return sendJson(response, result.duplicate ? 200 : 201, result);
  }
  if (method === 'GET' && url.pathname === '/api/events') {
    const result = hub.readEvents({
      after: url.searchParams.get('after') || '0',
      limit: boundedInteger(url.searchParams.get('limit'), {
        fallback: 100,
        minimum: 1,
        maximum: 500,
        field: 'limit',
      }),
      consumer: url.searchParams.get('consumer') || null,
      topics: listParam(url, 'topic'),
    });
    return sendJson(response, 200, result);
  }

  if (method === 'GET' && url.pathname === '/api/subscriptions') {
    return sendJson(response, 200, {
      subscriptions: hub.consumers.listSubscriptions(url.searchParams.get('consumer')),
    });
  }
  if (method === 'POST' && url.pathname === '/api/subscriptions') {
    return sendJson(response, 201, {
      subscription: hub.consumers.addSubscription(await readBody(request)),
    });
  }
  if (method === 'DELETE' && segments.length === 3 && segments[1] === 'subscriptions') {
    return sendJson(response, 200, hub.consumers.removeSubscription(segments[2]));
  }

  if (method === 'GET' && url.pathname === '/api/trust') {
    return sendJson(response, 200, { consumers: hub.consumers.list() });
  }
  if (segments.length === 3 && segments[1] === 'trust') {
    const consumer = segments[2];
    if (method === 'GET') {
      return sendJson(response, 200, { consumer: hub.consumers.get(consumer) });
    }
    if (method === 'PATCH') {
      return sendJson(response, 200, {
        consumer: hub.consumers.setFacts(consumer, await readBody(request)),
      });
    }
  }
  if (segments.length === 4 && segments[1] === 'trust' && segments[3] === 'pair') {
    const consumer = segments[2];
    if (method === 'POST') {
      return sendJson(response, 200, {
        consumer: hub.consumers.pair(consumer, await readBody(request)),
      });
    }
    if (method === 'DELETE') {
      return sendJson(response, 200, {
        consumer: hub.consumers.unpair(consumer),
      });
    }
  }

  if (method === 'GET' && url.pathname === '/api/bindings') {
    return sendJson(response, 200, {
      bindings: hub.bindings.list({
        controlSessionId: url.searchParams.get('controlSessionId'),
        workSessionId: url.searchParams.get('workSessionId'),
        voiceSessionId: url.searchParams.get('voiceSessionId'),
      }),
    });
  }
  if (method === 'POST' && url.pathname === '/api/bindings') {
    return sendJson(response, 201, {
      binding: hub.bindings.create(await readBody(request)),
    });
  }
  if (method === 'GET' && segments.length === 3 && segments[1] === 'bindings') {
    const binding = hub.bindings.get(segments[2]);
    if (!binding) throw new HubError(404, 'binding_not_found', 'binding does not exist');
    return sendJson(response, 200, { binding });
  }

  if (method === 'GET' && url.pathname === '/api/inbox') {
    return sendJson(response, 200, {
      deliveries: hub.inbox.list({
        consumer: url.searchParams.get('consumer'),
        status: url.searchParams.get('status'),
      }),
    });
  }
  if (method === 'POST' && url.pathname === '/api/inbox') {
    const result = hub.enqueueDelivery(await readBody(request));
    return sendJson(response, result.duplicate ? 200 : 201, result);
  }
  if (segments.length === 4 && segments[1] === 'inbox') {
    const id = segments[2];
    const body = await readBody(request);
    if (method === 'POST' && segments[3] === 'start') {
      return sendJson(response, 200, {
        delivery: hub.inbox.start(id, body),
      });
    }
    if (method === 'POST' && segments[3] === 'ack') {
      return sendJson(response, 200, {
        delivery: hub.inbox.acknowledge(id, body),
      });
    }
  }

  if (method === 'GET' && url.pathname === '/api/cmb/status') {
    return sendJson(response, 200, { cmb: await hub.adapter.status() });
  }
  if (method === 'GET' && url.pathname === '/api/cmb/sessions') {
    return sendJson(response, 200, await hub.adapter.sessions({
      query: url.searchParams.get('q') || '',
      limit: url.searchParams.get('limit') || 20,
    }));
  }
  if (segments.length === 4 && segments[1] === 'cmb' && segments[2] === 'sessions') {
    const sessionId = segments[3];
    if (method === 'GET') {
      return sendJson(response, 200, { session: await hub.adapter.view(sessionId) });
    }
  }
  if (segments.length === 5 && segments[1] === 'cmb' && segments[2] === 'sessions') {
    const sessionId = segments[3];
    if (method === 'POST' && segments[4] === 'send') {
      const body = await readBody(request);
      const key = request.headers['idempotency-key'] || body.idempotencyKey;
      const consumer = body.consumer || 'bridge-control';
      const result = await hub.sendMessage({
        consumer,
        sessionId,
        idempotencyKey: key,
        message: body.message,
      });
      return sendJson(response, 200, result);
    }
    if (method === 'GET' && segments[4] === 'events') {
      return proxyEvents(hub, url, request, response);
    }
  }

  throw new HubError(404, 'not_found', 'route does not exist');
}

export function createHubServer(hub, { apiToken = null } = {}) {
  return http.createServer((request, response) => {
    handle(hub, request, response, { apiToken })
      .catch((error) => {
        if (response.headersSent) {
          response.destroy(error);
          return;
        }
        const normalized = publicError(error);
        sendJson(response, normalized.status, normalized.body);
      });
  });
}

export async function startServer(config) {
  validateHubConfig(config);
  if (!config.apiToken && !['127.0.0.1', '::1', 'localhost'].includes(config.host)) {
    throw new HubError(
      500,
      'config_invalid',
      'non-loopback listening requires BRIDGE_HUB_API_TOKEN',
    );
  }
  const hub = new Hub(config);
  const server = createHubServer(hub, { apiToken: config.apiToken });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  return { hub, server };
}

async function main() {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf('--config');
  const configPath = configIndex >= 0 ? args[configIndex + 1] : undefined;
  if (configIndex >= 0 && !configPath) {
    throw new Error('--config requires a path');
  }
  const config = loadConfig({ configPath });
  const { server } = await startServer(config);
  const address = server.address();
  const host = address.address.includes(':') ? `[${address.address}]` : address.address;
  process.stdout.write(`bridge-hub listening on http://${host}:${address.port}\n`);
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
