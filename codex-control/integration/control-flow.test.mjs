import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { VoiceControlApp } from '../plugins/voice-control/src/app.mjs';
import { TriggerConfigStore } from '../plugins/voice-control/src/config.mjs';
import { createVoiceHttpServer } from '../plugins/voice-control/src/http.mjs';
import { LocalVoiceEvents, TaskEventInbox } from '../plugins/voice-control/src/local-events.mjs';
import { NoticeStore } from '../plugins/voice-control/src/notice-store.mjs';
import { ControlService } from '../plugins/bridge-control/src/control-service.mjs';
import { createDirectBackend } from '../plugins/bridge-control/src/direct-backend.mjs';
import { ControlWebSocketServer } from '../plugins/bridge-control/src/ws-server.mjs';
import { WsEventStore } from '../plugins/bridge-control/src/ws-event-store.mjs';
import {
  PROFILE_VOICE_CONTROLLER,
  PROFILE_WORK_REPORTER,
} from '../plugins/bridge-control/src/profiles.mjs';
import { startMockCmb } from '../plugins/bridge-control/tests/fake-cmb.mjs';
import { ControlWebSocketClient } from '../plugins/voice-control/src/control-ws-client.mjs';

const WS_TOKEN = 'integration-control-flow-token-0123456789';

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-control-e2e-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function request(baseUrl, pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message || `HTTP ${response.status}`);
  return value;
}

test('voice and control plugins close the create-progress-playback loop without bridge-hub', async (t) => {
  const cmb = await startMockCmb();
  t.after(cmb.close);
  const dataDir = await temporaryDirectory(t);
  const eventDir = await temporaryDirectory(t);
  const voiceDataDir = await temporaryDirectory(t);
  const config = new TriggerConfigStore({ filePath: path.join(voiceDataDir, 'config.json') });
  config.load();
  const notices = new NoticeStore({ filePath: path.join(voiceDataDir, 'notices.json') });
  const localEvents = new LocalVoiceEvents({ eventDir });
  const app = new VoiceControlApp({
    triggerConfigStore: config,
    noticeStore: notices,
    chatProvider: {
      configured: true,
      async reply({ messages }) {
        if (messages.at(-1).content === '确认') return '已确认，正在创建任务。';
        return '请确认是否创建这个任务。';
      },
    },
  });
  const inbox = new TaskEventInbox({
    eventDir,
    intervalMs: 20,
    onEvent: (event) => app.tunnel(event),
  });
  inbox.start();
  t.after(() => inbox.stop());
  const server = createVoiceHttpServer({ app });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const voiceBaseUrl = `http://127.0.0.1:${server.address().port}`;

  const wsStore = new WsEventStore(path.join(dataDir, 'ws-events.sqlite'));
  const wsServer = new ControlWebSocketServer({ port: 0, token: WS_TOKEN, store: wsStore });
  const wsAddress = await wsServer.start();
  t.after(async () => {
    await wsServer.close();
    wsStore.close();
  });
  const wsEvents = [];
  const wsClient = new ControlWebSocketClient({
    url: wsAddress.url,
    token: WS_TOKEN,
    reconnectMinMs: 20,
    reconnectMaxMs: 50,
    onEvent: (event) => {
      wsEvents.push(event);
      if (event.topic.startsWith('task.') && event.payload) app.tunnel(event.payload);
    },
  });
  wsClient.start();
  await wsClient.waitUntilConnected(2000);
  t.after(() => wsClient.stop());

  const backend = createDirectBackend({
    cmb: {
      baseUrl: cmb.baseUrl,
      username: 'admin',
      password: 'test-password',
      timeoutMs: 2000,
    },
    dataDir,
    eventDir,
  }, {
    publishEvent: (event) => wsServer.publish({
      schemaVersion: 1,
      eventId: event.eventId,
      correlationId: event.payload?.controlSessionId || null,
      topic: event.topic,
      source: 'bridge-control',
      createdAt: event.createdAt,
      payload: event,
    }),
  });
  t.after(() => backend.close());
  const controller = new ControlService({ backend, profile: PROFILE_VOICE_CONTROLLER });
  const reporter = new ControlService({ backend, profile: PROFILE_WORK_REPORTER });

  const opened = await request(voiceBaseUrl, '/api/open', { method: 'POST', body: {} });
  const voiceSessionId = opened.session.id;
  await request(voiceBaseUrl, `/api/sessions/${voiceSessionId}/chat`, {
    method: 'POST',
    body: { text: '整理交付说明' },
  });
  cmb.setUserTranscript('整理交付说明');

  const missing = await controller.call('bridge_chat_create', {
    sessionId: voiceSessionId,
    draft: { project: 'demo' },
  });
  assert.equal(missing.status, 'needs_input');
  const awaiting = await controller.call('bridge_chat_create', {
    sessionId: voiceSessionId,
    draftId: missing.draftId,
    binding: missing.binding,
    draft: { request: '整理交付说明' },
  });
  assert.equal(awaiting.status, 'awaiting_confirmation');

  await request(voiceBaseUrl, `/api/sessions/${voiceSessionId}/chat`, {
    method: 'POST',
    body: { text: '确认' },
  });
  cmb.setUserTranscript('确认');
  const confirmed = await controller.call('bridge_chat_confirm', {
    sessionId: voiceSessionId,
    draftId: missing.draftId,
    binding: missing.binding,
  });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.creation.status, 'accepted');
  assert.deepEqual(cmb.state.sendCalls[0].skills, ['skill-work-reporter']);

  const progress = await reporter.call('bridge_chat_emit_progress', {
    sessionId: confirmed.creation.sessionId,
    text: '正在整理章节',
    percent: 35,
  });
  assert.equal(progress.status, 'accepted');
  const wsDeadline = Date.now() + 2000;
  while (!wsEvents.some((event) => event.topic === 'task.progress') && Date.now() < wsDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(wsEvents.some((event) => event.topic === 'task.progress'), true);

  const deadline = Date.now() + 2000;
  let notice;
  while (Date.now() < deadline) {
    const events = localEvents.readTaskEvents();
    const progressEvent = events.find((event) => event.topic === 'task.progress');
    if (progressEvent) notice = notices.get(progressEvent.noticeId);
    if (notice) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(notice, 'voice-control should receive the task progress event');
  assert.equal(notice.text, '正在整理章节');

  const events = [];
  app.subscribeEvents(voiceSessionId, { after: 0, onEvent: (event) => events.push(event) });
  const trigger = events.find((event) => event.type === 'trigger' && event.noticeId === notice.noticeId);
  assert.ok(trigger, 'task progress should reach the active voice session');
  await request(voiceBaseUrl, `/api/sessions/${voiceSessionId}/events`, {
    method: 'POST',
    body: {
      type: 'delivery',
      noticeId: notice.noticeId,
      status: 'spoken',
      dedupeKey: `delivery:${notice.noticeId}:spoken`,
    },
  });
  assert.equal(notices.get(notice.noticeId).status, 'spoken');

  const finished = await reporter.call('bridge_chat_finish', {
    sessionId: confirmed.creation.sessionId,
    outcome: 'completed',
    summary: '交付说明已经完成',
  });
  assert.equal(finished.status, 'accepted');
  assert.equal(cmb.state.createCount, 1);
  assert.equal(cmb.state.sendCount, 1);
});
