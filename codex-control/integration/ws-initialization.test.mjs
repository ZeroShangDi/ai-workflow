import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ControlWebSocketServer } from '../plugins/bridge-control/src/ws-server.mjs';
import { WsEventStore } from '../plugins/bridge-control/src/ws-event-store.mjs';
import { ControlWebSocketService } from '../plugins/bridge-control/src/ws-service.mjs';
import { ControlWebSocketClient } from '../plugins/voice-control/src/control-ws-client.mjs';
import { loadIntegrationConfig, updateIntegrationConfig } from '../plugins/voice-control/src/integration-config.mjs';
import { VoiceIntegrationCoordinator } from '../plugins/voice-control/src/integration-coordinator.mjs';

const TOKEN = 'integration-control-ws-token-0123456789';

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-control-ws-integration-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('Voice initializes through an independent Agent session, then creates and binds the fixed chat over WebSocket', async (t) => {
  const root = await temporaryDirectory(t);
  const configPath = path.join(root, 'settings.json');
  const previousIntegrationConfig = process.env.BRIDGE_CONTROL_INTEGRATION_CONFIG;
  process.env.BRIDGE_CONTROL_INTEGRATION_CONFIG = configPath;
  t.after(() => {
    if (previousIntegrationConfig === undefined) delete process.env.BRIDGE_CONTROL_INTEGRATION_CONFIG;
    else process.env.BRIDGE_CONTROL_INTEGRATION_CONFIG = previousIntegrationConfig;
  });
  await fs.writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    eventFiles: { taskEvents: 'task-events.jsonl' },
    workspace: {
      path: '/tmp/voice-workspace',
      projectKey: '',
      voiceSessionId: '',
      voiceSessionTitle: '语音助手',
      initialized: false,
    },
    plugins: {
      control: { installed: true, profile: 'voice-controller' },
      characters: { installed: true, skill: 'character-settings', selectedId: 'elf-3' },
    },
  }));

  const calls = { create: [], send: [], sessions: [] };
  let assistant = null;
  const fakeCmb = {
    async createSession(value) {
      calls.create.push(value);
      return { id: value.project === 'local|independent' ? 'init-session-1' : 'voice-session-1' };
    },
    async catalog(_sessionId, options = {}) {
      const skills = [
        { id: 'skill-voice-integration', name: 'voice-integration' },
        { id: 'skill-bridge-cli', name: 'bridge-control-cli' },
      ];
      return { skills: options.query ? skills.filter((skill) => skill.name.includes(options.query)) : skills };
    },
    async send(sessionId, value) {
      calls.send.push({ sessionId, value });
      if (sessionId === 'init-session-1') {
        updateIntegrationConfig(configPath, {
          workspace: { path: '/tmp/voice-workspace', projectKey: 'local|voice', initialized: false },
        });
      }
      if (sessionId === 'voice-session-1') {
        assistant = { id: 'assistant-1', text: '你好，我是固定语音会话。' };
      }
      return { status: 'accepted' };
    },
    async updateSecuritySettings(sessionId, settings) {
      calls.sessions.push({ securitySessionId: sessionId, settings });
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
  };
  const service = new ControlWebSocketService({ cmb: fakeCmb });
  const store = new WsEventStore(path.join(root, 'events.sqlite'));
  const server = new ControlWebSocketServer({
    port: 0,
    token: TOKEN,
    store,
    handler: (request) => service.handle(request.event),
  });
  const address = await server.start();
  t.after(async () => {
    await server.close();
    store.close();
  });

  const client = new ControlWebSocketClient({
    url: address.url,
    token: TOKEN,
    reconnectMinMs: 20,
    reconnectMaxMs: 50,
  });
  t.after(() => client.stop());
  client.start();
  const coordinator = new VoiceIntegrationCoordinator({
    configPath,
    controlBridge: client,
    initializationTimeoutMs: 2000,
    requestTimeoutMs: 2000,
  });

  const result = await coordinator.ensureReady();

  assert.equal(result.mode, 'managed');
  assert.equal(result.voiceSessionId, 'voice-session-1');
  assert.equal(calls.create[0].project, 'local|independent');
  assert.equal(calls.create[1].project, 'local|voice');
  assert.equal(calls.send[0].sessionId, 'init-session-1');
  const config = loadIntegrationConfig(configPath);
  assert.equal(config.workspace.projectKey, 'local|voice');
  assert.equal(config.workspace.voiceSessionId, 'voice-session-1');
  assert.equal(config.workspace.initialized, true);

  const reply = await client.request(
    'voice.chat.user',
    { voiceSessionId: 'voice-session-1', text: '你好' },
    {
      timeoutMs: 2000,
      responseTopics: ['control.chat.reply', 'control.chat.failed', 'control.error'],
    },
  );
  assert.equal(reply.topic, 'control.chat.reply', JSON.stringify(reply.payload));
  assert.equal(reply.payload.text, '你好，我是固定语音会话。');
});
