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

function appendTranscript(eventDir, value) {
  fs.mkdirSync(eventDir, { recursive: true });
  fs.appendFileSync(
    path.join(eventDir, 'voice-transcripts.jsonl'),
    `${JSON.stringify({ schemaVersion: 1, ...value })}\n`,
  );
}

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
  appendTranscript(eventDir, {
    sessionId: 'voice-session-1',
    turnId: 'turn-1',
    sequence: '1',
    text: '整理交付说明',
    createdAt: new Date().toISOString(),
  });
  const awaiting = await controller.call('bridge_chat_create', {
    sessionId: 'voice-session-1',
    draftId: missing.draftId,
    binding: missing.binding,
    draft: { request: '整理交付说明' },
  });
  assert.equal(awaiting.status, 'awaiting_confirmation');
  appendTranscript(eventDir, {
    sessionId: 'voice-session-1',
    turnId: 'turn-2',
    sequence: '2',
    text: '确认',
    createdAt: new Date().toISOString(),
  });

  const confirmed = await controller.call('bridge_chat_confirm', {
    sessionId: 'voice-session-1',
    draftId: missing.draftId,
    binding: missing.binding,
  });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.creation.status, 'accepted');
  assert.equal(cmb.state.createCount, 1);
  assert.equal(cmb.state.sendCount, 1);

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
