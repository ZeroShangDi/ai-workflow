import assert from 'node:assert/strict';
import test from 'node:test';

import { VoiceTriggerClient } from '../src/voice-client.mjs';

test('voice trigger client uses only the voice plugin public HTTP contract', async () => {
  const calls = [];
  const client = new VoiceTriggerClient({
    baseUrl: 'http://voice.test',
    token: 'test-token',
    triggerId: 'hub-events',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  await client.health();
  await client.publishTrigger({
    sessionId: 'vcs_1',
    topic: 'task.completed',
    noticeId: 'delivery-1',
    text: '任务完成。',
  });

  assert.equal(calls[0].url, 'http://voice.test/api/health');
  assert.equal(calls[1].url, 'http://voice.test/api/triggers/hub-events/dispatch');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-token');
  assert.equal(JSON.parse(calls[1].options.body).noticeId, 'delivery-1');
});

test('voice trigger dispatch stays disabled without an explicit trigger id', () => {
  const client = new VoiceTriggerClient({
    baseUrl: 'http://voice.test',
    fetchImpl: async () => {
      throw new Error('must not request');
    },
  });
  assert.throws(
    () => client.publishTrigger({ text: 'blocked' }),
    (error) => error.code === 'voice_trigger_not_configured',
  );
});
