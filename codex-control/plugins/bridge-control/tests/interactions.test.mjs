import assert from 'node:assert/strict';
import test from 'node:test';

import { ControlService } from '../src/control-service.mjs';
import { PROFILE_VOICE_CONTROLLER } from '../src/plugin.mjs';
import { createVoiceHub } from './fake-hub.mjs';

test('question answers require an exact stable interaction binding', async () => {
  let answerCalls = 0;
  const hub = createVoiceHub({
    latestUserTranscript: async () => ({ turnId: 'turn-9', text: '选第二个' }),
    getPending: async ({ interactionId }) => ({
      interactionId,
      binding: 'bind-question',
      kind: 'question',
    }),
    resolveAnswer: async (request) => {
      answerCalls += 1;
      assert.equal(request.binding, 'bind-question');
      assert.equal(request.transcript.turnId, 'turn-9');
      return { status: 'accepted' };
    },
  });
  const service = new ControlService({ hub, profile: PROFILE_VOICE_CONTROLLER });

  await assert.rejects(
    () => service.call('bridge_chat_answer', {
      sessionId: 'session',
      interactionId: 'question-1',
      binding: 'stale-binding',
      answers: [{ questionId: 'choice', text: '第二个' }],
    }),
    /stale or unknown/,
  );
  assert.equal(answerCalls, 0);

  const receipt = await service.call('bridge_chat_answer', {
    sessionId: 'session',
    interactionId: 'question-1',
    binding: 'bind-question',
    answers: [{ questionId: 'choice', text: '第二个' }],
  });
  assert.equal(receipt.status, 'accepted');
  assert.equal(answerCalls, 1);
});

test('approvals pass the latest transcript and never accept a model boolean', async () => {
  let approvalCalls = 0;
  const hub = createVoiceHub({
    latestUserTranscript: async () => ({ turnId: 'turn-10', text: '确认' }),
    getPending: async ({ interactionId }) => ({
      interactionId,
      binding: 'bind-approval',
      kind: 'approval',
    }),
    resolveApproval: async (request) => {
      approvalCalls += 1;
      assert.equal(request.decision, 'approve');
      assert.equal(request.transcript.text, '确认');
      return { status: 'accepted' };
    },
  });
  const service = new ControlService({ hub, profile: PROFILE_VOICE_CONTROLLER });
  const receipt = await service.call('bridge_chat_approve', {
    sessionId: 'session',
    interactionId: 'approval-1',
    binding: 'bind-approval',
    decision: 'approve',
    approved: true,
  });
  assert.equal(receipt.status, 'accepted');
  assert.equal(approvalCalls, 1);
});
