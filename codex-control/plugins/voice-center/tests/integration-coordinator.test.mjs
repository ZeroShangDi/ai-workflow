import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { VoiceIntegrationCoordinator } from '../src/integration-coordinator.mjs';
import { loadIntegrationConfig, updateIntegrationConfig } from '../src/integration-config.mjs';

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-integration-coordinator-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    eventFiles: { taskEvents: 'task-events.jsonl' },
    workspace: {
      path: '/tmp/voice-workspace',
      projectKey: '',
      voiceSessionId: '',
      voiceSessionTitle: '语音助手',
      initialized: false,
    },
    plugins: { control: { installed: true }, characters: { installed: true } },
    ...overrides,
  }));
  return { root, file };
}

test('coordinator falls back to standalone without Control', async (t) => {
  const { file } = fixture(t);
  const coordinator = new VoiceIntegrationCoordinator({ configPath: file, controlBridge: null });
  const result = await coordinator.ensureReady();
  assert.equal(result.mode, 'standalone');
  assert.equal(result.reason, 'control_not_configured');
});

test('coordinator runs independent initialization, creates the fixed chat, persists it, and binds it', async (t) => {
  const { file } = fixture(t);
  const requests = [];
  const controlBridge = {
    statusValue: () => ({ connected: true }),
    waitUntilConnected: async () => ({ connected: true }),
    async request(topic, payload) {
      requests.push({ topic, payload });
      if (topic === 'voice.initialization.requested') {
        setTimeout(() => {
          updateIntegrationConfig(file, {
            workspace: {
              path: payload.workspacePath,
              projectKey: 'local|voice',
              initialized: false,
            },
          });
        }, 20);
        return {
          topic: 'control.initialization.started',
          payload: { initializationSessionId: 'init-session' },
        };
      }
      if (topic === 'voice.chat_session.create.requested') {
        return {
          topic: 'control.chat_session.ready',
          payload: {
            projectKey: 'local|voice',
            voiceSessionId: 'voice-session',
            workspacePath: '/tmp/voice-workspace',
          },
        };
      }
      if (topic === 'voice.chat_session.bind.requested') {
        return {
          topic: 'control.chat_session.bound',
          payload: { voiceSessionId: 'voice-session' },
        };
      }
      throw new Error(`unexpected request: ${topic}`);
    },
  };
  const coordinator = new VoiceIntegrationCoordinator({
    configPath: file,
    controlBridge,
    initializationTimeoutMs: 1000,
  });

  const result = await coordinator.ensureReady();

  assert.equal(result.mode, 'managed');
  assert.equal(result.voiceSessionId, 'voice-session');
  assert.deepEqual(requests.map((request) => request.topic), [
    'voice.initialization.requested',
    'voice.chat_session.create.requested',
    'voice.chat_session.bind.requested',
  ]);
  const config = loadIntegrationConfig(file);
  assert.equal(config.workspace.projectKey, 'local|voice');
  assert.equal(config.workspace.voiceSessionId, 'voice-session');
  assert.equal(config.workspace.initialized, true);
});

test('coordinator binds an already initialized fixed chat without creating another session', async (t) => {
  const { file } = fixture(t, {
    workspace: {
      path: '/tmp/voice-workspace',
      projectKey: 'local|voice',
      voiceSessionId: 'voice-session',
      voiceSessionTitle: '语音助手',
      initialized: true,
    },
  });
  const requests = [];
  const coordinator = new VoiceIntegrationCoordinator({
    configPath: file,
    controlBridge: {
      statusValue: () => ({ connected: true }),
      waitUntilConnected: async () => ({ connected: true }),
      async request(topic, payload) {
        requests.push({ topic, payload });
        return { topic: 'control.chat_session.bound', payload: { voiceSessionId: 'voice-session' } };
      },
    },
  });
  const result = await coordinator.ensureReady();
  assert.equal(result.mode, 'managed');
  assert.deepEqual(requests.map((request) => request.topic), ['voice.chat_session.bind.requested']);
});

test('coordinator reuses the same fixed-chat creation request id after a retryable failure', async (t) => {
  const { file } = fixture(t, {
    workspace: {
      path: '/tmp/voice-workspace',
      projectKey: 'local|voice',
      voiceSessionId: '',
      voiceSessionTitle: '语音助手',
      initialized: false,
    },
  });
  const chatRequestIds = [];
  let chatAttempts = 0;
  const coordinator = new VoiceIntegrationCoordinator({
    configPath: file,
    controlBridge: {
      statusValue: () => ({ connected: true }),
      waitUntilConnected: async () => ({ connected: true }),
      async request(topic, payload) {
        if (topic === 'voice.chat_session.create.requested') {
          chatRequestIds.push(payload.requestId);
          chatAttempts += 1;
          if (chatAttempts === 1) {
            return { topic: 'control.error', payload: { code: 'desktop_unavailable', message: 'retry' } };
          }
          return {
            topic: 'control.chat_session.ready',
            payload: { projectKey: 'local|voice', voiceSessionId: 'voice-session' },
          };
        }
        if (topic === 'voice.chat_session.bind.requested') {
          return { topic: 'control.chat_session.bound', payload: { voiceSessionId: 'voice-session' } };
        }
        throw new Error(`unexpected request: ${topic}`);
      },
    },
  });

  await assert.rejects(() => coordinator.ensureReady(), /retry/);
  const result = await coordinator.ensureReady();
  assert.equal(result.mode, 'managed');
  assert.equal(chatRequestIds.length, 2);
  assert.equal(chatRequestIds[0], chatRequestIds[1]);
});
