import crypto from 'node:crypto';
import path from 'node:path';

import { HubError } from './errors.mjs';
import { AtomicJsonStore } from './storage.mjs';
import {
  assertObject,
  cloneJson,
  isoNow,
  optionalText,
  requireText,
} from './util.mjs';

const MAX_TRANSCRIPTS_PER_SESSION = 200;
const MAX_PROGRESS_EVENTS = 500;
const MAX_ARTIFACTS = 100;
const MAX_CONFIRMATIONS = 1000;
const DEFAULT_INTERACTION_TTL_MS = 15 * 60 * 1000;
const INTERACTION_KINDS = new Set(['question', 'approval']);
const WORK_OUTCOMES = new Set(['completed', 'failed', 'interrupted', 'blocked']);
const TERMINAL_WORK_STATUSES = new Set(['completed', 'failed', 'interrupted', 'blocked', 'stopped']);
const REVERSIBILITY = new Set(['reversible', 'irreversible', 'unknown']);

function freshId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function transcriptTurn(turnId, sequence) {
  const stableTurn = optionalText(turnId, 'turnId', 256);
  const stableSequence = optionalText(sequence, 'sequence', 128);
  const value = stableTurn || stableSequence;
  if (!value) {
    throw new HubError(400, 'invalid_request', 'turnId or sequence is required');
  }
  return value;
}

function normalizeQuestions(questions) {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 20) {
    throw new HubError(400, 'invalid_request', 'questions must contain 1-20 entries');
  }
  return questions.map((value, index) => {
    const question = assertObject(value, `questions[${index}]`);
    const questionId = requireText(question.questionId, `questions[${index}].questionId`, 128);
    const prompt = requireText(question.prompt, `questions[${index}].prompt`, 4000);
    const kind = optionalText(question.kind, `questions[${index}].kind`, 32) || 'text';
    if (!['text', 'choice', 'confirmation'].includes(kind)) {
      throw new HubError(400, 'invalid_request', `questions[${index}].kind is invalid`);
    }
    if (question.choices !== undefined && !Array.isArray(question.choices)) {
      throw new HubError(400, 'invalid_request', `questions[${index}].choices must be an array`);
    }
    const choices = (question.choices || []).map((choice, choiceIndex) => (
      requireText(choice, `questions[${index}].choices[${choiceIndex}]`, 500)
    ));
    return { questionId, prompt, kind, choices };
  });
}

function normalizeArtifact(artifact) {
  const value = assertObject(artifact, 'artifact');
  return {
    artifactId: requireText(value.artifactId, 'artifact.artifactId', 256),
    kind: requireText(value.kind, 'artifact.kind', 128),
    uri: requireText(value.uri, 'artifact.uri', 4096),
    title: optionalText(value.title, 'artifact.title', 500),
  };
}

function assertMutableWork(work) {
  if (TERMINAL_WORK_STATUSES.has(work.status)) {
    throw new HubError(409, 'work_terminal', `work is already ${work.status}`);
  }
}

function interactionExpiry(value, now) {
  if (value === undefined || value === null || value === '') {
    return new Date(now.getTime() + DEFAULT_INTERACTION_TTL_MS).toISOString();
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new HubError(400, 'invalid_request', 'expiresAt must be a valid date-time');
  }
  if (timestamp <= now.getTime()) {
    throw new HubError(400, 'invalid_request', 'expiresAt must be in the future');
  }
  return new Date(timestamp).toISOString();
}

export class ControlStore {
  constructor({
    dataDir = null,
    now = () => new Date(),
    idFactory = freshId,
  } = {}) {
    this.now = now;
    this.idFactory = idFactory;
    this.store = new AtomicJsonStore(
      dataDir ? path.join(dataDir, 'control.json') : null,
      { sessions: {}, works: {}, interactions: {}, confirmations: {} },
    );
  }

  recordTranscript({ sessionId, text, turnId = null, sequence = null, dedupeKey = null }) {
    const id = requireText(sessionId, 'sessionId', 256);
    const content = requireText(text, 'text', 6000);
    const stableTurn = transcriptTurn(turnId, sequence);
    const data = this.store.read();
    const session = data.sessions[id] || {
      sessionId: id,
      nextSequence: 1,
      lastSequence: 0,
      transcripts: [],
    };
    const dedupe = optionalText(dedupeKey, 'dedupeKey', 512) || stableTurn;
    const duplicate = session.transcripts.find((item) => (
      item.dedupeKey === dedupe || item.turnId === stableTurn
    ));
    if (duplicate) {
      if (
        duplicate.text !== content
        || duplicate.turnId !== stableTurn
        || duplicate.dedupeKey !== dedupe
      ) {
        throw new HubError(
          409,
          'dedupe_conflict',
          'transcript identity was already used with different content',
        );
      }
      return { transcript: cloneJson(duplicate), duplicate: true };
    }

    const hasExplicitSequence = sequence !== undefined && sequence !== null && sequence !== '';
    const numericSequence = hasExplicitSequence ? Number(sequence) : null;
    if (hasExplicitSequence && (
      !Number.isSafeInteger(numericSequence)
      || numericSequence < 1
    )) {
      throw new HubError(400, 'invalid_request', 'sequence must be a positive safe integer');
    }
    const previousSequence = Math.max(
      Number(session.lastSequence) || 0,
      Number(session.transcripts.at(-1)?.sequence) || 0,
    );
    if (hasExplicitSequence && numericSequence <= previousSequence) {
      throw new HubError(
        409,
        'transcript_out_of_order',
        'sequence must be newer than the latest stored transcript',
      );
    }
    const allocated = hasExplicitSequence ? numericSequence : previousSequence + 1;
    const record = {
      sessionId: id,
      turnId: stableTurn,
      sequence: String(allocated),
      text: content,
      dedupeKey: dedupe,
      createdAt: this.now().toISOString(),
    };
    session.transcripts.push(record);
    session.transcripts = session.transcripts.slice(-MAX_TRANSCRIPTS_PER_SESSION);
    session.lastSequence = allocated;
    session.nextSequence = allocated + 1;
    data.sessions[id] = session;
    this.store.write(data);
    return { transcript: cloneJson(record), duplicate: false };
  }

  latestTranscript({ sessionId }) {
    const id = requireText(sessionId, 'sessionId', 256);
    const transcripts = this.store.read().sessions[id]?.transcripts || [];
    return transcripts.length ? cloneJson(transcripts.at(-1)) : null;
  }

  createWork({
    controlSessionId,
    workSessionId,
    project,
    title,
    request,
  }) {
    const data = this.store.read();
    const workId = this.idFactory('work');
    const now = this.now().toISOString();
    const record = {
      workId,
      controlSessionId: requireText(controlSessionId, 'controlSessionId', 256),
      workSessionId: requireText(workSessionId, 'workSessionId', 256),
      project: requireText(project, 'project', 4096),
      title: requireText(title, 'title', 120),
      request: requireText(request, 'request', 100000),
      status: 'accepted',
      progress: [],
      artifacts: [],
      outcome: null,
      summary: null,
      resultRef: null,
      artifactIds: [],
      createdAt: now,
      updatedAt: now,
    };
    data.works[workId] = record;
    this.store.write(data);
    return cloneJson(record);
  }

  reserveConfirmation({
    sessionId,
    draftId,
    binding,
    transcript,
    workSessionId,
  }) {
    const id = requireText(sessionId, 'sessionId', 256);
    const draft = requireText(draftId, 'draftId', 256);
    const draftBinding = requireText(binding, 'binding', 256);
    const turnId = transcriptTurn(transcript?.turnId, transcript?.sequence);
    const data = this.store.read();
    data.confirmations ||= {};
    const confirmationId = crypto.createHash('sha256')
      .update(`${id}\0${turnId}`)
      .digest('hex');
    const existing = data.confirmations[confirmationId];
    if (existing) {
      throw new HubError(
        409,
        'confirmation_already_used',
        'this user confirmation was already reserved for a create request',
      );
    }
    const record = {
      confirmationId,
      sessionId: id,
      draftId: draft,
      binding: draftBinding,
      turnId,
      workSessionId: workSessionId || null,
      status: 'pending',
      createdAt: this.now().toISOString(),
      consumedAt: null,
    };
    data.confirmations[confirmationId] = record;
    const retained = Object.values(data.confirmations)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, MAX_CONFIRMATIONS);
    data.confirmations = Object.fromEntries(
      retained.map((item) => [item.confirmationId, item]),
    );
    this.store.write(data);
    return cloneJson(record);
  }

  commitConfirmation(confirmationId, { workId }) {
    const data = this.store.read();
    const record = data.confirmations?.[requireText(
      confirmationId,
      'confirmationId',
      128,
    )];
    if (!record || record.status !== 'pending') {
      throw new HubError(409, 'confirmation_not_pending', 'confirmation reservation is not pending');
    }
    record.status = 'consumed';
    record.workId = requireText(workId, 'workId', 256);
    record.consumedAt = this.now().toISOString();
    this.store.write(data);
    return cloneJson(record);
  }

  releaseConfirmation(confirmationId) {
    const data = this.store.read();
    const id = requireText(confirmationId, 'confirmationId', 128);
    if (data.confirmations?.[id]?.status === 'pending') {
      delete data.confirmations[id];
      this.store.write(data);
    }
  }

  getWork(workId) {
    const id = optionalText(workId, 'workId', 256);
    return id ? cloneJson(this.store.read().works[id] || null) : null;
  }

  workBySession(sessionId) {
    const id = optionalText(sessionId, 'sessionId', 256);
    if (!id) return null;
    const works = Object.values(this.store.read().works).reverse();
    return cloneJson(
      works.find((work) => work.workSessionId === id)
      || works.find((work) => work.controlSessionId === id)
      || null,
    );
  }

  findWork({ query = '', limit = 20 } = {}) {
    const text = String(query || '').trim().toLocaleLowerCase();
    const works = Object.values(this.store.read().works)
      .filter((work) => !text || [work.workId, work.title, work.project, work.request]
        .some((value) => String(value).toLocaleLowerCase().includes(text)))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
      .map((work) => ({
        workId: work.workId,
        sessionId: work.workSessionId,
        title: work.title,
        project: work.project,
        status: work.status,
        updatedAt: work.updatedAt,
      }));
    return cloneJson(works);
  }

  updateWork(workId, changes) {
    const data = this.store.read();
    const record = data.works[requireText(workId, 'workId', 256)];
    if (!record) throw new HubError(404, 'work_not_found', 'work does not exist');
    Object.assign(record, changes);
    record.updatedAt = this.now().toISOString();
    this.store.write(data);
    return cloneJson(record);
  }

  appendProgress(workId, { text, percent = null, artifact = null }) {
    const data = this.store.read();
    const record = data.works[requireText(workId, 'workId', 256)];
    if (!record) throw new HubError(404, 'work_not_found', 'work does not exist');
    assertMutableWork(record);
    const progress = {
      text: requireText(text, 'text', 4000),
      percent: percent === null || percent === undefined ? null : Number(percent),
      artifact: artifact === null || artifact === undefined ? null : normalizeArtifact(artifact),
      at: this.now().toISOString(),
    };
    if (progress.percent !== null && (
      !Number.isFinite(progress.percent)
      || progress.percent < 0
      || progress.percent > 100
    )) {
      throw new HubError(400, 'invalid_request', 'percent must be between 0 and 100');
    }
    record.progress = [...record.progress, progress].slice(-MAX_PROGRESS_EVENTS);
    record.status = 'running';
    record.updatedAt = progress.at;
    this.store.write(data);
    return cloneJson(progress);
  }

  publishArtifact(workId, artifact) {
    const data = this.store.read();
    const record = data.works[requireText(workId, 'workId', 256)];
    if (!record) throw new HubError(404, 'work_not_found', 'work does not exist');
    assertMutableWork(record);
    const value = normalizeArtifact(artifact);
    const duplicate = record.artifacts.find((item) => item.artifactId === value.artifactId);
    if (duplicate) {
      if (
        duplicate.kind !== value.kind
        || duplicate.uri !== value.uri
        || duplicate.title !== value.title
      ) {
        throw new HubError(
          409,
          'artifact_conflict',
          'artifactId was already published with different content',
        );
      }
      return { ...cloneJson(duplicate), duplicate: true };
    }
    const normalized = {
      ...value,
      publishedAt: this.now().toISOString(),
    };
    record.artifacts = [...record.artifacts, normalized].slice(-MAX_ARTIFACTS);
    record.updatedAt = normalized.publishedAt;
    this.store.write(data);
    return cloneJson(normalized);
  }

  finishWork(workId, {
    outcome,
    summary,
    resultRef = null,
    artifactIds = [],
  }) {
    const result = requireText(outcome, 'outcome', 32);
    if (!WORK_OUTCOMES.has(result)) {
      throw new HubError(400, 'invalid_request', 'outcome is invalid');
    }
    const data = this.store.read();
    const existing = data.works[requireText(workId, 'workId', 256)];
    if (!existing) throw new HubError(404, 'work_not_found', 'work does not exist');
    assertMutableWork(existing);
    const now = this.now().getTime();
    const pending = Object.values(data.interactions).find((item) => (
      item.workId === existing.workId
      && item.status === 'pending'
      && (!item.expiresAt || Date.parse(item.expiresAt) > now)
    ));
    if (pending) {
      throw new HubError(
        409,
        'interaction_pending',
        'work cannot finish while an interaction is awaiting a response',
      );
    }
    if (!Array.isArray(artifactIds) || artifactIds.length > 100) {
      throw new HubError(400, 'invalid_request', 'artifactIds must contain at most 100 entries');
    }
    const normalizedArtifactIds = [...new Set(
      artifactIds.map((value) => requireText(value, 'artifactIds', 256)),
    )];
    const knownArtifactIds = new Set([
      ...existing.artifacts.map((item) => item.artifactId),
      ...existing.progress.map((item) => item.artifact?.artifactId).filter(Boolean),
    ]);
    const unknownArtifact = normalizedArtifactIds.find((id) => !knownArtifactIds.has(id));
    if (unknownArtifact) {
      throw new HubError(
        400,
        'artifact_not_found',
        `artifactIds contains an unknown artifact: ${unknownArtifact}`,
      );
    }
    return this.updateWork(workId, {
      status: result,
      outcome: result,
      summary: requireText(summary, 'summary', 12000),
      resultRef: optionalText(resultRef, 'resultRef', 4096),
      artifactIds: normalizedArtifactIds,
    });
  }

  createInteraction({
    sessionId,
    workId,
    kind,
    questions = null,
    operation = null,
    target = null,
    impact = null,
    reversibility = null,
    speak = null,
    expiresAt = null,
  }) {
    const interactionKind = requireText(kind, 'kind', 32);
    if (!INTERACTION_KINDS.has(interactionKind)) {
      throw new HubError(400, 'invalid_request', 'interaction kind is invalid');
    }
    const data = this.store.read();
    const work = data.works[requireText(workId, 'workId', 256)];
    if (!work) throw new HubError(404, 'work_not_found', 'work does not exist');
    assertMutableWork(work);
    if (work.controlSessionId !== requireText(sessionId, 'sessionId', 256)) {
      throw new HubError(403, 'session_work_mismatch', 'session is not bound to this work');
    }
    const now = this.now();
    const existingPending = Object.values(data.interactions).find((item) => (
      item.workId === work.workId
      && item.status === 'pending'
      && (!item.expiresAt || Date.parse(item.expiresAt) > now.getTime())
    ));
    if (existingPending) {
      throw new HubError(409, 'interaction_pending', 'work already has a pending interaction');
    }
    const latest = (data.sessions[work.controlSessionId]?.transcripts || []).at(-1);
    const interactionId = this.idFactory('int');
    const record = {
      interactionId,
      binding: this.idFactory('bind'),
      sessionId: work.controlSessionId,
      workId: work.workId,
      kind: interactionKind,
      status: 'pending',
      baselineSequence: latest?.sequence || null,
      questions: interactionKind === 'question' ? normalizeQuestions(questions) : null,
      operation: interactionKind === 'approval'
        ? requireText(operation, 'operation', 500)
        : null,
      target: interactionKind === 'approval'
        ? requireText(target, 'target', 1000)
        : null,
      impact: interactionKind === 'approval'
        ? requireText(impact, 'impact', 2000)
        : null,
      reversibility: interactionKind === 'approval'
        ? requireText(reversibility, 'reversibility', 32)
        : null,
      speak: optionalText(speak, 'speak', 2000),
      createdAt: now.toISOString(),
      expiresAt: interactionExpiry(expiresAt, now),
      resolvedAt: null,
      resolution: null,
    };
    if (record.reversibility && !REVERSIBILITY.has(record.reversibility)) {
      throw new HubError(400, 'invalid_request', 'reversibility is invalid');
    }
    data.interactions[interactionId] = record;
    work.status = interactionKind === 'approval' ? 'waiting_approval' : 'waiting_input';
    work.updatedAt = now.toISOString();
    this.store.write(data);
    return cloneJson(record);
  }

  getInteraction(interactionId) {
    const id = optionalText(interactionId, 'interactionId', 256);
    return id ? cloneJson(this.store.read().interactions[id] || null) : null;
  }

  pendingInteractions({ sessionId = null, workId = null } = {}) {
    const now = this.now().getTime();
    return Object.values(this.store.read().interactions)
      .filter((item) => item.status === 'pending')
      .filter((item) => !item.expiresAt || Date.parse(item.expiresAt) > now)
      .filter((item) => !sessionId || item.sessionId === sessionId)
      .filter((item) => !workId || item.workId === workId)
      .map(cloneJson);
  }

  expirePendingInteractions(workId) {
    const id = requireText(workId, 'workId', 256);
    const data = this.store.read();
    let changed = false;
    for (const interaction of Object.values(data.interactions)) {
      if (interaction.workId !== id || interaction.status !== 'pending') continue;
      interaction.status = 'expired';
      interaction.resolvedAt = this.now().toISOString();
      interaction.resolution = { type: 'work_stopped' };
      changed = true;
    }
    if (changed) this.store.write(data);
    return changed;
  }

  resolveInteraction(interactionId, {
    binding,
    resolution,
  }) {
    const data = this.store.read();
    const record = data.interactions[requireText(interactionId, 'interactionId', 256)];
    if (!record) throw new HubError(404, 'interaction_not_found', 'interaction does not exist');
    if (record.binding !== requireText(binding, 'binding', 256)) {
      throw new HubError(409, 'stale_interaction', 'interaction binding is stale or unknown');
    }
    if (record.status !== 'pending') {
      throw new HubError(409, 'interaction_resolved', 'interaction is no longer pending');
    }
    if (record.expiresAt && Date.parse(record.expiresAt) <= this.now().getTime()) {
      record.status = 'expired';
      this.store.write(data);
      throw new HubError(409, 'interaction_expired', 'interaction has expired');
    }
    const now = this.now().toISOString();
    record.status = 'resolved';
    record.resolvedAt = now;
    record.resolution = cloneJson(assertObject(resolution, 'resolution'));
    const work = data.works[record.workId];
    if (!work) throw new HubError(404, 'work_not_found', 'work does not exist');
    assertMutableWork(work);
    work.status = 'running';
    work.updatedAt = now;
    this.store.write(data);
    return cloneJson(record);
  }
}
