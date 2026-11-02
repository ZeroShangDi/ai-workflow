import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocketServer } from 'ws';

import { ControlWebSocketClient } from '../src/control-ws-client.mjs';

const TOKEN = 'test-voice-ws-token-0123456789abcdef';

async function startServer(t) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => {
    for (const socket of sockets) socket.terminate();
    server.close(resolve);
  }));
  return server;
}

test('voice WebSocket client authenticates, subscribes, queues a request, and resolves by correlation id', async (t) => {
  const server = await startServer(t);
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'hello') {
        socket.send(JSON.stringify({
          type: 'hello.ack',
          protocolVersion: 1,
          cursor: '0',
          server: { id: 'bridge-control', version: '0.3.0' },
        }));
      }
      if (message.type === 'subscribe') {
        socket.send(JSON.stringify({ type: 'subscribe.ack', topics: message.topics }));
        socket.send(JSON.stringify({ type: 'replay.complete', cursor: '0' }));
      }
      if (message.type === 'event') {
        socket.send(JSON.stringify({
          type: 'event.ack',
          eventId: message.event.eventId,
          cursor: '1',
        }));
        socket.send(JSON.stringify({
          type: 'event',
          event: {
            schemaVersion: 1,
            eventId: 'evt-ready',
            correlationId: message.event.correlationId,
            topic: 'control.voice_session.ready',
            source: 'bridge-control',
            createdAt: new Date().toISOString(),
            cursor: '2',
            payload: { voiceSessionId: 'session-1', projectKey: 'local|voice' },
          },
        }));
      }
    });
  });
  const client = new ControlWebSocketClient({
    url: `ws://127.0.0.1:${server.address().port}`,
    token: TOKEN,
    reconnectMinMs: 20,
    reconnectMaxMs: 50,
  });
  t.after(() => client.stop());
  client.start();
  await client.waitUntilConnected(2000);

  const response = await client.request('voice.session.ensure.requested', { workspacePath: '/tmp/voice' });

  assert.equal(response.topic, 'control.voice_session.ready');
  assert.equal(response.payload.voiceSessionId, 'session-1');
  assert.equal(client.cursor, '2');
});

test('voice WebSocket client reports unavailable instead of blocking standalone startup', async (t) => {
  const observed = [];
  const client = new ControlWebSocketClient({
    url: 'ws://127.0.0.1:1',
    token: TOKEN,
    reconnectMinMs: 20,
    reconnectMaxMs: 20,
    onStatus: (status) => observed.push(status.state),
  });
  t.after(() => client.stop());
  client.start();
  await assert.rejects(() => client.waitUntilConnected(120), /unavailable/);
  assert.equal(observed.includes('connecting'), true);
  assert.equal(observed.includes('unavailable'), true);
});
