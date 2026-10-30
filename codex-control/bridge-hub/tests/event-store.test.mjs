import assert from 'node:assert/strict';
import test from 'node:test';

import { EventStore } from '../src/event-store.mjs';
import { temporaryDirectory } from './helpers.mjs';

function event(overrides = {}) {
  return {
    source: 'bridge-control',
    topic: 'task.completed',
    scope: { workId: 'work-1' },
    payload: { summary: 'done' },
    dedupeKey: 'task-1:completed',
    ...overrides,
  };
}

test('event store allocates stable ids and cursors, dedupes, replays, and reloads', async (t) => {
  const directory = await temporaryDirectory(t);
  const store = new EventStore({ dataDir: directory });

  const first = store.append(event());
  const duplicate = store.append(event());
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.event.eventId, first.event.eventId);
  assert.equal(duplicate.event.cursor, '1');

  assert.throws(
    () => store.append(event({ payload: { summary: 'different' } })),
    (error) => error.code === 'dedupe_conflict',
  );

  const second = store.append(event({
    topic: 'task.failed',
    dedupeKey: 'task-2:failed',
    scope: { workId: 'work-2' },
    payload: { summary: 'failed' },
  }));
  assert.equal(second.event.cursor, '2');

  const replay = store.read({ after: '1', limit: 10 });
  assert.equal(replay.events.length, 1);
  assert.equal(replay.events[0].eventId, second.event.eventId);
  assert.equal(replay.nextCursor, '2');
  assert.throws(
    () => store.read({ after: '99' }),
    (error) => error.code === 'cursor_resync',
  );

  const reloaded = new EventStore({ dataDir: directory });
  assert.equal(reloaded.lastCursor, 2);
  assert.equal(reloaded.get(first.event.eventId).payload.summary, 'done');
});

test('topic gaps do not strand the cursor', () => {
  const store = new EventStore();
  store.append(event({ dedupeKey: 'one' }));
  store.append(event({ dedupeKey: 'two', topic: 'artifact.ready' }));
  const page = store.read({ after: '0', limit: 1, topics: ['task.completed'] });
  assert.equal(page.events.length, 1);
  assert.equal(page.nextCursor, '1');
  const next = store.read({ after: page.nextCursor, limit: 1, topics: ['task.completed'] });
  assert.equal(next.events.length, 0);
  assert.equal(next.nextCursor, '2');
});

test('event payload rejects obvious plaintext credential fields', () => {
  const store = new EventStore();
  assert.throws(
    () => store.append(event({
      dedupeKey: 'secret-event',
      payload: { nested: { password: 'not-allowed' } },
    })),
    (error) => error.code === 'credential_payload_rejected',
  );
});
