import assert from 'node:assert/strict';
import test from 'node:test';

import { ControlStore } from '../src/control-store.mjs';
import { temporaryDirectory } from './helpers.mjs';

test('control store retains bounded real transcripts and resolves only newer bound interactions', async (t) => {
  const directory = await temporaryDirectory(t);
  let sequence = 0;
  const store = new ControlStore({
    dataDir: directory,
    now: () => new Date(`2026-10-30T00:00:0${sequence}.000Z`),
    idFactory: (prefix) => `${prefix}-${++sequence}`,
  });

  const first = store.recordTranscript({
    sessionId: 'voice-1',
    text: '整理项目报告',
    turnId: 'turn-1',
  });
  assert.equal(first.transcript.turnId, 'turn-1');
  assert.equal(store.recordTranscript({
    sessionId: 'voice-1',
    text: '整理项目报告',
    turnId: 'turn-1',
  }).duplicate, true);

  const work = store.createWork({
    controlSessionId: 'voice-1',
    workSessionId: 'work-session-1',
    project: 'local|demo',
    title: '报告',
    request: '整理项目报告',
  });
  const interaction = store.createInteraction({
    sessionId: 'voice-1',
    workId: work.workId,
    kind: 'approval',
    operation: '删除旧报告',
    target: 'old.md',
    impact: '永久删除',
    reversibility: 'irreversible',
    speak: '是否确认删除 old.md？',
  });
  assert.equal(interaction.status, 'pending');
  assert.equal(store.pendingInteractions({ workId: work.workId }).length, 1);

  store.recordTranscript({
    sessionId: 'voice-1',
    text: '确认',
    turnId: 'turn-2',
  });
  const resolved = store.resolveInteraction(interaction.interactionId, {
    binding: interaction.binding,
    resolution: {
      type: 'approval',
      decision: 'approve',
      transcript: store.latestTranscript({ sessionId: 'voice-1' }),
    },
  });
  assert.equal(resolved.status, 'resolved');
  assert.equal(store.getWork(work.workId).status, 'running');
  assert.throws(
    () => store.resolveInteraction(interaction.interactionId, {
      binding: interaction.binding,
      resolution: { type: 'approval' },
    }),
    (error) => error.code === 'interaction_resolved',
  );

  const reloaded = new ControlStore({ dataDir: directory });
  assert.equal(reloaded.latestTranscript({ sessionId: 'voice-1' }).text, '确认');
  assert.equal(reloaded.getWork(work.workId).title, '报告');
});
