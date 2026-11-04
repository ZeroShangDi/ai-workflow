import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  loadIntegrationConfig,
  loadVoiceIntegrationConfig,
  updateIntegrationConfig,
} from '../src/integration-config.mjs';
import { LocalVoiceEvents } from '../src/local-events.mjs';

test('loads absolute integration config and resolves event files', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-integration-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    eventFiles: { taskEvents: 'task-events.jsonl' },
    workspace: { path: '/tmp/voice-work', projectKey: 'project-1', voiceSessionId: 'session-1', initialized: true },
    plugins: { control: { installed: true }, characters: { installed: true, selectedId: 'elf-3' } },
  }));
  assert.throws(() => loadIntegrationConfig('relative.json'), /absolute file path/);
  const value = loadIntegrationConfig(file);
  assert.equal(value.eventFiles.taskEvents, path.join(directory, 'task-events.jsonl'));
  assert.equal(value.workspace.voiceSessionId, 'session-1');
  assert.equal(value.plugins.characters.selectedId, 'elf-3');
  assert.equal(loadVoiceIntegrationConfig({ VOICE_CONTROL_INTEGRATION_CONFIG: file }).configPath, file);
});

test('voice config update atomically persists reviewed workspace fields', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-integration-update-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    eventFiles: { taskEvents: 'task-events.jsonl' },
    workspace: { path: '', projectKey: '', voiceSessionId: '', initialized: false },
    plugins: { control: { installed: true }, characters: { installed: true } },
  }));

  const result = updateIntegrationConfig(file, {
    workspace: {
      path: '/tmp/voice-workspace',
      projectKey: 'local|voice-workspace',
      voiceSessionId: 'session-1',
      initialized: true,
    },
  });

  assert.equal(result.current.workspace.path, '/tmp/voice-workspace');
  assert.equal(result.current.workspace.voiceSessionId, 'session-1');
  assert.deepEqual(result.current.plugins.control, {
    installed: true,
    profile: 'voice-controller',
    websocketUrl: '',
    tokenFile: '',
    requestTimeoutMs: 30000,
  });
  assert.throws(
    () => updateIntegrationConfig(file, { workspace: { path: 'relative' } }),
    /absolute path/,
  );
});

test('voice event ledger can use the task file from integration config', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-integration-ledger-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const taskFile = path.join(directory, 'events', 'tasks.jsonl');
  fs.mkdirSync(path.dirname(taskFile), { recursive: true });
  fs.writeFileSync(taskFile, `${JSON.stringify({ eventId: 'evt-1', text: '任务进度' })}\n`);
  const events = new LocalVoiceEvents({ taskFile });

  assert.deepEqual(events.readTaskEvents(), [{ eventId: 'evt-1', text: '任务进度' }]);
  assert.equal(fs.existsSync(taskFile), true);
});
