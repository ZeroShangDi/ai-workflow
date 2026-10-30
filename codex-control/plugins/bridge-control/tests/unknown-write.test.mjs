import assert from 'node:assert/strict';
import test from 'node:test';

import { ControlService } from '../src/control-service.mjs';
import { PROFILE_VOICE_CONTROLLER } from '../src/plugin.mjs';
import { createVoiceHub, createWorkHub } from './fake-hub.mjs';

test('unknown write results are returned once and are not retryable', async () => {
  let sendCalls = 0;
  const service = new ControlService({
    hub: createVoiceHub({
      sendMessage: async () => {
        sendCalls += 1;
        return { status: 'unknown' };
      },
    }),
    profile: PROFILE_VOICE_CONTROLLER,
  });
  const receipt = await service.call('bridge_chat_send', {
    sessionId: 'session',
    text: '继续',
    mode: 'send',
  });
  assert.equal(receipt.status, 'unknown');
  assert.equal(receipt.retryable, false);
  assert.equal(receipt.reconciliationRequired, true);
  assert.equal(sendCalls, 1);
});

test('unknown write exceptions are normalized without a second call', async () => {
  let finishCalls = 0;
  const service = new ControlService({
    hub: createWorkHub({
      finishWork: async () => {
        finishCalls += 1;
        const failure = new Error('response lost');
        failure.code = 'ETIMEDOUT';
        throw failure;
      },
    }),
    profile: 'work-reporter',
  });
  const receipt = await service.call('bridge_chat_finish', {
    sessionId: 'session',
    outcome: 'completed',
    summary: 'done',
  });
  assert.equal(receipt.status, 'unknown');
  assert.equal(receipt.retryable, false);
  assert.equal(finishCalls, 1);
});
