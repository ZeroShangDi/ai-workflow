import crypto from 'node:crypto';
import path from 'node:path';

import { BindingStore } from './bindings.mjs';
import { CmbAdapter } from './cmb-adapter.mjs';
import { ConsumerRegistry } from './consumer-registry.mjs';
import { ControlStore } from './control-store.mjs';
import { EventStore } from './event-store.mjs';
import { HubError } from './errors.mjs';
import { IdempotencyStore } from './idempotency.mjs';
import { DeliveryInbox } from './inbox.mjs';
import { VoiceTriggerClient } from './voice-client.mjs';
import {
  assertObject,
  cloneJson,
  requireText,
} from './util.mjs';

const AFFIRMATIVE = /^(确认|确认创建|是的|是|好|可以|同意|对|批准|yes|y|ok|okay|confirm|approve)[。.!！]?$/i;
const NEGATIVE = /^(否|不|不行|不用|不要|取消|拒绝|no|n|cancel|reject)[。.!！]?$/i;
const WORK_READ_VIEWS = new Set(['history', 'result', 'errors', 'activity', 'artifacts']);

function isUnknownReceipt(value) {
  return value?.status === 'unknown'
    || value?.outcome === 'unknown'
    || value?.result === 'unknown';
}

function isFailedReceipt(value) {
  return value?.status === 'failed'
    || value?.outcome === 'failed'
    || value?.result === 'failed';
}

function subscriptionAckRequired(registry, consumer, event) {
  const matches = registry.matchingSubscriptions(consumer, event);
  return matches.length === 0 || matches.some((item) => item.delivery.ackRequired);
}

function decisionFromTranscript(text) {
  const normalized = String(text || '').trim();
  if (AFFIRMATIVE.test(normalized)) return 'approve';
  if (NEGATIVE.test(normalized)) return 'reject';
  return 'ambiguous';
}

function interactionIsNewer(interaction, transcript) {
  if (interaction.baselineSequence === null || interaction.baselineSequence === undefined) {
    return Boolean(transcript);
  }
  const baseline = Number(interaction.baselineSequence);
  const current = Number(transcript?.sequence);
  if (Number.isSafeInteger(baseline) && Number.isSafeInteger(current)) {
    return current > baseline;
  }
  return Boolean(transcript && interaction.baselineSequence !== transcript.sequence);
}

function defaultWorkTitle(draft) {
  const title = String(draft.title || draft.request || '').trim();
  return title.slice(0, 120) || 'Voice work';
}

export class Hub {
  constructor(config, {
    adapter = null,
    voiceClient = null,
  } = {}) {
    this.config = config;
    this.dataDir = path.resolve(config.dataDir);
    this.events = new EventStore({ dataDir: this.dataDir });
    this.consumers = new ConsumerRegistry({ dataDir: this.dataDir });
    this.bindings = new BindingStore({ dataDir: this.dataDir });
    this.inbox = new DeliveryInbox({ dataDir: this.dataDir });
    this.idempotency = new IdempotencyStore({ dataDir: this.dataDir });
    this.controls = new ControlStore({ dataDir: this.dataDir });
    this.adapter = adapter || new CmbAdapter(config.cmb);
    this.voice = voiceClient || new VoiceTriggerClient(config.voice || {});
  }

  status() {
    return {
      service: 'bridge-hub',
      schemaVersion: 1,
      eventCursor: String(this.events.lastCursor),
      subscriptionsDefault: 'none',
      consumers: this.consumers.list(),
      subscriptions: this.consumers.listSubscriptions(),
      bindings: this.bindings.list().length,
      works: Object.keys(this.controls.store.read().works).length,
      pendingInteractions: this.controls.pendingInteractions().length,
      inboxPending: this.inbox.list({ status: 'queued' }).length
        + this.inbox.list({ status: 'speaking' }).length,
      cmb: {
        baseUrl: this.config.cmb.baseUrl,
        configured: Boolean(this.config.cmb.username && this.config.cmb.password),
      },
      voice: {
        baseUrl: this.config.voice?.baseUrl || null,
        configured: this.voice.configured === true,
      },
    };
  }

  appendEvent(input) {
    return this.events.append(input);
  }

  readEvents({
    after = '0',
    limit = 100,
    consumer = null,
    topics = [],
  } = {}) {
    const requestedTopics = new Set(Array.isArray(topics) ? topics : []);
    if (!consumer) {
      return this.events.read({ after, limit, topics });
    }
    const state = this.consumers.get(consumer);
    if (!state.active) {
      throw new HubError(
        403,
        'subscription_required',
        'consumer must be installed, configured, healthy, paired, and explicitly subscribed',
        { state },
      );
    }
    const page = this.events.read({ after, limit });
    const seen = new Set();
    const events = page.events.filter((event) => {
      if (requestedTopics.size && !requestedTopics.has(event.topic)) return false;
      if (seen.has(event.eventId)) return false;
      if (!this.consumers.canConsume(consumer, event)) return false;
      seen.add(event.eventId);
      return true;
    });
    return { ...page, events };
  }

  recordTranscript(input) {
    return this.controls.recordTranscript(input);
  }

  latestUserTranscript({ sessionId, consumer = null }) {
    if (consumer) this.assertActiveConsumer(consumer);
    const transcript = this.controls.latestTranscript({ sessionId });
    if (!transcript) {
      throw new HubError(404, 'transcript_not_found', 'no user transcript exists for this session');
    }
    return transcript;
  }

  getPending({ sessionId, interactionId, consumer = null }) {
    if (consumer) this.assertActiveConsumer(consumer);
    const interaction = this.controls.getInteraction(interactionId);
    if (!interaction) return null;
    if (interaction.status !== 'pending') return null;
    if (interaction.expiresAt && Date.parse(interaction.expiresAt) <= Date.now()) return null;
    if (sessionId && interaction.sessionId !== sessionId) {
      throw new HubError(403, 'session_interaction_mismatch', 'interaction belongs to another session');
    }
    return interaction;
  }

  enqueueDelivery(input) {
    const body = assertObject(input, 'delivery');
    const event = body.eventId
      ? this.events.get(requireText(body.eventId, 'eventId', 128))
      : body.event;
    if (!event) throw new HubError(404, 'event_not_found', 'event does not exist');
    const consumer = requireText(body.consumer, 'consumer', 128);
    if (!this.consumers.canConsume(consumer, event)) {
      throw new HubError(
        409,
        'pairing_or_subscription_required',
        'consumer is not active for this event topic and filters',
      );
    }
    return this.inbox.enqueue({
      event,
      consumer,
      ackRequired: subscriptionAckRequired(this.consumers, consumer, event),
    });
  }

  assertActiveConsumer(consumer) {
    const state = this.consumers.get(consumer);
    if (!state.active) {
      throw new HubError(403, 'subscription_required', 'control consumer is not active');
    }
    return state;
  }

  #notifyVoice(event) {
    try {
      if (!this.consumers.canConsume('voice-control', event)) return null;
      return this.inbox.enqueue({
        event,
        consumer: 'voice-control',
        ackRequired: subscriptionAckRequired(this.consumers, 'voice-control', event),
      });
    } catch (error) {
      if (error instanceof HubError && [
        'subscription_required',
        'pairing_or_subscription_required',
      ].includes(error.code)) return null;
      throw error;
    }
  }

  #appendWorkEvent({
    source = 'bridge-hub',
    work,
    topic,
    dedupeKey,
    payload = {},
    notify = false,
    correlationId = null,
  }) {
    const result = this.events.append({
      source,
      topic,
      scope: {
        sessionId: work.workSessionId,
        workId: work.workId,
        controlSessionId: work.controlSessionId,
      },
      payload,
      dedupeKey,
      correlationId,
    });
    if (notify) this.#notifyVoice(result.event);
    return result;
  }

  async #resolveProject(value) {
    const requested = requireText(value, 'project', 4096);
    if (requested === 'local|independent' || typeof this.adapter.projects !== 'function') {
      return { key: requested, name: requested, cwd: null };
    }
    const listing = await this.adapter.projects();
    const normalized = requested.toLocaleLowerCase();
    const exact = listing.projects.find((item) => item.key === requested);
    const matches = exact ? [exact] : listing.projects.filter((item) => (
        item.name?.toLocaleLowerCase() === normalized
        || item.cwd?.toLocaleLowerCase() === normalized
        || item.cwd?.split(/[\\/]/).at(-1)?.toLocaleLowerCase() === normalized
    ));
    if (!matches.length) {
      throw new HubError(409, 'project_not_found', 'project is not registered in the bridge software', {
        requested,
        candidates: listing.projects.slice(0, 20),
      });
    }
    if (matches.length > 1) {
      throw new HubError(409, 'project_ambiguous', 'project name matches multiple registered projects', {
        requested,
        candidates: matches.slice(0, 20),
      });
    }
    return matches[0];
  }

  async createWork({
    consumer,
    sessionId,
    idempotencyKey,
    draftId,
    binding,
    draft,
    transcript,
  }) {
    this.assertActiveConsumer(consumer);
    const controlSessionId = requireText(sessionId, 'sessionId', 256);
    const createDraftId = requireText(draftId, 'draftId', 256);
    const draftBinding = requireText(binding, 'binding', 256);
    const value = assertObject(draft, 'draft');
    const projectName = requireText(value.project, 'draft.project', 4096);
    const request = requireText(value.request, 'draft.request', 100000);
    const submittedTranscript = assertObject(transcript, 'transcript');
    const submittedTurn = submittedTranscript.turnId || submittedTranscript.sequence;
    if (!submittedTurn) {
      throw new HubError(400, 'invalid_request', 'transcript requires turnId or sequence');
    }
    const payload = {
      consumer,
      sessionId: controlSessionId,
      draftId: createDraftId,
      binding: draftBinding,
      draft: cloneJson(value),
      transcript: cloneJson(submittedTranscript),
    };
    return this.idempotency.execute({
      key: idempotencyKey,
      payload,
      operation: async () => {
        const latestTranscript = this.controls.latestTranscript({ sessionId: controlSessionId });
        if (
          !latestTranscript
          || latestTranscript.turnId !== submittedTranscript.turnId
          || latestTranscript.sequence !== String(submittedTranscript.sequence)
          || latestTranscript.text !== submittedTranscript.text
        ) {
          throw new HubError(
            409,
            'confirmation_not_current',
            'create confirmation must match the newest stored user transcript',
          );
        }
        if (decisionFromTranscript(latestTranscript.text) !== 'approve') {
          throw new HubError(
            409,
            'confirmation_not_explicit',
            'create confirmation requires an explicit affirmative transcript',
          );
        }
        const project = await this.#resolveProject(projectName);
        const confirmation = this.controls.reserveConfirmation({
          sessionId: controlSessionId,
          draftId: createDraftId,
          binding: draftBinding,
          transcript: submittedTranscript,
        });
        let created;
        try {
          created = await this.adapter.createSession({
            project: project.key,
            title: defaultWorkTitle(value),
            requestId: crypto.randomUUID(),
          });
        } catch (error) {
          if (error?.unknown !== true) {
            this.controls.releaseConfirmation(confirmation.confirmationId);
          }
          throw error;
        }
        const work = this.controls.createWork({
          controlSessionId,
          workSessionId: created.id,
          project: project.key,
          title: defaultWorkTitle(value),
          request,
        });
        this.controls.commitConfirmation(confirmation.confirmationId, {
          workId: work.workId,
        });
        this.bindings.create({
          controlSessionId,
          workSessionId: created.id,
          metadata: {
            workId: work.workId,
            project: project.key,
          },
        });
        this.#appendWorkEvent({
          work,
          topic: 'task.created',
          dedupeKey: `create:${work.workId}:accepted`,
          payload: {
            workId: work.workId,
            title: work.title,
            project: work.project,
          },
          correlationId: idempotencyKey,
        });
        try {
          const receipt = await this.adapter.send(created.id, {
            text: request,
            requestId: crypto.randomUUID(),
            mode: 'send',
          });
          if (isUnknownReceipt(receipt)) {
            return {
              status: 'unknown',
              workId: work.workId,
              sessionId: created.id,
              reconcileRequired: true,
              message: 'The work was created, but the initial instruction result is unknown.',
            };
          }
          if (isFailedReceipt(receipt)) {
            this.controls.updateWork(work.workId, { status: 'failed' });
            this.#appendWorkEvent({
              work,
              topic: 'task.failed',
              dedupeKey: `create:${work.workId}:initial-send-failed`,
              payload: {
                workId: work.workId,
                summary: receipt.error || 'The initial work instruction failed.',
              },
              notify: true,
            });
            return {
              status: 'failed',
              workId: work.workId,
              sessionId: created.id,
              error: receipt.error || 'The initial work instruction failed.',
            };
          }
          this.controls.updateWork(work.workId, { status: 'running' });
          return {
            status: 'accepted',
            workId: work.workId,
            sessionId: created.id,
            title: work.title,
            project: work.project,
            cmb: receipt,
            speech: `任务已创建并受理：${work.title}`,
          };
        } catch (error) {
          if (error?.unknown === true) {
            return {
              status: 'unknown',
              workId: work.workId,
              sessionId: created.id,
              reconcileRequired: true,
              message: 'The work was created, but the initial instruction result is unknown.',
            };
          }
          this.controls.updateWork(work.workId, { status: 'failed' });
          this.#appendWorkEvent({
            work,
            topic: 'task.failed',
            dedupeKey: `create:${work.workId}:initial-send-failed`,
            payload: { workId: work.workId, summary: error.message },
            notify: true,
          });
          throw error;
        }
      },
    });
  }

  async findWork({ query = '', limit = 20, consumer }) {
    this.assertActiveConsumer(consumer);
    const bounded = Math.max(1, Math.min(50, Number(limit) || 20));
    const local = this.controls.findWork({ query, limit: bounded });
    if (typeof this.adapter.sessions !== 'function') return { candidates: local };
    const remote = await this.adapter.sessions({ query, limit: bounded });
    const bySession = new Map(local.map((item) => [item.sessionId, item]));
    for (const session of remote.sessions) {
      if (!bySession.has(session.id)) {
        bySession.set(session.id, {
          sessionId: session.id,
          workId: null,
          title: session.title,
          project: session.project,
          status: session.status || 'unknown',
          updatedAt: session.updatedAt || null,
        });
      }
    }
    return { candidates: [...bySession.values()].slice(0, bounded) };
  }

  async #workFor({ sessionId = null, workId = null }) {
    let work = this.controls.getWork(workId);
    if (!work && sessionId) work = this.controls.workBySession(sessionId);
    if (!work && sessionId) {
      const binding = this.bindings.list({ controlSessionId: sessionId }).at(-1)
        || this.bindings.list({ voiceSessionId: sessionId }).at(-1);
      if (binding) {
        work = this.controls.workBySession(binding.workSessionId);
      }
    }
    return work;
  }

  async getStatus({ sessionId = null, workId = null, consumer }) {
    this.assertActiveConsumer(consumer);
    const work = await this.#workFor({ sessionId, workId });
    if (!work) throw new HubError(404, 'work_not_found', 'work does not exist');
    let view = null;
    try {
      view = await this.adapter.view(work.workSessionId);
    } catch (error) {
      if (error?.status !== 404) throw error;
    }
    return {
      workId: work.workId,
      sessionId: work.workSessionId,
      title: work.title,
      project: work.project,
      status: work.status,
      cmbStatus: view?.status || null,
      latestProgress: work.progress.at(-1) || null,
      pending: this.controls.pendingInteractions({
        sessionId: work.controlSessionId,
        workId: work.workId,
      }),
      result: {
        outcome: work.outcome,
        summary: work.summary,
        resultRef: work.resultRef,
        artifactIds: work.artifactIds,
        artifacts: work.artifacts,
      },
    };
  }

  async readWork({
    consumer,
    sessionId = null,
    workId = null,
    view = 'history',
    after = '0',
    before = null,
    limit = 50,
    maxChars = 100000,
  }) {
    this.assertActiveConsumer(consumer);
    if (!WORK_READ_VIEWS.has(view)) {
      throw new HubError(400, 'invalid_request', 'view is invalid');
    }
    const boundedChars = Math.max(1, Math.min(100000, Number(maxChars) || 100000));
    const work = await this.#workFor({ sessionId, workId });
    const targetSession = work?.workSessionId || sessionId;
    if (!targetSession) throw new HubError(400, 'invalid_request', 'sessionId or workId is required');
    if (['history', 'result'].includes(view) && typeof this.adapter.history === 'function') {
      const history = await this.adapter.history(targetSession);
      const serialized = JSON.stringify(history);
      const offset = Number(after || 0);
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new HubError(400, 'invalid_request', 'history after must be a character offset');
      }
      if (offset || serialized.length > boundedChars) {
        const end = Math.min(serialized.length, offset + boundedChars);
        return {
          workId: work?.workId || null,
          sessionId: targetSession,
          view,
          historyText: serialized.slice(offset, end),
          offset,
          nextOffset: end < serialized.length ? String(end) : null,
          complete: end >= serialized.length,
        };
      }
      return { workId: work?.workId || null, sessionId: targetSession, view, history };
    }
    if (!work) {
      throw new HubError(404, 'work_not_found', 'work event views require a bound work');
    }
    const page = this.events.read({
      after,
      limit: Math.max(1, Math.min(100, Number(limit) || 50)),
    });
    if (
      before !== null
      && before !== undefined
      && before !== ''
      && !/^(0|[1-9][0-9]*)$/.test(String(before))
    ) {
      throw new HubError(400, 'invalid_request', 'before must be a non-negative cursor');
    }
    const candidates = page.events
      .filter((event) => !before || Number(event.cursor) < Number(before))
      .filter((event) => !work || event.scope.workId === work.workId)
      .filter((event) => {
        if (view === 'artifacts') return event.topic === 'artifact.ready';
        if (view === 'errors') return ['task.failed', 'task.interrupted'].includes(event.topic);
        return true;
      });
    const events = [];
    let chars = 0;
    let truncated = false;
    for (const event of candidates) {
      const size = JSON.stringify(event).length;
      if (events.length && chars + size > boundedChars) {
        truncated = true;
        break;
      }
      events.push(event);
      chars += size;
    }
    return {
      workId: work.workId,
      sessionId: targetSession,
      view,
      events,
      nextCursor: truncated && events.length ? events.at(-1).cursor : page.nextCursor,
      truncated,
    };
  }

  async sendWorkMessage({
    consumer,
    sessionId = null,
    workId = null,
    text,
    mode = 'send',
    idempotencyKey,
  }) {
    this.assertActiveConsumer(consumer);
    const work = await this.#workFor({ sessionId, workId });
    if (!work) throw new HubError(404, 'work_not_found', 'work does not exist');
    const content = requireText(text, 'text', 100000);
    const payload = {
      consumer,
      workId: work.workId,
      text: content,
      mode,
    };
    const receipt = await this.idempotency.execute({
      key: idempotencyKey,
      payload,
      operation: () => this.adapter.send(work.workSessionId, {
        text: content,
        requestId: crypto.randomUUID(),
        mode,
      }),
    });
    if (isUnknownReceipt(receipt)) {
      return {
        ...receipt,
        workId: work.workId,
        sessionId: work.workSessionId,
        retryable: false,
      };
    }
    if (isFailedReceipt(receipt)) {
      return {
        ...receipt,
        status: 'failed',
        workId: work.workId,
        sessionId: work.workSessionId,
        retryable: false,
      };
    }
    this.#appendWorkEvent({
      source: 'bridge-control',
      work,
      topic: 'task.progress',
      dedupeKey: `message:${work.workId}:${idempotencyKey}`,
      payload: { mode, summary: 'Message sent to the work session.' },
      correlationId: idempotencyKey,
    });
    return { ...receipt, workId: work.workId, sessionId: work.workSessionId };
  }

  async #boundInteraction({ sessionId, interactionId, binding }) {
    const interaction = this.controls.getInteraction(interactionId);
    if (!interaction || interaction.sessionId !== sessionId || interaction.binding !== binding) {
      throw new HubError(409, 'stale_interaction', 'interaction binding is stale or unknown');
    }
    return interaction;
  }

  #latestForInteraction(interaction) {
    const transcript = this.controls.latestTranscript({ sessionId: interaction.sessionId });
    if (!transcript || !interactionIsNewer(interaction, transcript)) {
      throw new HubError(
        409,
        'transcript_not_observed',
        'no newer real user transcript exists for this interaction',
      );
    }
    return transcript;
  }

  async resolveAnswer({
    consumer,
    sessionId,
    interactionId,
    binding,
    answers,
    idempotencyKey,
  }) {
    this.assertActiveConsumer(consumer);
    const interaction = await this.#boundInteraction({ sessionId, interactionId, binding });
    if (interaction.kind !== 'question') {
      throw new HubError(409, 'interaction_kind_mismatch', 'interaction is not a question');
    }
    const transcript = this.#latestForInteraction(interaction);
    if (!Array.isArray(answers) || !answers.length) {
      throw new HubError(400, 'invalid_request', 'answers are required');
    }
    const normalized = answers.map((value, index) => ({
      questionId: requireText(value?.questionId, `answers[${index}].questionId`, 128),
      text: requireText(value?.text, `answers[${index}].text`, 6000),
    }));
    const expectedQuestionIds = new Set(
      (interaction.questions || []).map((question) => question.questionId),
    );
    const receivedQuestionIds = new Set(normalized.map((answer) => answer.questionId));
    if (
      normalized.length !== expectedQuestionIds.size
      || receivedQuestionIds.size !== normalized.length
      || [...expectedQuestionIds].some((questionId) => !receivedQuestionIds.has(questionId))
    ) {
      throw new HubError(
        400,
        'answer_group_incomplete',
        'answers must cover every bound question exactly once',
      );
    }
    const work = this.controls.getWork(interaction.workId);
    const payload = { interactionId, binding, answers: normalized, transcript };
    return this.idempotency.execute({
      key: idempotencyKey,
      payload,
      operation: async () => {
        const message = [
          `用户口述答复（interaction ${interactionId}）：`,
          ...normalized.map((item) => `- ${item.questionId}: ${item.text}`),
        ].join('\n');
        const receipt = await this.adapter.send(work.workSessionId, {
          text: message,
          requestId: crypto.randomUUID(),
          mode: 'send',
        });
        if (isUnknownReceipt(receipt)) {
          return {
            status: 'unknown',
            interactionId,
            workId: work.workId,
            reconcileRequired: true,
          };
        }
        if (isFailedReceipt(receipt)) {
          return {
            status: 'failed',
            interactionId,
            workId: work.workId,
            error: receipt.error || 'The answer could not be delivered.',
          };
        }
        this.controls.resolveInteraction(interactionId, {
          binding,
          resolution: { type: 'answer', answers: normalized, transcript },
        });
        this.#appendWorkEvent({
          source: 'bridge-control',
          work,
          topic: 'interaction.answered',
          dedupeKey: `interaction:${interactionId}:answered`,
          payload: { interactionId, answers: normalized },
          correlationId: idempotencyKey,
        });
        return { status: 'accepted', receipt, interactionId, workId: work.workId };
      },
    });
  }

  async resolveApproval({
    consumer,
    sessionId,
    interactionId,
    binding,
    decision,
    idempotencyKey,
  }) {
    this.assertActiveConsumer(consumer);
    const interaction = await this.#boundInteraction({ sessionId, interactionId, binding });
    if (interaction.kind !== 'approval') {
      throw new HubError(409, 'interaction_kind_mismatch', 'interaction is not an approval');
    }
    if (!['approve', 'reject'].includes(decision)) {
      throw new HubError(400, 'invalid_request', 'decision must be approve or reject');
    }
    const transcript = this.#latestForInteraction(interaction);
    const spokenDecision = decisionFromTranscript(transcript.text);
    if (spokenDecision !== decision) {
      throw new HubError(
        409,
        'approval_transcript_mismatch',
        'latest user transcript does not match the requested approval decision',
        { expected: decision, observed: spokenDecision },
      );
    }
    const work = this.controls.getWork(interaction.workId);
    const payload = { interactionId, binding, decision, transcript };
    return this.idempotency.execute({
      key: idempotencyKey,
      payload,
      operation: async () => {
        const receipt = await this.adapter.send(work.workSessionId, {
          text: `审批结果（interaction ${interactionId}）：${decision === 'approve' ? '批准' : '拒绝'}。`,
          requestId: crypto.randomUUID(),
          mode: 'send',
        });
        if (isUnknownReceipt(receipt)) {
          return {
            status: 'unknown',
            interactionId,
            workId: work.workId,
            reconcileRequired: true,
          };
        }
        if (isFailedReceipt(receipt)) {
          return {
            status: 'failed',
            interactionId,
            workId: work.workId,
            error: receipt.error || 'The approval decision could not be delivered.',
          };
        }
        this.controls.resolveInteraction(interactionId, {
          binding,
          resolution: { type: 'approval', decision, transcript },
        });
        this.#appendWorkEvent({
          source: 'bridge-control',
          work,
          topic: 'interaction.answered',
          dedupeKey: `interaction:${interactionId}:${decision}`,
          payload: {
            interactionId,
            decision,
            summary: decision === 'approve' ? '用户已批准操作。' : '用户已拒绝操作。',
          },
          notify: decision === 'reject',
          correlationId: idempotencyKey,
        });
        return { status: 'accepted', receipt, interactionId, workId: work.workId, decision };
      },
    });
  }

  async stopWork({
    consumer,
    sessionId = null,
    workId = null,
    reason = null,
    idempotencyKey,
  }) {
    this.assertActiveConsumer(consumer);
    const work = await this.#workFor({ sessionId, workId });
    if (!work) throw new HubError(404, 'work_not_found', 'work does not exist');
    const payload = { workId: work.workId, reason };
    const receipt = await this.idempotency.execute({
      key: idempotencyKey,
      payload,
      operation: () => this.adapter.stop(work.workSessionId),
    });
    if (isUnknownReceipt(receipt)) {
      return {
        ...receipt,
        workId: work.workId,
        retryable: false,
      };
    }
    if (isFailedReceipt(receipt)) {
      return {
        ...receipt,
        status: 'failed',
        workId: work.workId,
        retryable: false,
      };
    }
    this.controls.updateWork(work.workId, { status: 'stopped' });
    this.controls.expirePendingInteractions(work.workId);
    this.#appendWorkEvent({
      work,
      topic: 'task.stopped',
      dedupeKey: `stop:${work.workId}:${idempotencyKey}`,
      payload: { reason: reason || null },
      correlationId: idempotencyKey,
    });
    return { ...receipt, status: 'accepted', workId: work.workId };
  }

  #reportWork(sessionId) {
    const work = this.controls.workBySession(sessionId);
    if (!work || work.workSessionId !== sessionId) {
      throw new HubError(404, 'work_not_found', 'work reporter session is not bound to work');
    }
    return work;
  }

  async emitProgress({
    consumer,
    sessionId,
    text,
    percent = null,
    artifact = null,
    idempotencyKey,
  }) {
    this.assertActiveConsumer(consumer);
    const work = this.#reportWork(sessionId);
    const progress = this.idempotency.execute({
      key: idempotencyKey,
      payload: { sessionId, text, percent, artifact: artifact || null },
      operation: async () => {
        const value = this.controls.appendProgress(work.workId, { text, percent, artifact });
        this.#appendWorkEvent({
          source: 'bridge-control',
          work,
          topic: 'task.progress',
          dedupeKey: `progress:${work.workId}:${idempotencyKey}`,
          payload: value,
          correlationId: idempotencyKey,
        });
        return { status: 'accepted', workId: work.workId, progress: value };
      },
    });
    return progress;
  }

  async requestInput({
    consumer,
    sessionId,
    questions,
    speak = null,
    expiresAt = null,
    idempotencyKey,
  }) {
    this.assertActiveConsumer(consumer);
    const work = this.#reportWork(sessionId);
    return this.idempotency.execute({
      key: idempotencyKey,
      payload: { sessionId, questions, speak, expiresAt },
      operation: async () => {
        const interaction = this.controls.createInteraction({
          sessionId: work.controlSessionId,
          workId: work.workId,
          kind: 'question',
          questions,
          speak,
          expiresAt,
        });
        this.#appendWorkEvent({
          source: 'bridge-control',
          work,
          topic: 'interaction.requested',
          dedupeKey: `interaction:${interaction.interactionId}:requested`,
          payload: {
            interactionId: interaction.interactionId,
            binding: interaction.binding,
            kind: 'question',
            questions: interaction.questions,
            speak: interaction.speak,
          },
          notify: true,
          correlationId: idempotencyKey,
        });
        return {
          status: 'pending',
          interactionId: interaction.interactionId,
          binding: interaction.binding,
          speak: interaction.speak,
        };
      },
    });
  }

  async requestApproval({
    consumer,
    sessionId,
    operation,
    target,
    impact,
    reversibility,
    speak,
    expiresAt = null,
    idempotencyKey,
  }) {
    this.assertActiveConsumer(consumer);
    const work = this.#reportWork(sessionId);
    return this.idempotency.execute({
      key: idempotencyKey,
      payload: { sessionId, operation, target, impact, reversibility, speak, expiresAt },
      operation: async () => {
        const interaction = this.controls.createInteraction({
          sessionId: work.controlSessionId,
          workId: work.workId,
          kind: 'approval',
          operation,
          target,
          impact,
          reversibility,
          speak,
          expiresAt,
        });
        this.#appendWorkEvent({
          source: 'bridge-control',
          work,
          topic: 'interaction.requested',
          dedupeKey: `interaction:${interaction.interactionId}:requested`,
          payload: {
            interactionId: interaction.interactionId,
            binding: interaction.binding,
            kind: 'approval',
            operation,
            target,
            impact,
            reversibility,
            speak,
          },
          notify: true,
          correlationId: idempotencyKey,
        });
        return {
          status: 'pending',
          interactionId: interaction.interactionId,
          binding: interaction.binding,
          speak: interaction.speak,
        };
      },
    });
  }

  async publishArtifact({ consumer, sessionId, artifact, idempotencyKey }) {
    this.assertActiveConsumer(consumer);
    const work = this.#reportWork(sessionId);
    return this.idempotency.execute({
      key: idempotencyKey,
      payload: { sessionId, artifact },
      operation: async () => {
        const published = this.controls.publishArtifact(work.workId, artifact);
        if (published.duplicate) {
          return { status: 'accepted', workId: work.workId, artifact: published };
        }
        this.#appendWorkEvent({
          source: 'bridge-control',
          work,
          topic: 'artifact.ready',
          dedupeKey: `artifact:${work.workId}:${published.artifactId}`,
          payload: published,
          correlationId: idempotencyKey,
        });
        return { status: 'accepted', workId: work.workId, artifact: published };
      },
    });
  }

  async finishWork({
    consumer,
    sessionId,
    outcome,
    summary,
    resultRef = null,
    artifactIds = [],
    idempotencyKey,
  }) {
    this.assertActiveConsumer(consumer);
    const work = this.#reportWork(sessionId);
    return this.idempotency.execute({
      key: idempotencyKey,
      payload: { sessionId, outcome, summary, resultRef, artifactIds },
      operation: async () => {
        const finished = this.controls.finishWork(work.workId, {
          outcome,
          summary,
          resultRef,
          artifactIds,
        });
        const topic = outcome === 'completed'
          ? 'task.completed'
          : outcome === 'failed' || outcome === 'blocked'
            ? 'task.failed'
            : outcome === 'interrupted'
              ? 'task.interrupted'
              : 'task.failed';
        this.#appendWorkEvent({
          source: 'bridge-control',
          work,
          topic,
          dedupeKey: `finish:${work.workId}:${idempotencyKey}`,
          payload: {
            workId: work.workId,
            outcome,
            summary,
            resultRef: finished.resultRef,
            artifactIds: finished.artifactIds,
          },
          notify: true,
          correlationId: idempotencyKey,
        });
        return {
          status: 'accepted',
          workId: work.workId,
          outcome,
          summary: finished.summary,
          resultRef: finished.resultRef,
          artifactIds: finished.artifactIds,
        };
      },
    });
  }

  async ackAnnouncement({
    consumer = 'voice-control',
    noticeId,
    deliveryStatus,
    error = null,
  }) {
    this.assertActiveConsumer(consumer);
    const delivery = this.inbox.acknowledge(requireText(noticeId, 'noticeId', 256), {
      consumer,
      outcome: requireText(deliveryStatus, 'deliveryStatus', 32),
      playbackObserved: deliveryStatus !== 'failed',
      error,
    });
    return { status: 'accepted', delivery };
  }

  sendMessage(input) {
    if (input?.message) {
      return this.sendRawMessage(input);
    }
    return this.sendWorkMessage(input);
  }

  sendRawMessage({
    consumer,
    sessionId,
    idempotencyKey,
    message,
  }) {
    this.assertActiveConsumer(consumer);
    const payload = {
      consumer: requireText(consumer, 'consumer', 128),
      sessionId: requireText(sessionId, 'sessionId', 128),
      message: cloneJson(assertObject(message, 'message')),
    };
    return this.idempotency.execute({
      key: idempotencyKey,
      payload,
      operation: () => this.adapter.send(payload.sessionId, payload.message),
    });
  }
}
