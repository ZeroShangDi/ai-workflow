import { randomUUID } from 'node:crypto';

import { VoiceControlError } from './errors.mjs';
import { parseCursor, SessionEventLog } from './events.mjs';

export const VOICE_CONTROL_VERSION = '0.1.0';

const SESSION_OPEN = 'open';
const SESSION_CLOSED = 'closed';
const TRANSCRIPT_ROLES = new Set(['user', 'assistant', 'system']);

function optionalTitle(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new VoiceControlError('invalid_title', 'title must be a string', { status: 400 });
  }
  const title = value.trim();
  if (title.length > 120) {
    throw new VoiceControlError('invalid_title', 'title must be at most 120 characters', {
      status: 400,
    });
  }
  return title;
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new VoiceControlError('invalid_request', `${field} is required`, { status: 400 });
  }
  return value.trim();
}

export class VoiceControlApp {
  constructor({ triggerConfigStore, now = () => new Date(), idFactory = () => randomUUID() }) {
    if (!triggerConfigStore) throw new Error('triggerConfigStore is required');
    this.triggerConfigStore = triggerConfigStore;
    this.now = now;
    this.idFactory = idFactory;
    this.sessions = new Map();
  }

  createSession({ title } = {}) {
    const createdAt = this.now().toISOString();
    const session = {
      id: `vcs_${this.idFactory()}`,
      title: optionalTitle(title),
      status: SESSION_OPEN,
      createdAt,
      closedAt: null,
      events: null,
      listeners: new Set(),
    };
    session.events = new SessionEventLog(session.id);
    this.sessions.set(session.id, session);
    this.#append(session, {
      type: 'session.opened',
      message: '语音会话已打开。',
    });
    return this.#summary(session);
  }

  getSession(sessionId) {
    return this.#summary(this.#requireSession(sessionId));
  }

  appendEvent(sessionId, input = {}) {
    const session = this.#requireSession(sessionId);
    this.#assertOpen(session);
    return this.#append(session, input);
  }

  appendTranscript(sessionId, { role, source, text, dedupeKey = null } = {}) {
    const transcriptRole = role ?? source;
    if (!TRANSCRIPT_ROLES.has(transcriptRole)) {
      throw new VoiceControlError(
        'invalid_event_source',
        'role must be user, assistant, or system',
        { status: 400 },
      );
    }
    return this.appendEvent(sessionId, {
      type: 'transcript',
      role: transcriptRole,
      text,
      dedupeKey,
    });
  }

  closeSession(sessionId) {
    const session = this.#requireSession(sessionId);
    if (session.status === SESSION_CLOSED) return this.#summary(session);
    const closedEvent = this.#append(session, {
      type: 'session.closed',
      message: '语音会话已关闭。',
    });
    session.status = SESSION_CLOSED;
    session.closedAt = this.now().toISOString();
    const end = {
      reason: 'closed',
      cursor: session.events.nextCursor,
      event: closedEvent,
    };
    for (const listener of [...session.listeners]) listener.end(end);
    session.listeners.clear();
    return this.#summary(session);
  }

  subscribeEvents(sessionId, { after = 0, onEvent = () => {}, onEnd = () => {} } = {}) {
    const session = this.#requireSession(sessionId);
    if (typeof onEvent !== 'function' || typeof onEnd !== 'function') {
      throw new VoiceControlError('invalid_subscription', 'onEvent and onEnd must be functions', {
        status: 400,
      });
    }
    let lastCursor = parseCursor(after, 'after');
    const delivered = new Set();
    const deliver = (event) => {
      if (delivered.has(event.eventId) || Number(event.cursor) <= lastCursor) return;
      delivered.add(event.eventId);
      lastCursor = Number(event.cursor);
      onEvent(event);
    };

    for (const event of session.events.after(lastCursor)) deliver(event);
    if (session.status === SESSION_CLOSED) {
      return {
        closed: true,
        nextCursor: session.events.nextCursor,
        unsubscribe() {},
      };
    }

    const listener = {
      deliver,
      end(payload) {
        onEnd(payload);
      },
    };
    session.listeners.add(listener);
    return {
      closed: false,
      nextCursor: String(lastCursor),
      unsubscribe() {
        session.listeners.delete(listener);
      },
    };
  }

  getTriggerConfig() {
    return {
      config: this.triggerConfigStore.snapshot(),
      taskControlAvailable: false,
    };
  }

  replaceTriggerConfig(value) {
    return {
      config: this.triggerConfigStore.replace(value),
      taskControlAvailable: false,
    };
  }

  dispatchTrigger(triggerId, input = {}) {
    const config = this.triggerConfigStore.snapshot();
    const trigger = config.triggers.find((item) => item.id === triggerId);
    if (!trigger || !trigger.enabled) {
      throw new VoiceControlError(
        'trigger_not_configured',
        'External triggers are disabled until explicitly configured',
        { status: 409 },
      );
    }
    const topic = requiredString(input.topic, 'topic');
    if (!trigger.topics.includes(topic)) {
      throw new VoiceControlError(
        'trigger_topic_not_subscribed',
        `Trigger ${trigger.id} is not subscribed to ${topic}`,
        { status: 409 },
      );
    }
    const sessionId = requiredString(input.sessionId, 'sessionId');
    const noticeId = requiredString(input.noticeId, 'noticeId');
    const eventId = input.eventId === undefined ? null : requiredString(input.eventId, 'eventId');
    const dedupeKey = input.dedupeKey === undefined
      ? (eventId ? `${trigger.id}:${eventId}` : null)
      : input.dedupeKey;
    return this.#append(this.#requireSession(sessionId), {
      type: 'trigger',
      text: input.text,
      noticeId,
      dedupeKey,
      topic,
    });
  }

  health() {
    const config = this.triggerConfigStore.snapshot();
    const openSessions = [...this.sessions.values()].filter(
      (session) => session.status === SESSION_OPEN,
    ).length;
    const enabledTriggers = config.triggers.filter((trigger) => trigger.enabled).length;
    return {
      ok: true,
      name: 'voice-control',
      version: VOICE_CONTROL_VERSION,
      status: 'healthy',
      lifecycle: {
        installed: true,
        configured: this.triggerConfigStore.loaded,
        healthy: true,
        paired: false,
        subscribed: enabledTriggers > 0,
        active: openSessions > 0,
      },
      taskControlAvailable: false,
      sessions: {
        total: this.sessions.size,
        open: openSessions,
      },
      triggers: {
        total: config.triggers.length,
        enabled: enabledTriggers,
      },
    };
  }

  #append(session, eventInput) {
    this.#assertOpen(session);
    const result = session.events.append(eventInput);
    if (!result.duplicate) {
      for (const listener of session.listeners) listener.deliver(result.event);
    }
    return result;
  }

  #assertOpen(session) {
    if (session.status !== SESSION_OPEN) {
      throw new VoiceControlError('session_closed', 'Voice session is already closed', {
        status: 409,
      });
    }
  }

  #requireSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new VoiceControlError('session_not_found', 'Voice session not found', { status: 404 });
    }
    return session;
  }

  #summary(session) {
    return {
      id: session.id,
      title: session.title,
      status: session.status,
      createdAt: session.createdAt,
      closedAt: session.closedAt,
      nextCursor: session.events ? session.events.nextCursor : '0',
    };
  }
}
