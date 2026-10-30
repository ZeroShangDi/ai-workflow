import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCursor, serializeSseEvent, SessionEventLog } from '../src/events.mjs';

test('uses ai-market transcript, voice, and activity semantics with stable cursors', () => {
  const log = new SessionEventLog('vcs_test');
  const opened = log.append({ type: 'session.opened', message: '语音会话已打开。' });
  const user = log.append({ type: 'transcript', role: 'user', text: '你好' });
  const assistant = log.append({ type: 'transcript', role: 'assistant', text: '我在' });
  const activity = log.append({ type: 'activity', state: 'listening' });
  const voice = log.append({ type: 'voice', state: 'speaking', event: 'bot_started' });

  assert.equal(opened.event.cursor, '1');
  assert.equal(user.event.type, 'transcript');
  assert.equal(user.event.role, 'user');
  assert.equal(assistant.event.role, 'assistant');
  assert.equal(activity.event.state, 'listening');
  assert.equal(voice.event.state, 'speaking');
  assert.equal(voice.event.event, 'bot_started');
  assert.deepEqual(
    log.after(2).map((event) => event.cursor),
    ['3', '4', '5'],
  );
  assert.equal(log.nextCursor, '5');
});

test('deduplicates semantic writes and emits SSE cursor frames', () => {
  const log = new SessionEventLog('vcs_test');
  const first = log.append({
    type: 'transcript',
    role: 'user',
    text: '同一条消息',
    dedupeKey: 'request-1',
  });
  const duplicate = log.append({
    type: 'transcript',
    role: 'user',
    text: '同一条消息',
    dedupeKey: 'request-1',
  });

  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.event.eventId, first.event.eventId);
  assert.equal(log.events.length, 1);
  const frame = serializeSseEvent(first.event);
  assert.match(frame, /^id: 1\nevent: transcript\n/m);
  assert.equal(JSON.parse(frame.match(/^data: (.*)$/m)[1]).role, 'user');
});

test('rejects invalid states and cursors', () => {
  const log = new SessionEventLog('vcs_test');
  assert.throws(
    () => log.append({ type: 'activity', state: 'sleeping' }),
    /state is invalid/,
  );
  assert.throws(
    () => log.append({ type: 'transcript', role: 'operator', text: 'invalid' }),
    /role is invalid/,
  );
  assert.equal(parseCursor(undefined), 0);
  assert.throws(() => parseCursor('-1'), /non-negative integer/);
});
