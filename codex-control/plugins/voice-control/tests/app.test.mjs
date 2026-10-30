import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { VoiceControlApp } from '../src/app.mjs';
import { TriggerConfigStore } from '../src/config.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-control-app-'));

function createApp() {
  const store = new TriggerConfigStore({ filePath: path.join(root, 'config.json') });
  store.load();
  return {
    app: new VoiceControlApp({ triggerConfigStore: store }),
    store,
  };
}

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('opens, streams, and closes a session with an ordered terminal event', () => {
  const { app } = createApp();
  const session = app.createSession({ title: 'test' });
  const seen = [];
  let ended = null;
  const subscription = app.subscribeEvents(session.id, {
    after: 0,
    onEvent(event) {
      seen.push(event.type);
    },
    onEnd(payload) {
      ended = payload;
    },
  });

  app.appendEvent(session.id, { type: 'transcript', role: 'user', text: '你好' });
  app.appendEvent(session.id, { type: 'activity', state: 'thinking' });
  app.appendEvent(session.id, { type: 'voice', state: 'speaking', event: 'bot_started' });
  const closed = app.closeSession(session.id);

  assert.deepEqual(seen, ['session.opened', 'transcript', 'activity', 'voice', 'session.closed']);
  assert.equal(ended.reason, 'closed');
  assert.equal(closed.status, 'closed');
  assert.equal(app.closeSession(session.id).status, 'closed');
  assert.equal(subscription.closed, false);
  assert.throws(
    () => app.appendEvent(session.id, { type: 'transcript', role: 'user', text: '迟到' }),
    /already closed/,
  );
  assert.deepEqual(app.health().sessions, { total: 1, open: 0 });
});

test('replays only events after the requested cursor without duplicate delivery', () => {
  const { app } = createApp();
  const session = app.createSession();
  app.appendEvent(session.id, { type: 'transcript', role: 'user', text: '第一条' });
  app.appendEvent(session.id, { type: 'transcript', role: 'assistant', text: '第二条' });

  const replayed = [];
  app.subscribeEvents(session.id, {
    after: 1,
    onEvent(event) {
      replayed.push(event.cursor);
    },
  });
  assert.deepEqual(replayed, ['2', '3']);
});

test('rejects trigger dispatch until an enabled topic subscription exists', () => {
  const { app, store } = createApp();
  const session = app.createSession();
  const request = {
    sessionId: session.id,
    topic: 'task.completed',
    eventId: 'event-1',
    noticeId: 'delivery-1',
    text: '任务完成。',
  };

  assert.throws(
    () => app.dispatchTrigger('trusted-host', request),
    (error) => error.code === 'trigger_not_configured' && error.status === 409,
  );
  store.replace({
    schemaVersion: 1,
    triggers: [{
      id: 'trusted-host',
      enabled: false,
      topics: ['task.completed'],
    }],
  });
  assert.throws(
    () => app.dispatchTrigger('trusted-host', request),
    (error) => error.code === 'trigger_not_configured',
  );
  store.replace({
    schemaVersion: 1,
    triggers: [{
      id: 'trusted-host',
      enabled: true,
      topics: ['task.completed'],
    }],
  });

  const first = app.dispatchTrigger('trusted-host', request);
  const duplicate = app.dispatchTrigger('trusted-host', request);
  assert.equal(first.event.type, 'trigger');
  assert.equal(first.event.source, 'system');
  assert.equal(first.event.noticeId, 'delivery-1');
  assert.equal(duplicate.duplicate, true);
  const delivery = app.appendEvent(session.id, {
    type: 'delivery',
    noticeId: 'delivery-1',
    status: 'spoken',
  });
  assert.equal(delivery.event.state, 'spoken');
  assert.equal(app.health().lifecycle.subscribed, true);
  assert.throws(
    () => app.dispatchTrigger('trusted-host', { ...request, topic: 'task.failed' }),
    (error) => error.code === 'trigger_topic_not_subscribed',
  );
});
