import assert from 'node:assert/strict';
import test from 'node:test';

import { ControlService } from '../src/control-service.mjs';
import { PROFILE_VOICE_CONTROLLER } from '../src/plugin.mjs';
import { createVoiceBackend } from './fake-backend.mjs';

test('create draft transitions through needs_input and confirmation without boolean authorization', async () => {
  let transcript = { turnId: 'turn-1', text: '帮我创建一个测试任务' };
  let createCalls = 0;
  const backend = createVoiceBackend({
    latestUserTranscript: async () => transcript,
    createWork: async (request) => {
      createCalls += 1;
      assert.equal(request.transcript.turnId, 'turn-2');
      assert.equal(request.draftId, complete.draftId);
      assert.equal(request.binding, complete.binding);
      return { status: 'accepted', workId: 'work-42' };
    },
  });
  const service = new ControlService({ backend, profile: PROFILE_VOICE_CONTROLLER });

  const incomplete = await service.call('bridge_chat_create', {
    sessionId: 'voice-session',
    draft: { project: 'codex-control' },
  });
  assert.equal(incomplete.status, 'needs_input');
  assert.deepEqual(incomplete.missing, ['request']);

  const complete = await service.call('bridge_chat_create', {
    sessionId: 'voice-session',
    draftId: incomplete.draftId,
    binding: incomplete.binding,
    draft: { request: '运行 smoke test' },
  });
  assert.equal(complete.status, 'awaiting_confirmation');

  const sameTurn = await service.call('bridge_chat_confirm', {
    sessionId: 'voice-session',
    draftId: complete.draftId,
    binding: complete.binding,
    confirmed: true,
  });
  assert.equal(sameTurn.outcome, 'confirmation_not_observed');
  assert.equal(createCalls, 0);

  transcript = { turnId: 'turn-2', text: '确认' };
  const confirmed = await service.call('bridge_chat_confirm', {
    sessionId: 'voice-session',
    draftId: complete.draftId,
    binding: complete.binding,
  });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.creation.workId, 'work-42');
  assert.equal(createCalls, 1);
});


test('defaults to the configured workspace when project is omitted', async () => {
  let transcript = { turnId: 'turn-1', text: '创建任务' };
  let captured = null;
  const service = new ControlService({
    profile: PROFILE_VOICE_CONTROLLER,
    defaultProject: 'local|voice-workspace',
    backend: createVoiceBackend({
      latestUserTranscript: async () => transcript,
      createWork: async (request) => {
        captured = request.draft;
        return { status: 'accepted', workId: 'work-default-project' };
      },
    }),
  });
  const pending = await service.call('bridge_chat_create', {
    sessionId: 'session',
    draft: { request: '输出 hello' },
  });
  assert.equal(pending.status, 'awaiting_confirmation');
  assert.match(pending.summary, /默认工作空间/);
  transcript = { turnId: 'turn-2', text: '确认创建' };
  const confirmed = await service.call('bridge_chat_confirm', {
    sessionId: 'session',
    draftId: pending.draftId,
    binding: pending.binding,
  });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(captured.project, 'local|voice-workspace');
});

test('negative transcript cancels a draft and terminal state does not recreate', async () => {
  let transcript = { turnId: 'turn-1', text: '创建任务' };
  let createCalls = 0;
  const service = new ControlService({
    backend: createVoiceBackend({
      latestUserTranscript: async () => transcript,
      createWork: async () => {
        createCalls += 1;
        return { status: 'accepted', workId: 'unexpected' };
      },
    }),
    profile: PROFILE_VOICE_CONTROLLER,
  });
  const pending = await service.call('bridge_chat_create', {
    sessionId: 'session',
    draft: { project: 'p', request: 'r' },
  });
  transcript = { turnId: 'turn-2', text: '不行' };
  const cancelled = await service.call('bridge_chat_confirm', {
    sessionId: 'session',
    draftId: pending.draftId,
    binding: pending.binding,
  });
  assert.equal(cancelled.status, 'cancelled');
  const repeated = await service.call('bridge_chat_confirm', {
    sessionId: 'session',
    draftId: pending.draftId,
    binding: pending.binding,
  });
  assert.equal(repeated.status, 'cancelled');
  assert.equal(createCalls, 0);
});

test('editing a draft invalidates the confirmation baseline', async () => {
  let transcript = { turnId: 'turn-1', text: '创建任务' };
  let createCalls = 0;
  const service = new ControlService({
    backend: createVoiceBackend({
      latestUserTranscript: async () => transcript,
      createWork: async () => {
        createCalls += 1;
        return { status: 'accepted', workId: 'unexpected' };
      },
    }),
    profile: PROFILE_VOICE_CONTROLLER,
  });
  const pending = await service.call('bridge_chat_create', {
    sessionId: 'session',
    draft: { project: 'p', request: 'first request' },
  });
  transcript = { turnId: 'turn-2', text: '确认' };
  const revised = await service.call('bridge_chat_create', {
    sessionId: 'session',
    draftId: pending.draftId,
    binding: pending.binding,
    draft: { request: 'changed request' },
  });
  assert.equal(revised.status, 'awaiting_confirmation');
  const sameTurn = await service.call('bridge_chat_confirm', {
    sessionId: 'session',
    draftId: revised.draftId,
    binding: revised.binding,
  });
  assert.equal(sameTurn.outcome, 'confirmation_not_observed');
  assert.equal(createCalls, 0);
});

test('unknown create result keeps the confirmation state and is not replayed', async () => {
  let transcript = { turnId: 'turn-1', text: '创建任务' };
  let createCalls = 0;
  const service = new ControlService({
    backend: createVoiceBackend({
      latestUserTranscript: async () => transcript,
      createWork: async () => {
        createCalls += 1;
        return { status: 'unknown' };
      },
    }),
    profile: PROFILE_VOICE_CONTROLLER,
  });
  const pending = await service.call('bridge_chat_create', {
    sessionId: 'session',
    draft: { project: 'p', request: 'r' },
  });
  transcript = { turnId: 'turn-2', text: '确认' };
  const unknown = await service.call('bridge_chat_confirm', {
    sessionId: 'session',
    draftId: pending.draftId,
    binding: pending.binding,
  });
  assert.equal(unknown.status, 'awaiting_confirmation');
  assert.equal(unknown.writeStatus, 'unknown');
  assert.equal(unknown.retryable, false);
  assert.equal(unknown.reconciliationRequired, true);
  const repeated = await service.call('bridge_chat_confirm', {
    sessionId: 'session',
    draftId: pending.draftId,
    binding: pending.binding,
  });
  assert.equal(repeated.writeStatus, 'unknown');
  assert.equal(createCalls, 1);
});

test('a failed create receipt is never reported as confirmed', async () => {
  let transcript = { turnId: 'turn-1', text: '创建任务' };
  const service = new ControlService({
    backend: createVoiceBackend({
      latestUserTranscript: async () => transcript,
      createWork: async () => ({
        status: 'failed',
        code: 'project_not_found',
        error: 'project does not exist',
      }),
    }),
    profile: PROFILE_VOICE_CONTROLLER,
  });
  const pending = await service.call('bridge_chat_create', {
    sessionId: 'session',
    draft: { project: 'missing', request: '创建任务' },
  });
  transcript = { turnId: 'turn-2', text: '确认' };
  const result = await service.call('bridge_chat_confirm', {
    sessionId: 'session',
    draftId: pending.draftId,
    binding: pending.binding,
  });
  assert.equal(result.status, 'awaiting_confirmation');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.retryable, false);
  assert.match(result.message, /project does not exist/);
});
