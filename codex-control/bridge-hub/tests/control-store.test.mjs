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
  assert.throws(
    () => store.finishWork(work.workId, {
      outcome: 'completed',
      summary: '不应在待审批时完成',
    }),
    (error) => error.code === 'interaction_pending',
  );

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

test('transcript identities are immutable and stale sequence numbers cannot become latest', () => {
  const store = new ControlStore();
  store.recordTranscript({
    sessionId: 'voice-1',
    turnId: 'turn-2',
    sequence: '2',
    text: '第二条',
  });
  assert.throws(
    () => store.recordTranscript({
      sessionId: 'voice-1',
      turnId: 'turn-2',
      sequence: '2',
      text: '被替换的内容',
    }),
    (error) => error.code === 'dedupe_conflict',
  );
  assert.throws(
    () => store.recordTranscript({
      sessionId: 'voice-1',
      turnId: 'turn-1',
      sequence: '1',
      text: '迟到的第一条',
    }),
    (error) => error.code === 'transcript_out_of_order',
  );
  assert.equal(store.latestTranscript({ sessionId: 'voice-1' }).text, '第二条');
});

test('terminal work rejects further reporting and interaction deadlines must be valid', () => {
  const store = new ControlStore({
    now: () => new Date('2026-10-30T00:00:00.000Z'),
  });
  store.recordTranscript({
    sessionId: 'voice-1',
    turnId: 'turn-1',
    text: '开始',
  });
  const work = store.createWork({
    controlSessionId: 'voice-1',
    workSessionId: 'work-session-1',
    project: 'local|demo',
    title: '测试',
    request: '测试',
  });
  assert.throws(
    () => store.createInteraction({
      sessionId: 'voice-1',
      workId: work.workId,
      kind: 'approval',
      operation: 'delete',
      target: 'old.log',
      impact: 'delete permanently',
      reversibility: 'irreversible',
      speak: '是否确认？',
      expiresAt: '2020-01-01T00:00:00.000Z',
    }),
    /expiresAt must be in the future/,
  );
  store.publishArtifact(work.workId, {
    artifactId: 'artifact-1',
    kind: 'document',
    uri: 'file:///tmp/result.md',
  });
  store.finishWork(work.workId, {
    outcome: 'completed',
    summary: '完成',
    resultRef: 'result-1',
    artifactIds: ['artifact-1'],
  });
  assert.equal(store.getWork(work.workId).status, 'completed');
  assert.equal(store.getWork(work.workId).resultRef, 'result-1');
  assert.throws(
    () => store.appendProgress(work.workId, { text: '完成后迟到进度' }),
    (error) => error.code === 'work_terminal',
  );
});
