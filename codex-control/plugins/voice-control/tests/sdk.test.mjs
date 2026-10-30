import assert from 'node:assert/strict';
import test from 'node:test';

import { createVoiceClient } from '../sdk/index.mjs';

test('SDK creates a session without serializing AbortSignal into the request body', async () => {
  let seen = null;
  const client = createVoiceClient({
    baseUrl: 'http://voice.test',
    fetch: async (url, options) => {
      seen = { url: String(url), options };
      return new Response(JSON.stringify({
        ok: true,
        session: { id: 'vcs_1', status: 'open' },
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const controller = new AbortController();
  const session = await client.createSession({ title: 'test', signal: controller.signal });
  assert.equal(session.id, 'vcs_1');
  assert.deepEqual(JSON.parse(seen.options.body), { title: 'test' });
});

test('SDK parses SSE frames with cursors and reports stream end', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'id: 1\nevent: session.opened\ndata: {"schemaVersion":1,"eventId":"evt_1","cursor":"1","type":"session.opened"}\n\n',
    'id: 2\nevent: transcript\ndata: {"schemaVersion":1,"eventId":"evt_2","cursor":"2","type":"transcript","role":"assistant","text":"收到"}\n\n',
    'event: stream.end\ndata: {"reason":"closed","cursor":"2"}\n\n',
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const client = createVoiceClient({
    baseUrl: 'http://voice.test',
    fetch: async () => new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  });

  const events = [];
  let ended = null;
  const handle = await client.subscribe('vcs_1', {
    after: 0,
    onEvent(event) {
      events.push(event);
    },
    onEnd(value) {
      ended = value;
    },
  });
  await handle.finished;
  assert.deepEqual(events.map((event) => event.eventId), ['evt_1', 'evt_2']);
  assert.equal(events[1].text, '收到');
  assert.deepEqual(ended, { reason: 'closed', cursor: '2' });
});

test('SDK dispatches explicitly configured external triggers', async () => {
  let seen = null;
  const client = createVoiceClient({
    baseUrl: 'http://voice.test',
    fetch: async (url, options) => {
      seen = { url: String(url), options };
      return new Response(JSON.stringify({
        ok: true,
        duplicate: false,
        event: { type: 'trigger', noticeId: 'delivery-7' },
      }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const result = await client.dispatchTrigger('trusted-host', {
    sessionId: 'vcs_1',
    topic: 'task.completed',
    noticeId: 'delivery-7',
    text: '任务完成。',
  });
  assert.equal(seen.url, 'http://voice.test/api/triggers/trusted-host/dispatch');
  assert.equal(JSON.parse(seen.options.body).noticeId, 'delivery-7');
  assert.equal(result.event.noticeId, 'delivery-7');
});
