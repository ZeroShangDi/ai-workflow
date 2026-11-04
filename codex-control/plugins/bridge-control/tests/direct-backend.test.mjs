import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createDirectBackend } from '../src/direct-backend.mjs';
import { ControlService } from '../src/control-service.mjs';
import {
  PROFILE_VOICE_CONTROLLER,
  PROFILE_WORK_REPORTER,
} from '../src/profiles.mjs';
import { startMockCmb, temporaryDirectory } from './fake-cmb.mjs';

test('control plugin creates and reports CMB work without bridge-hub', async (t) => {
  const cmb = await startMockCmb();
  t.after(cmb.close);
  const dataDir = await temporaryDirectory(t);
  const eventDir = await temporaryDirectory(t);
  const backend = createDirectBackend({
    cmb: {
      baseUrl: cmb.baseUrl,
      username: 'admin',
      password: 'test-password',
      timeoutMs: 2000,
    },
    dataDir,
    eventDir,
  });
  t.after(() => backend.close());

  const controller = new ControlService({ backend, profile: PROFILE_VOICE_CONTROLLER });
  const missing = await controller.call('bridge_chat_create', {
    sessionId: 'voice-session-1',
    draft: { project: 'demo' },
  });
  assert.equal(missing.status, 'needs_input');
  cmb.setUserTranscript('整理交付说明');
  const awaiting = await controller.call('bridge_chat_create', {
    sessionId: 'voice-session-1',
    draftId: missing.draftId,
    binding: missing.binding,
    draft: { request: '整理交付说明' },
  });
  assert.equal(awaiting.status, 'awaiting_confirmation');
  cmb.setUserTranscript('确认');

  const confirmed = await controller.call('bridge_chat_confirm', {
    sessionId: 'voice-session-1',
    draftId: missing.draftId,
    binding: missing.binding,
  });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.creation.status, 'accepted');
  assert.equal(cmb.state.createCount, 1);
  assert.equal(cmb.state.sendCount, 1);
  assert.deepEqual(cmb.state.sendCalls[0].skills, ['skill-work-reporter']);
  assert.match(cmb.state.createCalls[0].developerInstructions, /--profile work-reporter/);
  assert.match(cmb.state.createCalls[0].developerInstructions, /Do not create or control other tasks/);

  const reporter = new ControlService({
    backend,
    profile: PROFILE_WORK_REPORTER,
  });
  const progress = await reporter.call('bridge_chat_emit_progress', {
    sessionId: confirmed.creation.sessionId,
    text: '正在整理章节',
    percent: 40,
  });
  assert.equal(progress.status, 'accepted');
  const finished = await reporter.call('bridge_chat_finish', {
    sessionId: confirmed.creation.sessionId,
    outcome: 'completed',
    summary: '交付说明已经完成',
  });
  assert.equal(finished.status, 'accepted');

  const events = JSON.parse(`[${fs.readFileSync(path.join(eventDir, 'task-events.jsonl'), 'utf8')
    .trim().split(/\n/).join(',')}]`);
  assert.deepEqual(events.map((event) => event.topic), [
    'task.created',
    'task.progress',
    'task.completed',
  ]);
  assert.equal(events.every((event) => event.sessionId === 'voice-session-1'), true);
});

test('workspace ensure reuses a matching project and initializes a missing configured path', async (t) => {
  const cmb = await startMockCmb();
  t.after(cmb.close);
  const dataDir = await temporaryDirectory(t);
  const workspacePath = await temporaryDirectory(t);
  const backend = createDirectBackend({
    cmb: {
      baseUrl: cmb.baseUrl,
      username: 'admin',
      password: 'test-password',
      timeoutMs: 2000,
    },
    dataDir,
  });
  t.after(() => backend.close());

  const existing = await backend.ensureWorkspace({
    workspace: { path: '/tmp/demo', projectKey: '' },
  });
  assert.equal(existing.status, 'exists');
  assert.equal(existing.workspace.projectKey, 'local|demo');

  const missing = await backend.ensureWorkspace({
    workspace: { path: workspacePath, projectKey: '' },
  });
  assert.equal(missing.status, 'missing');
  assert.equal(missing.requiresInitialization, true);
  assert.equal(cmb.state.projectRegisterCount, 0);

  const initialized = await backend.ensureWorkspace({
    workspace: { path: workspacePath, projectKey: '' },
    createDirectory: true,
  });
  assert.equal(initialized.status, 'initialized');
  assert.equal(initialized.workspace.projectKey, 'local|voice-workspace');
  assert.equal(cmb.state.projectRegisterCount, 1);
  assert.equal(cmb.state.projectRegisterCalls[0].path, workspacePath);
});
