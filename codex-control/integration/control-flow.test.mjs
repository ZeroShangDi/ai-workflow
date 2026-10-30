import assert from 'node:assert/strict';
import test from 'node:test';

import { createHubClient } from '../bridge-hub/src/control-client.mjs';
import {
  requestJson,
  startMockCmb,
  startTestHub,
} from '../bridge-hub/tests/helpers.mjs';
import { ControlService } from '../plugins/bridge-control/src/control-service.mjs';
import {
  PROFILE_VOICE_CONTROLLER,
  PROFILE_WORK_REPORTER,
} from '../plugins/bridge-control/src/profiles.mjs';

async function activateConsumer(baseUrl, consumer, topics, token) {
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await requestJson(baseUrl, `/api/trust/${consumer}`, {
    method: 'PATCH',
    body: { installed: true, configured: true, healthy: true },
    headers,
  })).status, 200);
  assert.equal((await requestJson(baseUrl, `/api/trust/${consumer}/pair`, {
    method: 'POST',
    body: { confirmed: true },
    headers,
  })).status, 200);
  assert.equal((await requestJson(baseUrl, '/api/subscriptions', {
    method: 'POST',
    body: {
      id: `${consumer}-e2e`,
      consumer,
      topics,
      delivery: { mode: 'idle', dedupe: 'eventId', ackRequired: true },
    },
    headers,
  })).status, 201);
}

test('voice controller, Hub, work reporter, and CMB complete one confirmed control loop', async (t) => {
  const cmb = await startMockCmb();
  t.after(cmb.close);
  const token = 'integration-token';
  const { baseUrl, hub } = await startTestHub(t, {
    cmbBaseUrl: cmb.baseUrl,
    apiToken: token,
  });
  await activateConsumer(baseUrl, 'voice-control', [
    'interaction.requested',
    'task.completed',
    'task.failed',
    'task.stopped',
  ], token);
  await activateConsumer(baseUrl, 'work-reporter', ['*'], token);

  const voiceHub = createHubClient({
    env: {
      BRIDGE_HUB_URL: baseUrl,
      BRIDGE_HUB_API_TOKEN: token,
      BRIDGE_CONTROL_CONSUMER: 'voice-control',
      BRIDGE_VOICE_CONSUMER: 'voice-control',
    },
  });
  const reporterHub = createHubClient({
    env: {
      BRIDGE_HUB_URL: baseUrl,
      BRIDGE_HUB_API_TOKEN: token,
      BRIDGE_CONTROL_CONSUMER: 'work-reporter',
    },
  });
  const voice = new ControlService({
    hub: voiceHub,
    profile: PROFILE_VOICE_CONTROLLER,
  });
  const reporter = new ControlService({
    hub: reporterHub,
    profile: PROFILE_WORK_REPORTER,
  });

  const missing = await voice.call('bridge_chat_create', {
    sessionId: 'voice-session-1',
    draft: { project: 'demo' },
  });
  assert.equal(missing.status, 'needs_input');
  assert.deepEqual(missing.missing, ['request']);

  await requestJson(baseUrl, '/api/v1/transcripts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: {
      sessionId: 'voice-session-1',
      turnId: 'turn-1',
      text: '整理当前项目的交付说明',
    },
  });
  const awaiting = await voice.call('bridge_chat_create', {
    sessionId: 'voice-session-1',
    draftId: missing.draftId,
    binding: missing.binding,
    draft: { request: '整理当前项目的交付说明' },
  });
  assert.equal(awaiting.status, 'awaiting_confirmation');

  await requestJson(baseUrl, '/api/v1/transcripts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: {
      sessionId: 'voice-session-1',
      turnId: 'turn-2',
      text: '确认',
    },
  });
  const creation = await voice.call('bridge_chat_confirm', {
    sessionId: 'voice-session-1',
    draftId: missing.draftId,
    binding: missing.binding,
  });
  assert.equal(creation.status, 'confirmed');
  assert.equal(creation.creation.status, 'accepted');
  assert.equal(cmb.state.createCount, 1);
  assert.equal(cmb.state.createCalls[0].project, 'local|demo');
  assert.equal(cmb.state.sendCalls[0].text, '整理当前项目的交付说明');

  const workSessionId = creation.creation.sessionId;
  const workId = creation.creation.workId;
  const found = await voice.call('bridge_chat_find', { query: '交付说明' });
  assert.equal(found.candidates.some((item) => item.workId === workId), true);
  const status = await voice.call('bridge_chat_status', { workId });
  assert.equal(status.sessionId, workSessionId);
  const history = await voice.call('bridge_chat_read', {
    workId,
    view: 'history',
  });
  assert.equal(history.history.messages[0].text, 'mock history');

  const progress = await reporter.call('bridge_chat_emit_progress', {
    sessionId: workSessionId,
    text: '正在整理目录与变更记录',
    percent: 40,
  });
  assert.equal(progress.status, 'accepted');

  const approval = await reporter.call('bridge_chat_request_approval', {
    sessionId: workSessionId,
    operation: '发布交付说明',
    target: 'docs/delivery.md',
    impact: '会覆盖现有文件',
    reversibility: 'reversible',
    speak: '是否确认发布交付说明？',
  });
  assert.equal(approval.status, 'pending');
  const pending = await voice.call('bridge_chat_pending', {
    sessionId: 'voice-session-1',
    interactionId: approval.interactionId,
  });
  assert.equal(pending.binding, approval.binding);
  await assert.rejects(
    () => voice.call('bridge_chat_approve', {
      sessionId: 'voice-session-1',
      interactionId: approval.interactionId,
      binding: approval.binding,
      decision: 'approve',
    }),
    /no newer real user transcript/,
  );

  await requestJson(baseUrl, '/api/v1/transcripts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: {
      sessionId: 'voice-session-1',
      turnId: 'turn-3',
      text: '确认',
    },
  });
  const approved = await voice.call('bridge_chat_approve', {
    sessionId: 'voice-session-1',
    interactionId: approval.interactionId,
    binding: approval.binding,
    decision: 'approve',
  });
  assert.equal(approved.status, 'accepted');
  assert.equal(approved.decision, 'approve');

  const finished = await reporter.call('bridge_chat_finish', {
    sessionId: workSessionId,
    outcome: 'completed',
    summary: '交付说明已发布，变更记录已整理。',
  });
  assert.equal(finished.status, 'accepted');

  const events = await voice.call('bridge_chat_events', {
    sessionId: 'voice-session-1',
    after: '0',
    topics: ['interaction.requested', 'task.completed'],
  });
  assert.equal(events.events.some((event) => event.topic === 'task.completed'), true);
  assert.equal(events.events.some((event) => event.topic === 'interaction.requested'), true);

  const queued = hub.inbox.list({ consumer: 'voice-control', status: 'queued' });
  assert.equal(queued.length >= 1, true);
  hub.inbox.start(queued[0].deliveryId, { consumer: 'voice-control' });
  const acknowledged = await voice.acknowledgeAnnouncement({
    noticeId: queued[0].deliveryId,
    deliveryStatus: 'spoken',
  });
  assert.equal(acknowledged.delivery.status, 'spoken');

  assert.equal(cmb.state.sendCount, 2);
  assert.equal(cmb.state.respondCount, 0);
});
