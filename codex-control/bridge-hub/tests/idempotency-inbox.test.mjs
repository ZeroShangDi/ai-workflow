import assert from 'node:assert/strict';
import test from 'node:test';

import { IdempotencyStore } from '../src/idempotency.mjs';
import { DeliveryInbox } from '../src/inbox.mjs';
import { temporaryDirectory } from './helpers.mjs';

test('idempotency executes once, rejects request drift, and never replays unknown writes', async (t) => {
  const directory = await temporaryDirectory(t);
  const store = new IdempotencyStore({ dataDir: directory });
  let calls = 0;
  const first = await store.execute({
    key: 'send-1',
    payload: { sessionId: 's1', text: 'hello' },
    operation: async () => {
      calls += 1;
      return { status: 'accepted', id: 'message-1' };
    },
  });
  const duplicate = await store.execute({
    key: 'send-1',
    payload: { sessionId: 's1', text: 'hello' },
    operation: async () => {
      calls += 1;
      return { status: 'accepted', id: 'message-2' };
    },
  });
  assert.deepEqual(duplicate, first);
  assert.equal(calls, 1);
  await assert.rejects(
    store.execute({
      key: 'send-1',
      payload: { sessionId: 's1', text: 'different' },
      operation: async () => ({ status: 'accepted' }),
    }),
    (error) => error.code === 'idempotency_conflict',
  );

  let unknownCalls = 0;
  const unknownOperation = async () => {
    unknownCalls += 1;
    throw Object.assign(new Error('socket closed'), { unknown: true });
  };
  const unknown = await store.execute({
    key: 'send-unknown',
    payload: { text: 'one write' },
    operation: unknownOperation,
  });
  const unknownReplay = await store.execute({
    key: 'send-unknown',
    payload: { text: 'one write' },
    operation: unknownOperation,
  });
  assert.equal(unknown.status, 'unknown');
  assert.deepEqual(unknownReplay, unknown);
  assert.equal(unknownCalls, 1);
});

test('durable inbox dedupes and only the consumer can acknowledge explicit playback state', async (t) => {
  const directory = await temporaryDirectory(t);
  const inbox = new DeliveryInbox({ dataDir: directory });
  const event = {
    eventId: 'evt-1',
    cursor: '1',
    topic: 'task.completed',
    dedupeKey: 'work-1:completed',
    scope: { workId: 'work-1' },
    payload: { summary: 'done' },
  };
  const first = inbox.enqueue({ event, consumer: 'voice-control', ackRequired: true });
  const duplicate = inbox.enqueue({ event, consumer: 'voice-control' });
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.delivery.deliveryId, first.delivery.deliveryId);

  inbox.start(first.delivery.deliveryId, { consumer: 'voice-control' });
  assert.throws(
    () => inbox.acknowledge(first.delivery.deliveryId, {
      consumer: 'bridge-control',
      outcome: 'spoken',
      playbackObserved: true,
    }),
    (error) => error.code === 'consumer_mismatch',
  );
  assert.throws(
    () => inbox.acknowledge(first.delivery.deliveryId, {
      consumer: 'voice-control',
      outcome: 'spoken',
      playbackObserved: false,
    }),
    (error) => error.code === 'playback_observation_required',
  );
  const acknowledged = inbox.acknowledge(first.delivery.deliveryId, {
    consumer: 'voice-control',
    outcome: 'spoken',
    playbackObserved: true,
  });
  assert.equal(acknowledged.status, 'spoken');
  assert.equal(acknowledged.ackRequired, true);
  assert.equal(acknowledged.acknowledgedBy, 'voice-control');

  const reloaded = new DeliveryInbox({ dataDir: directory });
  assert.equal(reloaded.get(first.delivery.deliveryId).status, 'spoken');
});

test('inbox records an explicit failed receipt before playback starts', () => {
  const inbox = new DeliveryInbox();
  const queued = inbox.enqueue({
    event: {
      eventId: 'evt-2',
      cursor: '2',
      topic: 'task.failed',
      dedupeKey: 'work-2:failed',
      scope: { workId: 'work-2' },
      payload: {},
    },
    consumer: 'voice-control',
  });
  const failed = inbox.acknowledge(queued.delivery.deliveryId, {
    consumer: 'voice-control',
    outcome: 'failed',
    playbackObserved: false,
    error: 'audio device unavailable',
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'audio device unavailable');
});
