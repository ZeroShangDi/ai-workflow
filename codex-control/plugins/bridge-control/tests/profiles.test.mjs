import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ControlService } from '../src/control-service.mjs';
import {
  DEFAULT_PROFILE,
  HOST_TOOL_NAMES,
  PROFILE_VOICE_CONTROLLER,
  PROFILE_WORK_REPORTER,
  devMode,
  parseProfile,
  resolveRuntimeProfile,
  toolNamesForProfile,
} from '../src/plugin.mjs';
import { createVoiceBackend, createWorkBackend } from './fake-backend.mjs';

const VOICE_CONTROL_TOOLS = [
  'bridge_chat_control_config_load',
  'bridge_chat_control_workspace_ensure',
  'bridge_chat_create',
  'bridge_chat_confirm',
  'bridge_chat_find',
  'bridge_chat_status',
  'bridge_chat_send',
  'bridge_chat_read',
  'bridge_chat_events',
  'bridge_chat_pending',
  'bridge_chat_answer',
  'bridge_chat_approve',
  'bridge_chat_stop',
];

const WORK_REPORTING_TOOLS = [
  'bridge_chat_emit_progress',
  'bridge_chat_request_input',
  'bridge_chat_request_approval',
  'bridge_chat_publish_artifact',
  'bridge_chat_finish',
];

test('defaults to the least-privilege work reporter profile', () => {
  assert.equal(DEFAULT_PROFILE, PROFILE_WORK_REPORTER);
  assert.equal(parseProfile([], {}), PROFILE_WORK_REPORTER);
  assert.equal(parseProfile(['--profile', PROFILE_VOICE_CONTROLLER], {}), PROFILE_VOICE_CONTROLLER);
  assert.equal(parseProfile(['--profile=auto'], {}), 'auto');
  assert.throws(() => parseProfile(['--profile=unknown'], {}), /Unknown bridge-control profile/);
  assert.throws(() => parseProfile(['--profile'], {}), /requires a value/);
  assert.throws(
    () => parseProfile(['--profile', PROFILE_VOICE_CONTROLLER], { BRIDGE_CONTROL_PROFILE: PROFILE_WORK_REPORTER }),
    /conflicts/,
  );
});

test('auto profile selects voice-controller for the fixed thread and work-reporter for a bound work thread', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'control-profile-auto-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'control-state.json'), JSON.stringify({
    works: { work_1: { sessionId: 'work-thread-1' } },
  }));
  const env = {
    BRIDGE_CONTROL_DATA_DIR: directory,
    BRIDGE_CONTROL_AUTO_DEFAULT: PROFILE_VOICE_CONTROLLER,
  };
  assert.equal(resolveRuntimeProfile('auto', { ...env, CODEX_THREAD_ID: 'voice-thread-1' }), PROFILE_VOICE_CONTROLLER);
  assert.equal(resolveRuntimeProfile('auto', { ...env, CODEX_THREAD_ID: 'work-thread-1' }), PROFILE_WORK_REPORTER);
  assert.equal(resolveRuntimeProfile('auto', { BRIDGE_CONTROL_DATA_DIR: directory }), PROFILE_WORK_REPORTER);
});

test('profile tool surfaces are disjoint', () => {
  const voice = toolNamesForProfile(PROFILE_VOICE_CONTROLLER);
  const work = toolNamesForProfile(PROFILE_WORK_REPORTER);
  assert.deepEqual(voice, VOICE_CONTROL_TOOLS);
  assert.deepEqual(work, WORK_REPORTING_TOOLS);
  assert.deepEqual(voice.filter((name) => work.includes(name)), []);
  assert.deepEqual(HOST_TOOL_NAMES, ['bridge_chat_ack']);
  assert.equal(voice.includes('bridge_chat_ack'), false);
});

test('legacy bridge_chat requires both voice profile and explicit dev mode', () => {
  assert.equal(toolNamesForProfile(PROFILE_VOICE_CONTROLLER).includes('bridge_chat'), false);
  assert.equal(toolNamesForProfile(PROFILE_VOICE_CONTROLLER, { dev: true }).includes('bridge_chat'), true);
  assert.equal(toolNamesForProfile(PROFILE_WORK_REPORTER, { dev: true }).includes('bridge_chat'), false);
  assert.equal(devMode(['--dev'], {}), true);
  assert.equal(devMode([], { BRIDGE_CONTROL_DEV: '1' }), true);
});

test('runtime rejects calls outside the selected profile', async () => {
  const voice = new ControlService({
    backend: createVoiceBackend(),
    profile: PROFILE_VOICE_CONTROLLER,
  });
  const work = new ControlService({
    backend: createWorkBackend(),
    profile: PROFILE_WORK_REPORTER,
  });
  await assert.rejects(
    () => voice.call('bridge_chat_emit_progress', { sessionId: 's', text: 'x' }),
    /not available/,
  );
  await assert.rejects(
    () => work.call('bridge_chat_create', { sessionId: 's', draft: {} }),
    /not available/,
  );
  await assert.rejects(
    () => work.call('bridge_chat_pending', { sessionId: 's' }),
    /not available/,
  );
});
