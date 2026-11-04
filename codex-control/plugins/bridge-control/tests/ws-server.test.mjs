import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';

import { WsEventStore } from '../src/ws-event-store.mjs';
import { ControlWebSocketServer } from '../src/ws-server.mjs';

const TOKEN = 'test-control-ws-token-0123456789abcdef';

function waitFor(messages, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const value = messages.find(predicate);
      if (value) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error('timed out waiting for WebSocket message'));
      }
    }, 10);
  });
}

test('control WebSocket server authenticates, subscribes, handles requests, and publishes responses', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'control-ws-server-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WsEventStore(path.join(root, 'events.sqlite'));
  const server = new ControlWebSocketServer({
    port: 0,
    token: TOKEN,
    store,
    handler: async ({ event }) => ({
      schemaVersion: 1,
      eventId: 'evt-ready',
      correlationId: event.correlationId,
      topic: 'control.voice_session.ready',
      source: 'bridge-control',
      createdAt: new Date().toISOString(),
      payload: { voiceSessionId: 'session-1', projectKey: 'local|voice' },
    }),
  });
  const address = await server.start();
  t.after(async () => {
    await server.close();
    store.close();
  });

  const socket = new WebSocket(address.url);
  const messages = [];
  socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  t.after(() => socket.close());
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({
    type: 'hello',
    protocolVersion: 1,
    client: { id: 'voice-control', version: '0.3.0' },
    token: TOKEN,
    cursor: '0',
  }));
  await waitFor(messages, (message) => message.type === 'hello.ack');
  socket.send(JSON.stringify({ type: 'subscribe', topics: ['control.*', 'task.*'] }));
  await waitFor(messages, (message) => message.type === 'replay.complete');
  socket.send(JSON.stringify({
    type: 'event',
    event: {
      schemaVersion: 1,
      eventId: 'evt-request',
      correlationId: 'corr-1',
      topic: 'voice.session.ensure.requested',
      source: 'voice-control',
      createdAt: new Date().toISOString(),
      payload: { workspacePath: '/tmp/voice' },
    },
  }));

  const ready = await waitFor(messages, (message) => message.event?.topic === 'control.voice_session.ready');
  assert.equal(ready.event.correlationId, 'corr-1');
  assert.equal(ready.event.payload.voiceSessionId, 'session-1');
  assert.equal(messages.some((message) => message.type === 'event.ack' && message.eventId === 'evt-request'), true);
});

test('control WebSocket server rejects bad authentication and replays retained events after a cursor', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'control-ws-replay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WsEventStore(path.join(root, 'events.sqlite'));
  const retained = store.append({
    schemaVersion: 1,
    eventId: 'evt-retained',
    correlationId: null,
    topic: 'control.task.progress',
    source: 'bridge-control',
    createdAt: new Date().toISOString(),
    payload: { text: '正在执行' },
  });
  const server = new ControlWebSocketServer({ port: 0, token: TOKEN, store });
  const address = await server.start();
  t.after(async () => {
    await server.close();
    store.close();
  });

  const rejected = new WebSocket(address.url);
  const rejectedMessages = [];
  rejected.on('message', (raw) => rejectedMessages.push(JSON.parse(raw.toString())));
  await new Promise((resolve) => rejected.once('open', resolve));
  rejected.send(JSON.stringify({
    type: 'hello',
    protocolVersion: 1,
    client: { id: 'voice-control', version: '0.3.0' },
    token: 'wrong-token-0123456789abcdef0123456789',
  }));
  await new Promise((resolve) => rejected.once('close', resolve));
  assert.equal(rejectedMessages.some((message) => message.type === 'hello.ack'), false);

  const socket = new WebSocket(address.url);
  const messages = [];
  socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  t.after(() => socket.close());
  await new Promise((resolve) => socket.once('open', resolve));
  socket.send(JSON.stringify({
    type: 'hello',
    protocolVersion: 1,
    client: { id: 'voice-control', version: '0.3.0' },
    token: TOKEN,
    cursor: String(Number(retained.cursor) - 1),
  }));
  await waitFor(messages, (message) => message.type === 'hello.ack');
  socket.send(JSON.stringify({ type: 'subscribe', topics: ['control.*'] }));
  const replay = await waitFor(messages, (message) => message.event?.eventId === 'evt-retained');
  assert.equal(replay.event.topic, 'control.task.progress');
});
