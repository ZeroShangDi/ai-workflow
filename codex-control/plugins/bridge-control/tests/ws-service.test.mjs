import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ControlWebSocketService } from '../src/ws-service.mjs';

function event(topic, payload = {}, correlationId = 'corr-1') {
  return {
    schemaVersion: 1,
    eventId: 'evt-request-1',
    correlationId,
    topic,
    source: 'voice-control',
    createdAt: new Date().toISOString(),
    payload,
  };
}

function fakeCmb(overrides = {}) {
  const calls = { create: [], send: [], catalog: [], sessions: [], view: [], security: [] };
  let assistant = null;
  return {
    calls,
    async createSession(value) {
      calls.create.push(value);
      return { id: value.project === 'local|independent' ? 'init-session-1' : 'voice-session-1' };
    },
    async catalog(sessionId, options) {
      calls.catalog.push({ sessionId, options });
      return {
        skills: [
          { id: 'skill-voice-integration', name: 'voice-integration' },
          { id: 'skill-character', name: 'character-settings' },
          { id: 'skill-bridge-cli', name: 'bridge-control-cli' },
        ],
      };
    },
    async send(sessionId, value) {
      calls.send.push({ sessionId, value });
      if (sessionId === 'voice-session-1') {
        assistant = { id: 'assistant-1', text: '你好，我在。' };
      }
      return { status: 'accepted' };
    },
    async updateSecuritySettings(sessionId, settings) {
      calls.security.push({ sessionId, settings });
      return { applied: true, confirmed: true };
    },
    async projects() {
      return { projects: [{ key: 'local|voice', cwd: '/tmp/voice-workspace' }] };
    },
    async sessions(options) {
      calls.sessions.push(options);
      return { sessions: [] };
    },
    async view(sessionId) {
      calls.view.push(sessionId);
      return {
        id: sessionId,
        title: '语音助手',
        status: 'idle',
        cwd: '/tmp/voice-workspace',
        turns: assistant ? [{
          id: 'turn-1',
          status: 'completed',
          messages: [{ role: 'assistant', ...assistant }],
        }] : [],
      };
    },
    ...overrides,
  };
}

test('initialization event creates an independent Agent session and attaches the voice integration skill', async () => {
  const cmb = fakeCmb();
  const service = new ControlWebSocketService({ cmb, now: () => new Date('2026-10-31T12:00:00Z') });
  const response = await service.handle(event('voice.initialization.requested', {
    requestId: '123e4567-e89b-42d3-a456-426614174000',
    configPath: '/tmp/voice/settings.json',
    workspacePath: '/tmp/voice-workspace',
    chatTitle: '语音助手',
  }));

  assert.equal(response.topic, 'control.initialization.started');
  assert.equal(response.payload.initializationSessionId, 'init-session-1');
  assert.deepEqual(cmb.calls.security[0], {
    sessionId: 'init-session-1',
    settings: { approvalPolicy: 'never', permissions: ':danger-full-access' },
  });
  assert.equal(cmb.calls.create[0].project, 'local|independent');
  assert.equal(cmb.calls.send[0].sessionId, 'init-session-1');
  assert.deepEqual(cmb.calls.send[0].value.skills, ['skill-voice-integration']);
  assert.match(cmb.calls.send[0].value.text, /workspacePath=\/tmp\/voice-workspace/);
  assert.match(cmb.calls.send[0].value.text, /保持 initialized=false/);
});

test('chat session create, bind, and chat use explicit public parameters', async (t) => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'control-ws-workspace-'));
  const previousConfig = process.env.BRIDGE_CONTROL_INTEGRATION_CONFIG;
  process.env.BRIDGE_CONTROL_INTEGRATION_CONFIG = path.join(workspacePath, 'settings.json');
  t.after(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    if (previousConfig === undefined) delete process.env.BRIDGE_CONTROL_INTEGRATION_CONFIG;
    else process.env.BRIDGE_CONTROL_INTEGRATION_CONFIG = previousConfig;
  });
  const cmb = fakeCmb();
  cmb.projects = async () => ({ projects: [{ key: 'local|voice', cwd: workspacePath }] });
  const service = new ControlWebSocketService({ cmb });
  const created = await service.handle(event('voice.chat_session.create.requested', {
    requestId: '123e4567-e89b-42d3-a456-426614174001',
    projectKey: 'local|voice',
    workspacePath,
    chatTitle: '语音助手',
  }));
  assert.equal(created.topic, 'control.chat_session.ready');
  assert.equal(created.payload.voiceSessionId, 'voice-session-1');
  assert.equal(cmb.calls.create[0].project, 'local|voice');
  assert.equal(cmb.calls.create[0].approvalPolicy, 'never');
  assert.equal(cmb.calls.create[0].permissions, ':danger-full-access');
  assert.deepEqual(cmb.calls.security[0].settings, {
    approvalPolicy: 'never',
    permissions: ':danger-full-access',
  });

  const bound = await service.handle(event('voice.chat_session.bind.requested', {
    voiceSessionId: 'voice-session-1',
  }, 'corr-2'));
  assert.equal(bound.topic, 'control.chat_session.bound');
  assert.equal(bound.payload.voiceSessionId, 'voice-session-1');

  const chat = await service.handle(event('voice.chat.user', {
    voiceSessionId: 'voice-session-1',
    text: '你好',
  }, 'corr-3'));
  assert.equal(chat.topic, 'control.chat.reply');
  assert.equal(chat.payload.text, '你好，我在。');
  assert.equal(cmb.calls.send.at(-1).value.text, '你好');
});
