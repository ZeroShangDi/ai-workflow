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
const DEFAULT_INTERACTION_TTL_MS = 15 * 60 * 1000;
const INTERACTION_KINDS = new Set(['question', 'approval']);
const WORK_OUTCOMES = new Set(['completed', 'failed', 'interrupted', 'blocked']);

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
      { sessions: {}, works: {}, interactions: {} },
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
      transcripts: [],
    };
    const dedupe = optionalText(dedupeKey, 'dedupeKey', 512) || stableTurn;
    const duplicate = session.transcripts.find((item) => item.dedupeKey === dedupe);
    if (duplicate) return { transcript: cloneJson(duplicate), duplicate: true };

    const numericSequence = Number(sequence);
    const allocated = Number.isSafeInteger(numericSequence) && numericSequence > 0
      ? numericSequence
      : session.nextSequence;
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
    session.nextSequence = Math.max(session.nextSequence + 1, allocated + 1);
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
      createdAt: now,
      updatedAt: now,
    };
    data.works[workId] = record;
    this.store.write(data);
    return cloneJson(record);
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

  appendProgress(workId, { text, percent = null }) {
    const data = this.store.read();
    const record = data.works[requireText(workId, 'workId', 256)];
    if (!record) throw new HubError(404, 'work_not_found', 'work does not exist');
    const progress = {
      text: requireText(text, 'text', 4000),
      percent: percent === null || percent === undefined ? null : Number(percent),
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
    const value = assertObject(artifact, 'artifact');
    const normalized = {
      artifactId: requireText(value.artifactId, 'artifact.artifactId', 256),
      kind: requireText(value.kind, 'artifact.kind', 128),
      uri: requireText(value.uri, 'artifact.uri', 4096),
      title: optionalText(value.title, 'artifact.title', 500),
      publishedAt: this.now().toISOString(),
    };
    record.artifacts = [...record.artifacts, normalized].slice(-MAX_ARTIFACTS);
    record.updatedAt = normalized.publishedAt;
    this.store.write(data);
    return cloneJson(normalized);
  }

  finishWork(workId, { outcome, summary }) {
    const result = requireText(outcome, 'outcome', 32);
    if (!WORK_OUTCOMES.has(result)) {
      throw new HubError(400, 'invalid_request', 'outcome is invalid');
    }
    return this.updateWork(workId, {
      status: result === 'blocked' ? 'waiting_input' : result,
      outcome: result,
      summary: requireText(summary, 'summary', 12000),
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
    if (work.controlSessionId !== requireText(sessionId, 'sessionId', 256)) {
      throw new HubError(403, 'session_work_mismatch', 'session is not bound to this work');
    }
    const latest = (data.sessions[work.controlSessionId]?.transcripts || []).at(-1);
    const interactionId = this.idFactory('int');
    const now = this.now();
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
      expiresAt: expiresAt || new Date(now.getTime() + DEFAULT_INTERACTION_TTL_MS).toISOString(),
      resolvedAt: null,
      resolution: null,
    };
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
    return Object.values(this.store.read().interactions)
      .filter((item) => item.status === 'pending')
      .filter((item) => !sessionId || item.sessionId === sessionId)
      .filter((item) => !workId || item.workId === workId)
      .map(cloneJson);
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
    work.status = 'running';
    work.updatedAt = now;
    this.store.write(data);
    return cloneJson(record);
  }
}
