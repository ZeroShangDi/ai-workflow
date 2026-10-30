import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { Hub } from '../src/hub.mjs';
import { createHubServer } from '../src/server.mjs';

export async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-hub-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function startMockCmb() {
  const state = {
    loginCount: 0,
    sendCount: 0,
    createCount: 0,
    historyCount: 0,
    stopCount: 0,
    respondCount: 0,
    readCalls: [],
    sendCalls: [],
    createCalls: [],
    respondCalls: [],
    sendMode: 'success',
    createMode: 'success',
    sessionExpired: false,
  };
  let baseUrl = '';

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, baseUrl || 'http://127.0.0.1');
    const authorized = request.headers.cookie === 'codex_mobile_session=test-session'
      && !state.sessionExpired;
    if (request.method === 'POST' && url.pathname === '/api/login') {
      const value = await body(request);
      state.loginCount += 1;
      if (
        value.username !== 'admin'
        || value.password !== 'test-password'
        || request.headers.origin !== baseUrl
      ) {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'bad credentials' }));
        return;
      }
      state.sessionExpired = false;
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'codex_mobile_session=test-session; HttpOnly; SameSite=Strict; Path=/',
      });
      response.end(JSON.stringify({ csrf: 'test-csrf' }));
      return;
    }
    if (!authorized) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/auth') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        authenticated: true,
        instanceId: 'mock-instance',
        computer: { name: 'mock-computer', platform: 'test' },
        passwordless: false,
        transport: 'sse',
        csrf: 'test-csrf',
      }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/sessions') {
      state.readCalls.push({ path: url.pathname, query: url.search });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        sessions: [{
          id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          title: 'Mock chat',
          projectName: 'demo',
          provider: 'codex',
          source: 'desktop',
          host: 'local',
        }],
        availableSources: ['desktop'],
      }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/projects') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        projects: [
          {
            key: 'local|demo',
            name: 'demo',
            cwd: '/tmp/demo',
            type: 'desktop',
            host: 'local',
          },
          {
            key: 'local|independent',
            name: 'Independent',
            cwd: null,
            type: 'desktop',
            host: 'local',
          },
        ],
      }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/sessions') {
      if (
        request.headers.origin !== baseUrl
        || request.headers['x-csrf-token'] !== 'test-csrf'
      ) {
        response.writeHead(403, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'origin or csrf rejected' }));
        return;
      }
      const value = await body(request);
      state.createCount += 1;
      state.createCalls.push(value);
      if (state.createMode === 'unknown') {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'synthetic create failure' }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: value.id, host: 'local', project: value.project }));
      return;
    }
    const sessionRoute = url.pathname.match(
      /^\/api\/sessions\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(?:\/(send|events|history|stop|respond))?$/,
    );
    if (sessionRoute && !sessionRoute[2] && request.method === 'GET') {
      state.readCalls.push({ path: url.pathname });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        id: sessionRoute[1],
        title: 'Mock chat',
        status: 'idle',
      }));
      return;
    }
    if (sessionRoute?.[2] === 'send' && request.method === 'POST') {
      if (
        request.headers.origin !== baseUrl
        || request.headers['x-csrf-token'] !== 'test-csrf'
      ) {
        response.writeHead(403, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'origin or csrf rejected' }));
        return;
      }
      const value = await body(request);
      state.sendCalls.push(value);
      state.sendCount += 1;
      if (state.sendMode === 'unknown') {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'synthetic upstream failure' }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'accepted', id: value.id }));
      return;
    }
    if (sessionRoute?.[2] === 'events' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('event: state\n');
      response.write('data: {"status":"active","connected":true}\n\n');
      response.end();
      return;
    }
    if (sessionRoute?.[2] === 'history' && request.method === 'POST') {
      state.historyCount += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        id: sessionRoute[1],
        messages: [{ role: 'user', text: 'mock history' }],
      }));
      return;
    }
    if (sessionRoute?.[2] === 'stop' && request.method === 'POST') {
      state.stopCount += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'accepted' }));
      return;
    }
    if (sessionRoute?.[2] === 'respond' && request.method === 'POST') {
      const value = await body(request);
      state.respondCount += 1;
      state.respondCalls.push(value);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'accepted' }));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function startTestHub(t, {
  cmbBaseUrl,
  dataDir,
  adapter = null,
  apiToken = null,
} = {}) {
  const directory = dataDir || await temporaryDirectory(t);
  const config = {
    host: '127.0.0.1',
    port: 0,
    dataDir: directory,
    apiToken,
    cmb: {
      baseUrl: cmbBaseUrl,
      username: 'admin',
      password: 'test-password',
      timeoutMs: 2000,
    },
    voice: { baseUrl: null, token: null, timeoutMs: 1000 },
  };
  const hub = new Hub(config, { adapter });
  const server = createHubServer(hub, { apiToken });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    hub,
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
}

export async function requestJson(baseUrl, pathname, {
  method = 'GET',
  body: value,
  headers = {},
} = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(value === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  };
}
