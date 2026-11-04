import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadControlConfig } from '../src/config.mjs';
import { ControlService } from '../src/control-service.mjs';
import { PROFILE_VOICE_CONTROLLER } from '../src/profiles.mjs';
import { createVoiceBackend } from './fake-backend.mjs';

test('control config loader requires an absolute path and resolves event files', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'control-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    eventFiles: { taskEvents: 'task-events.jsonl' },
    workspace: { path: '/tmp/work', projectKey: 'project-1', voiceSessionId: 'session-1', initialized: true },
    plugins: { control: { installed: true }, characters: { installed: true, selectedId: 'elf-3' } },
  }));
  let appliedEventFiles = null;
  const service = new ControlService({
    backend: createVoiceBackend({
      configureEventFiles(eventFiles) {
        appliedEventFiles = eventFiles;
        return eventFiles;
      },
    }),
    profile: PROFILE_VOICE_CONTROLLER,
  });
  await assert.rejects(
    () => service.call('bridge_chat_control_config_load', { configPath: 'relative.json' }),
    /absolute file path/,
  );
  const value = await service.call('bridge_chat_control_config_load', { configPath: file });
  assert.equal(value.status, 'loaded');
  assert.equal(value.eventFiles.taskEvents, path.join(directory, 'task-events.jsonl'));
  assert.equal(service.integrationConfig.workspace.voiceSessionId, 'session-1');
  assert.deepEqual(appliedEventFiles, value.eventFiles);
  assert.deepEqual(value.appliedEventFiles, value.eventFiles);
  const workspace = await service.call('bridge_chat_control_workspace_ensure', {});
  assert.equal(workspace.status, 'exists');
});

test('control startup config can resolve event files from BRIDGE_CONTROL_INTEGRATION_CONFIG', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'control-startup-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    eventFiles: { taskEvents: 'tasks.jsonl' },
    workspace: { path: '', projectKey: '', voiceSessionId: '', initialized: false },
  }));

  const config = loadControlConfig({
    BRIDGE_CONTROL_CMB_BASE_URL: 'http://127.0.0.1:18787',
    BRIDGE_CONTROL_CMB_USERNAME: 'admin',
    BRIDGE_CONTROL_CMB_PASSWORD: 'test-password',
    BRIDGE_CONTROL_DATA_DIR: path.join(directory, 'data'),
    BRIDGE_CONTROL_INTEGRATION_CONFIG: file,
  });

  assert.equal(config.eventDir, null);
  assert.equal(config.taskEvents, path.join(directory, 'tasks.jsonl'));
});
