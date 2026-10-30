import crypto from 'node:crypto';
import path from 'node:path';

import { CmbAdapter } from './cmb-client.mjs';
import { BridgeError } from './errors.mjs';
import { ControlEventBus } from './event-bus.mjs';
import { AtomicJsonStore } from './storage.mjs';
import {
  assertObject,
  canonicalJson,
  cloneJson,
  isoNow,
  requireText,
} from './util.mjs';

const AFFIRMATIVE = /^(确认|确认创建|是的|是|好|可以|同意|对|批准|yes|y|ok|okay|confirm|approve)[。.!！]?$/i;
const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'blocked', 'stopped']);
const DEFAULT_TTL_MS = 15 * 60 * 1000;

function affirmative(value) {
  return AFFIRMATIVE.test(String(value || '').trim());
}

function interactionBinding() {
  return `bind_${crypto.randomUUID()}`;
}

function displayText(value) {
  if (typeof value === 'string') return value;
  if (typeof value?.text === 'string') return value.text;
  if (typeof value?.content === 'string') return value.content;
  return '';
}

export class DirectControlBackend {
  constructor({
    cmb,
    dataDir,
    eventDir,
    now = () => new Date(),
    monitorIntervalMs = 2500,
  }) {
    this.cmb = cmb;
    this.now = now;
    this.monitorIntervalMs = monitorIntervalMs;
    this.bus = new ControlEventBus({ eventDir, now });
    this.store = new AtomicJsonStore(
      path.join(path.resolve(dataDir), 'control-state.json'),
      { schemaVersion: 1, works: {}, interactions: {}, idempotency: {} },
    );
    this.monitors = new Map();
  }

  latestUserTranscript({ sessionId }) {
    const transcript = this.bus.latestTranscript(requireText(sessionId, 'sessionId', 256));
    if (!transcript) {
      throw new BridgeError(404, 'transcript_not_found', 'no voice transcript exists for this session');
    }
    return transcript;
  }

  getPending({ sessionId, interactionId }) {
    const interaction = this.store.read().interactions[interactionId];
    if (!interaction || interaction.status !== 'pending') return null;
    if (sessionId && interaction.sessionId !== sessionId) {
      throw new BridgeError(403, 'session_interaction_mismatch', 'interaction belongs to another session');
    }
    return cloneJson(interaction);
  }

  async createWork({ sessionId, draftId, binding, draft, transcript, idempotencyKey }) {
    const controlSessionId = requireText(sessionId, 'sessionId', 256);
    const value = assertObject(draft, 'draft');
    const request = requireText(value.request, 'draft.request', 100000);
    const projectName = requireText(value.project, 'draft.project', 4096);
    const submitted = assertObject(transcript, 'transcript');
    const latest = this.latestUserTranscript({ sessionId: controlSessionId });
    const turnId = submitted.turnId || submitted.sequence;
    if (!turnId) throw new BridgeError(400, 'invalid_request', 'transcript requires turnId or sequence');
    if (
      latest.turnId !== submitted.turnId
      || latest.sequence !== submitted.sequence
      || latest.text !== submitted.text
    ) {
      throw new BridgeError(409, 'confirmation_not_current', 'confirmation must match the latest voice transcript');
    }
    if (!affirmative(latest.text)) {
      throw new BridgeError(409, 'confirmation_not_explicit', 'an explicit affirmative transcript is required');
    }
    return this.#once(idempotencyKey, {
      sessionId: controlSessionId,
      draftId,
      binding,
      request,
      projectName,
      turnId,
    }, async () => {
      const project = await this.#resolveProject(projectName);
      const title = String(value.title || request).trim().slice(0, 120) || 'Voice work';
      let created;
      try {
        created = await this.cmb.createSession({
          project: project.key,
          title,
          requestId: crypto.randomUUID(),
        });
      } catch (error) {
        if (error?.unknown) return { status: 'unknown', retryable: false, reconciliationRequired: true };
        throw error;
      }
      const work = {
        workId: `work_${crypto.randomUUID()}`,
        sessionId: created.id,
        controlSessionId,
        project: project.key,
        title,
        request,
        status: 'running',
        createdAt: isoNow(),
        updatedAt: isoNow(),
        lastObservation: null,
        result: null,
        artifacts: [],
      };
      const data = this.store.read();
      data.works[work.workId] = work;
      this.store.write(data);
      this.bus.appendTaskEvent({
        topic: 'task.created',
        text: `任务已创建：${title}`,
        workId: work.workId,
        sessionId: controlSessionId,
        payload: { workId: work.workId, workSessionId: work.sessionId, title, project: project.key, controlSessionId },
        dedupeKey: `create:${work.workId}`,
      });
      try {
        const receipt = await this.cmb.send(created.id, {
          text: request,
          requestId: crypto.randomUUID(),
          mode: 'send',
        });
        if (receipt?.status === 'failed' || receipt?.outcome === 'failed') {
          this.#updateWork(work.workId, { status: 'failed' });
          return { status: 'failed', workId: work.workId, sessionId: created.id, error: receipt.error || 'CMB rejected the task' };
        }
      } catch (error) {
        if (error?.unknown) {
          return { status: 'unknown', workId: work.workId, sessionId: created.id, retryable: false, reconciliationRequired: true };
        }
        this.#updateWork(work.workId, { status: 'failed' });
        throw error;
      }
      this.#startMonitor(work.workId);
      return {
        status: 'accepted',
        workId: work.workId,
        sessionId: created.id,
        title,
        project: project.key,
        speech: `任务已创建并受理：${title}`,
      };
    });
  }

  async findWork({ query, limit = 20 }) {
    const bounded = Math.max(1, Math.min(50, Number(limit) || 20));
    const data = this.store.read();
    const text = String(query || '').trim().toLowerCase();
    const local = Object.values(data.works)
      .filter((work) => !text || `${work.title} ${work.request} ${work.project}`.toLowerCase().includes(text))
      .slice(0, bounded);
    const remote = await this.cmb.sessions({ query, limit: bounded });
    const bySession = new Map(local.map((work) => [work.sessionId, work]));
    for (const session of remote.sessions || []) {
      if (!bySession.has(session.id)) bySession.set(session.id, session);
    }
    return { candidates: [...bySession.values()].slice(0, bounded) };
  }

  async getStatus({ sessionId = null, workId = null }) {
    const work = await this.#syncWork(this.#workFor({ sessionId, workId }));
    const pending = Object.values(this.store.read().interactions)
      .filter((item) => item.status === 'pending' && item.workId === work.workId);
    return { work, pendingInteractions: pending };
  }

  async sendMessage({ sessionId = null, workId = null, text, mode = 'send', idempotencyKey }) {
    const work = this.#workFor({ sessionId, workId });
    if (TERMINAL.has(work.status)) throw new BridgeError(409, 'work_terminal', `work is already ${work.status}`);
    const message = requireText(text, 'text', 100000);
    return this.#once(idempotencyKey, { workId: work.workId, text: message, mode }, async () => {
      const receipt = await this.cmb.send(work.sessionId, {
        text: message,
        requestId: crypto.randomUUID(),
        mode,
      });
      return { status: receipt?.status || 'accepted', workId: work.workId, sessionId: work.sessionId, receipt };
    });
  }

  async readWork({ sessionId = null, workId = null, view = 'history', after = '0', before = null, maxChars = 100000 }) {
    const work = this.#workFor({ sessionId, workId });
    if (view === 'activity') {
      return this.bus.readTaskEvents({ after, limit: 100, sessionId: work.controlSessionId });
    }
    if (view === 'artifacts') return { workId: work.workId, artifacts: work.artifacts || [] };
    if (view === 'result') return { workId: work.workId, status: work.status, result: work.result || null };
    if (view === 'errors') {
      return {
        workId: work.workId,
        status: work.status,
        error: work.result?.outcome === 'failed' ? work.result.summary : null,
      };
    }
    const history = await this.cmb.history(work.sessionId);
    const messages = (history?.messages || []).map((message) => ({
      role: String(message.role || 'assistant').slice(0, 32),
      text: displayText(message).slice(0, Math.max(1, Math.min(100000, Number(maxChars) || 100000))),
    }));
    return {
      workId: work.workId,
      sessionId: work.sessionId,
      view,
      after,
      before,
      messages,
    };
  }

  readEvents({ sessionId = null, after = '0', topics = [], limit = 100 } = {}) {
    return this.bus.readTaskEvents({ after, limit, topics, sessionId });
  }

  async resolveAnswer({ sessionId, interactionId, binding, answers, transcript, idempotencyKey }) {
    return this.#resolveInteraction({ sessionId, interactionId, binding, transcript, idempotencyKey, kind: 'question', value: { answers } });
  }

  async resolveApproval({ sessionId, interactionId, binding, decision, transcript, idempotencyKey }) {
    return this.#resolveInteraction({ sessionId, interactionId, binding, transcript, idempotencyKey, kind: 'approval', value: { decision } });
  }

  async stopWork({ sessionId = null, workId = null, idempotencyKey }) {
    const work = this.#workFor({ sessionId, workId });
    return this.#once(idempotencyKey, { workId: work.workId, op: 'stop' }, async () => {
      const receipt = await this.cmb.stop(work.sessionId);
      this.#updateWork(work.workId, { status: 'stopped' });
      this.bus.appendTaskEvent({
        topic: 'task.stopped',
        text: `任务已停止：${work.title}`,
        workId: work.workId,
        sessionId: work.controlSessionId,
        payload: { workId: work.workId, controlSessionId: work.controlSessionId },
        dedupeKey: `stop:${work.workId}`,
      });
      this.#stopMonitor(work.workId);
      return { status: 'accepted', workId: work.workId, receipt };
    });
  }

  async emitProgress({ sessionId, text, percent = null, artifact = null, idempotencyKey }) {
    const work = this.#reportWork(sessionId);
    const message = requireText(text, 'text', 4000);
    return this.#once(idempotencyKey, { workId: work.workId, message, percent, artifact }, async () => {
      if (inTerminal(work.status)) throw new BridgeError(409, 'work_terminal', `work is already ${work.status}`);
      if (artifact) {
        const data = this.store.read();
        data.works[work.workId].artifacts.push(cloneJson(artifact));
        this.store.write(data);
      }
      this.bus.appendTaskEvent({
        topic: 'task.progress',
        text: message,
        workId: work.workId,
        sessionId: work.controlSessionId,
        payload: { workId: work.workId, percent, artifact, controlSessionId: work.controlSessionId },
        dedupeKey: `progress:${work.workId}:${idempotencyKey}`,
      });
      return { status: 'accepted', workId: work.workId, progress: { text: message, percent, artifact } };
    });
  }

  async requestInput({ sessionId, questions, speak = null, expiresAt = null, idempotencyKey }) {
    const work = this.#reportWork(sessionId);
    if (!Array.isArray(questions) || !questions.length) throw new Error('questions are required');
    return this.#once(idempotencyKey, { workId: work.workId, questions, speak, expiresAt }, async () => {
      const interaction = this.#createInteraction(work, 'question', {
        questions,
        speak: speak || questions[0]?.text || '需要你补充信息。',
        expiresAt,
      });
      return { status: 'pending', interactionId: interaction.interactionId, binding: interaction.binding, speak: interaction.speak };
    });
  }

  async requestApproval({ sessionId, operation, target, impact, reversibility, speak, expiresAt = null, idempotencyKey }) {
    const work = this.#reportWork(sessionId);
    return this.#once(idempotencyKey, { workId: work.workId, operation, target, impact, reversibility, speak, expiresAt }, async () => {
      const interaction = this.#createInteraction(work, 'approval', {
        operation,
        target,
        impact,
        reversibility,
        speak: speak || `是否确认${operation}？`,
        expiresAt,
      });
      return { status: 'pending', interactionId: interaction.interactionId, binding: interaction.binding, speak: interaction.speak };
    });
  }

  async publishArtifact({ sessionId, artifact, idempotencyKey }) {
    const work = this.#reportWork(sessionId);
    if (!artifact || typeof artifact !== 'object') throw new Error('artifact is required');
    return this.#once(idempotencyKey, { workId: work.workId, artifact }, async () => {
      const data = this.store.read();
      data.works[work.workId].artifacts.push(cloneJson(artifact));
      data.works[work.workId].updatedAt = isoNow();
      this.store.write(data);
      this.bus.appendTaskEvent({
        topic: 'artifact.ready',
        text: `产物已就绪：${artifact.title || artifact.artifactId || artifact.uri || '未命名产物'}`,
        workId: work.workId,
        sessionId: work.controlSessionId,
        payload: { workId: work.workId, artifact, controlSessionId: work.controlSessionId },
        dedupeKey: `artifact:${work.workId}:${artifact.artifactId || artifact.uri}`,
      });
      return { status: 'accepted', workId: work.workId, artifact };
    });
  }

  async finishWork({ sessionId, outcome, summary, resultRef = null, artifactIds = [], idempotencyKey }) {
    const work = this.#reportWork(sessionId);
    const result = requireText(summary, 'summary', 12000);
    return this.#once(idempotencyKey, { workId: work.workId, outcome, result, resultRef, artifactIds }, async () => {
      if (!['completed', 'failed', 'interrupted', 'blocked'].includes(outcome)) throw new Error('invalid outcome');
      const finalStatus = outcome === 'completed' ? 'completed' : outcome;
      const data = this.store.read();
      data.works[work.workId].status = finalStatus;
      data.works[work.workId].result = { outcome, summary: result, resultRef, artifactIds };
      data.works[work.workId].updatedAt = isoNow();
      this.store.write(data);
      const topic = outcome === 'completed' ? 'task.completed' : outcome === 'interrupted' ? 'task.interrupted' : 'task.failed';
      const notice = outcome === 'completed' ? `任务完成：${result}` : `任务${outcome === 'interrupted' ? '已中断' : '未完成'}：${result}`;
      this.bus.appendTaskEvent({
        topic,
        text: notice,
        workId: work.workId,
        sessionId: work.controlSessionId,
        payload: { workId: work.workId, outcome, summary: result, resultRef, artifactIds, controlSessionId: work.controlSessionId },
        dedupeKey: `finish:${work.workId}:${idempotencyKey}`,
      });
      this.#stopMonitor(work.workId);
      return { status: 'accepted', workId: work.workId, outcome, summary: result, resultRef, artifactIds };
    });
  }

  ackAnnouncement({ noticeId, deliveryStatus }) {
    return { status: 'accepted', noticeId, deliveryStatus, owner: 'voice-control' };
  }

  async #resolveInteraction({ sessionId, interactionId, binding, transcript, idempotencyKey, kind, value }) {
    const data = this.store.read();
    const interaction = data.interactions[interactionId];
    if (!interaction || interaction.sessionId !== sessionId || interaction.binding !== binding || interaction.status !== 'pending') {
      throw new BridgeError(409, 'stale_interaction', 'Interaction binding is stale or unknown');
    }
    if (interaction.kind !== kind) throw new BridgeError(409, 'interaction_kind_mismatch', 'interaction kind does not match');
    if (interaction.expiresAt && Date.parse(interaction.expiresAt) <= Date.now()) {
      throw new BridgeError(409, 'interaction_expired', 'interaction has expired');
    }
    const latest = this.latestUserTranscript({ sessionId });
    if (
      !transcript
      || latest.turnId !== transcript.turnId
      || latest.sequence !== transcript.sequence
      || latest.text !== transcript.text
      || latest.turnId === interaction.baselineTurnId
    ) {
      throw new BridgeError(409, 'transcript_not_current', 'a newer real user transcript is required');
    }
    return this.#once(idempotencyKey, { interactionId, value }, async () => {
      if (interaction.remoteRequestId) {
        await this.cmb.respond(interaction.workSessionId, interaction.remoteRequestId, value);
      }
      const current = this.store.read();
      current.interactions[interactionId].status = 'resolved';
      current.interactions[interactionId].resolution = value;
      current.interactions[interactionId].resolvedAt = isoNow();
      this.store.write(current);
      this.bus.appendTaskEvent({
        topic: 'interaction.answered',
        text: `${kind === 'approval' ? '审批' : '问题'}已处理`,
        workId: interaction.workId,
        sessionId: interaction.sessionId,
        payload: { interactionId, kind, ...value, controlSessionId: interaction.sessionId },
        dedupeKey: `interaction:${interactionId}:resolved`,
      });
      return { status: 'accepted', interactionId, ...value };
    });
  }

  #createInteraction(work, kind, details) {
    const data = this.store.read();
    const interactionId = `int_${crypto.randomUUID()}`;
    const baseline = this.bus.latestTranscript(work.controlSessionId);
    const interaction = {
      interactionId,
      workId: work.workId,
      workSessionId: work.sessionId,
      sessionId: work.controlSessionId,
      kind,
      status: 'pending',
      binding: interactionBinding(),
      baselineTurnId: baseline?.turnId || null,
      createdAt: isoNow(),
      expiresAt: details.expiresAt || new Date(Date.now() + DEFAULT_TTL_MS).toISOString(),
      ...details,
    };
    data.interactions[interactionId] = interaction;
    this.store.write(data);
    this.bus.appendTaskEvent({
      topic: 'interaction.requested',
      text: interaction.speak,
      workId: work.workId,
      sessionId: work.controlSessionId,
      payload: { ...interaction, controlSessionId: work.controlSessionId },
      dedupeKey: `interaction:${interactionId}:requested`,
    });
    return interaction;
  }

  #reportWork(sessionId) {
    const work = Object.values(this.store.read().works).find((item) => item.sessionId === sessionId);
    if (!work) throw new BridgeError(404, 'work_not_found', 'work reporter session is not bound to work');
    return work;
  }

  #workFor({ sessionId = null, workId = null }) {
    const data = this.store.read();
    const work = workId
      ? data.works[workId]
      : Object.values(data.works).find((item) => item.sessionId === sessionId || item.controlSessionId === sessionId);
    if (!work) throw new BridgeError(404, 'work_not_found', 'work was not found');
    return cloneJson(work);
  }

  async #resolveProject(value) {
    const projects = (await this.cmb.projects()).projects || [];
    const needle = String(value).trim().toLowerCase();
    const matches = projects.filter((project) => [project.key, project.name].filter(Boolean)
      .some((item) => String(item).toLowerCase() === needle));
    if (matches.length === 1) return matches[0];
    if (!matches.length) throw new BridgeError(404, 'project_not_found', 'project was not found in CMB');
    throw new BridgeError(409, 'project_ambiguous', 'project name matches multiple CMB projects');
  }

  #updateWork(workId, patch) {
    const data = this.store.read();
    if (!data.works[workId]) return;
    Object.assign(data.works[workId], patch, { updatedAt: isoNow() });
    this.store.write(data);
  }

  async #syncWork(work) {
    if (TERMINAL.has(work.status) || typeof this.cmb.view !== 'function') return work;
    try {
      const view = await this.cmb.view(work.sessionId);
      const remoteStatus = String(view?.status || view?.session?.status || '').toLowerCase();
      const summary = displayText(view?.summary || view?.lastMessage || view?.message);
      const fingerprint = JSON.stringify({ remoteStatus, summary, updatedAt: view?.updatedAt || null });
      if (fingerprint !== work.lastObservation && (remoteStatus || summary)) {
        this.#updateWork(work.workId, { lastObservation: fingerprint });
        if (summary) {
          this.bus.appendTaskEvent({
            topic: 'task.progress',
            text: summary.slice(0, 4000),
            workId: work.workId,
            sessionId: work.controlSessionId,
            payload: { workId: work.workId, remoteStatus, controlSessionId: work.controlSessionId },
            dedupeKey: `observed:${work.workId}:${crypto.createHash('sha256').update(fingerprint).digest('hex')}`,
          });
        }
      }
      if (['completed', 'failed', 'interrupted', 'blocked', 'stopped'].includes(remoteStatus)) {
        this.#updateWork(work.workId, { status: remoteStatus });
        this.#stopMonitor(work.workId);
      }
      return this.#workFor({ workId: work.workId });
    } catch {
      return work;
    }
  }

  #startMonitor(workId) {
    if (this.monitors.has(workId)) return;
    const timer = setInterval(() => {
      const work = this.store.read().works[workId];
      if (!work || TERMINAL.has(work.status)) {
        this.#stopMonitor(workId);
        return;
      }
      void this.#syncWork(work);
    }, this.monitorIntervalMs);
    timer.unref?.();
    this.monitors.set(workId, timer);
  }

  #stopMonitor(workId) {
    const timer = this.monitors.get(workId);
    if (timer) clearInterval(timer);
    this.monitors.delete(workId);
  }

  async #once(key, payload, operation) {
    const idempotencyKey = requireText(key, 'idempotencyKey', 512);
    const data = this.store.read();
    const existing = data.idempotency[idempotencyKey];
    const fingerprint = canonicalJson(payload);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new BridgeError(409, 'idempotency_conflict', 'idempotency key was reused with different content');
      }
      return cloneJson(existing.result);
    }
    const result = await operation();
    const current = this.store.read();
    current.idempotency[idempotencyKey] = { fingerprint, result: cloneJson(result), createdAt: isoNow() };
    this.store.write(current);
    return result;
  }

  close() {
    for (const workId of this.monitors.keys()) this.#stopMonitor(workId);
  }
}

function inTerminal(status) {
  return TERMINAL.has(status);
}

export function createDirectBackend(config, options = {}) {
  return new DirectControlBackend({
    ...options,
    cmb: new CmbAdapter(config.cmb),
    dataDir: config.dataDir,
    eventDir: config.eventDir,
  });
}
