import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { startMockCmb, startTestHub, requestJson } from './helpers.mjs';

async function activateConsumer(baseUrl, consumer, topics) {
  assert.equal((await requestJson(baseUrl, `/api/trust/${consumer}`, {
    method: 'PATCH',
    body: { installed: true, configured: true, healthy: true },
  })).status, 200);
  assert.equal((await requestJson(baseUrl, `/api/trust/${consumer}/pair`, {
    method: 'POST',
    body: { confirmed: true },
  })).status, 200);
  assert.equal((await requestJson(baseUrl, '/api/subscriptions', {
    method: 'POST',
    body: {
      id: `${consumer}-default`,
      consumer,
      topics,
      delivery: { mode: 'idle', dedupe: 'eventId', ackRequired: true },
    },
  })).status, 201);
}

test('HTTP hub supports lifecycle, bindings, events, inbox ack, and idempotent CMB send', async (t) => {
  const cmb = await startMockCmb();
  t.after(cmb.close);
  const { baseUrl } = await startTestHub(t, { cmbBaseUrl: cmb.baseUrl });

  assert.equal((await requestJson(baseUrl, '/health')).body.ok, true);
  assert.equal((await requestJson(baseUrl, '/api/events?consumer=voice-control')).status, 403);
  await activateConsumer(baseUrl, 'voice-control', ['task.completed', 'task.failed']);
  await activateConsumer(baseUrl, 'bridge-control', ['*']);

  const binding = await requestJson(baseUrl, '/api/bindings', {
    method: 'POST',
    body: {
      controlSessionId: 'control-1',
      workSessionId: 'work-1',
      voiceSessionId: 'voice-1',
    },
  });
  assert.equal(binding.status, 201);
  const bindingRead = await requestJson(baseUrl, `/api/bindings/${binding.body.binding.bindingId}`);
  assert.equal(bindingRead.body.binding.workSessionId, 'work-1');

  const appended = await requestJson(baseUrl, '/api/events', {
    method: 'POST',
    body: {
      source: 'bridge-control',
      topic: 'task.completed',
      scope: { workId: 'work-1' },
      payload: { summary: 'done' },
      dedupeKey: 'work-1:completed',
    },
  });
  assert.equal(appended.status, 201);
  const replay = await requestJson(baseUrl, '/api/events?after=0&consumer=voice-control');
  assert.equal(replay.body.events.length, 1);
  assert.equal(replay.body.nextCursor, '1');

  const queued = await requestJson(baseUrl, '/api/inbox', {
    method: 'POST',
    body: {
      eventId: appended.body.event.eventId,
      consumer: 'voice-control',
    },
  });
  assert.equal(queued.status, 201);
  const started = await requestJson(baseUrl, `/api/inbox/${queued.body.delivery.deliveryId}/start`, {
    method: 'POST',
    body: { consumer: 'voice-control' },
  });
  assert.equal(started.body.delivery.status, 'speaking');
  const acknowledged = await requestJson(baseUrl, `/api/inbox/${queued.body.delivery.deliveryId}/ack`, {
    method: 'POST',
    body: {
      consumer: 'voice-control',
      outcome: 'spoken',
      playbackObserved: true,
    },
  });
  assert.equal(acknowledged.body.delivery.status, 'spoken');

  const message = {
    consumer: 'bridge-control',
    idempotencyKey: 'send-1',
    message: { text: 'continue', mode: 'send' },
  };
  const sent = await requestJson(
    baseUrl,
    '/api/cmb/sessions/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/send',
    { method: 'POST', body: message },
  );
  const repeated = await requestJson(
    baseUrl,
    '/api/cmb/sessions/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/send',
    { method: 'POST', body: message },
  );
  assert.deepEqual(repeated.body, sent.body);
  assert.equal(cmb.state.sendCount, 1);

  const conflict = await requestJson(
    baseUrl,
    '/api/cmb/sessions/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/send',
    {
      method: 'POST',
      body: { ...message, message: { text: 'different', mode: 'send' } },
    },
  );
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'idempotency_conflict');
  assert.equal(cmb.state.sendCount, 1);
});

test('HTTP hub returns unknown once and does not replay a failed CMB write', async (t) => {
  const cmb = await startMockCmb();
  t.after(cmb.close);
  cmb.state.sendMode = 'unknown';
  const { baseUrl } = await startTestHub(t, { cmbBaseUrl: cmb.baseUrl });
  await activateConsumer(baseUrl, 'bridge-control', ['*']);

  const send = () => requestJson(
    baseUrl,
    '/api/cmb/sessions/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/send',
    {
      method: 'POST',
      body: {
        consumer: 'bridge-control',
        idempotencyKey: 'unknown-1',
        message: { text: 'one attempt', mode: 'send' },
      },
    },
  );
  const first = await send();
  const second = await send();
  assert.equal(first.body.status, 'unknown');
  assert.deepEqual(second.body, first.body);
  assert.equal(cmb.state.sendCount, 1);
});

test('SSE route proxies CMB public events and requires the API token when configured', async (t) => {
  const cmb = await startMockCmb();
  t.after(cmb.close);
  const { baseUrl } = await startTestHub(t, {
    cmbBaseUrl: cmb.baseUrl,
    apiToken: 'hub-test-token',
  });
  assert.equal((await requestJson(baseUrl, '/api/status')).status, 401);
  assert.equal((await requestJson(baseUrl, '/api/status', {
    headers: { Authorization: 'Bearer hub-test-token' },
  })).status, 200);

  const controller = new AbortController();
  const response = await fetch(
    `${baseUrl}/api/cmb/sessions/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/events`,
    {
      headers: { Authorization: 'Bearer hub-test-token' },
      signal: controller.signal,
    },
  );
  assert.equal(response.status, 200);
  const text = await response.text();
  controller.abort();
  assert.match(text, /event: state/);
  assert.match(text, /"connected":true/);
});

test('bridge-hub source has no voice/control implementation or CMB source imports', async () => {
  const sourceRoot = path.resolve(import.meta.dirname, '..', 'src');
  const files = await fs.readdir(sourceRoot);
  for (const file of files.filter((name) => name.endsWith('.mjs'))) {
    const source = await fs.readFile(path.join(sourceRoot, file), 'utf8');
    assert.doesNotMatch(source, /(?:from\s+|import\s*\()\s*['"][^'"]*(?:voice-control|bridge-control|codex-mobile-bridge|bridge\/api)[^'"]*['"]/);
  }
});
