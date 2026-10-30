import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { VoiceControlApp } from '../src/app.mjs';
import { TriggerConfigStore } from '../src/config.mjs';
import { NoticeStore } from '../src/notice-store.mjs';

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-control-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('standalone voice chat produces user and assistant transcript events', async (t) => {
  const directory = workspace(t);
  const config = new TriggerConfigStore({ filePath: path.join(directory, 'config.json') });
  config.load();
  const recorded = [];
  const app = new VoiceControlApp({
    triggerConfigStore: config,
    chatProvider: {
      configured: true,
      async reply({ messages }) {
        assert.equal(messages.at(-1).content, '你好');
        return '你好，我在。';
      },
    },
    transcriptRecorder: (value) => recorded.push(value),
  });
  const session = app.createSession({});
  const result = await app.chat(session.id, { text: '你好' });
  assert.equal(result.status, 'accepted');
  const events = [];
  app.subscribeEvents(session.id, {
    after: 0,
    onEvent: (event) => events.push(event),
  });
  assert.equal(events.some((event) => event.type === 'transcript' && event.role === 'user' && event.text === '你好'), true);
  assert.equal(events.some((event) => event.type === 'transcript' && event.role === 'assistant' && event.text === '你好，我在。'), true);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].sessionId, session.id);
  assert.equal(recorded[0].text, '你好');
});

test('external task events stay in voice-control and are acknowledged locally', (t) => {
  const directory = workspace(t);
  const config = new TriggerConfigStore({ filePath: path.join(directory, 'config.json') });
  config.load();
  const notices = new NoticeStore({ filePath: path.join(directory, 'notices.json') });
  const app = new VoiceControlApp({ triggerConfigStore: config, noticeStore: notices });
  const session = app.createSession({});
  const delivered = app.tunnel({
    eventId: 'evt-1',
    topic: 'task.progress',
    text: '任务正在整理文档。',
    sessionId: session.id,
  });
  assert.equal(delivered.deliveredSessionId, session.id);
  assert.equal(notices.get('evt-1').status, 'queued');
  app.appendEvent(session.id, {
    type: 'delivery',
    noticeId: 'evt-1',
    status: 'spoken',
    dedupeKey: 'delivery:evt-1:spoken',
  });
  assert.equal(notices.get('evt-1').status, 'spoken');
  assert.deepEqual(notices.pending(), []);
});
