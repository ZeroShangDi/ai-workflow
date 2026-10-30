import { randomUUID } from 'node:crypto';

import { VoiceControlError } from './errors.mjs';
import { parseCursor, SessionEventLog } from './events.mjs';

export const VOICE_CONTROL_VERSION = '0.2.0';

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
  constructor({
    triggerConfigStore,
    chatProvider = null,
    noticeStore = null,
    transcriptRecorder = null,
    now = () => new Date(),
    idFactory = () => randomUUID(),
  }) {
    if (!triggerConfigStore) throw new Error('triggerConfigStore is required');
    this.triggerConfigStore = triggerConfigStore;
    this.chatProvider = chatProvider;
    this.noticeStore = noticeStore;
    this.transcriptRecorder = transcriptRecorder;
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
    this.#deliverPendingNotices(session);
    return this.#summary(session);
  }

  getSession(sessionId) {
    return this.#summary(this.#requireSession(sessionId));
  }

  appendEvent(sessionId, input = {}) {
    const session = this.#requireSession(sessionId);
    this.#assertOpen(session);
    const result = this.#append(session, input);
    if (input?.type === 'delivery' && typeof input.noticeId === 'string') {
      this.noticeStore?.acknowledge(
        input.noticeId,
        input.status,
        typeof input.message === 'string' ? input.message : null,
      );
    }
    return result;
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

  async chat(sessionId, { text } = {}) {
    const session = this.#requireSession(sessionId);
    this.#assertOpen(session);
    const prompt = requiredString(text, 'text');
    if (prompt.length > 6000) {
      throw new VoiceControlError('invalid_request', 'text must be at most 6000 characters', {
        status: 400,
      });
    }
    if (!this.chatProvider?.configured) {
      throw new VoiceControlError(
        'chat_not_configured',
        'Configure VOICE_CONTROL_CHAT_URL and VOICE_CONTROL_CHAT_MODEL before using voice chat',
        { status: 503 },
      );
    }
    const turnId = `turn_${this.idFactory()}`;
    const userEvent = this.#append(session, {
      type: 'transcript',
      role: 'user',
      text: prompt,
      dedupeKey: `user:${turnId}`,
    }).event;
    this.transcriptRecorder?.({
      sessionId,
      turnId,
      text: prompt,
      createdAt: userEvent.createdAt,
    });
    this.#append(session, {
      type: 'activity',
      state: 'thinking',
      dedupeKey: `thinking:${turnId}`,
    });
    const history = session.events
      .after(0)
      .filter((event) => event.type === 'transcript' && ['user', 'assistant'].includes(event.role))
      .slice(-30)
      .map((event) => ({ role: event.role, content: event.text }));
    let assistant;
    try {
      assistant = await this.chatProvider.reply({
        messages: [
          {
            role: 'system',
            content: [
              '你是 Codex Control 的语音助手。',
              '回答简洁、直接，适合被立即朗读。',
              '不要声称执行了未实际执行的操作。',
              '需要创建或控制任务时，等待宿主工具的明确结果。',
            ].join(''),
          },
          ...history,
        ],
      });
    } catch (failure) {
      this.#append(session, {
        type: 'voice',
        state: 'warning',
        message: failure.message,
        dedupeKey: `chat-failed:${turnId}`,
      });
      throw new VoiceControlError(
        failure.code || 'chat_failed',
        failure.message || 'Voice chat failed',
        { status: 502, cause: failure },
      );
    }
    const assistantEvent = this.#append(session, {
      type: 'transcript',
      role: 'assistant',
      text: assistant,
      dedupeKey: `assistant:${turnId}`,
    }).event;
    this.#append(session, {
      type: 'activity',
      state: 'listening',
      dedupeKey: `listening:${turnId}`,
    });
    return { status: 'accepted', turnId, userEvent, assistantEvent };
  }

  acceptExternalEvent(input = {}) {
    if (!this.noticeStore) {
      throw new VoiceControlError(
        'notice_store_unavailable',
        'External task events are not configured',
        { status: 503 },
      );
    }
    const event = this.noticeStore.accept(input);
    const target = event.notice.sessionId
      ? this.sessions.get(event.notice.sessionId)
      : [...this.sessions.values()].reverse().find((session) => session.status === SESSION_OPEN);
    if (target?.status === SESSION_OPEN) this.#deliverNotice(target, event.notice);
    return {
      accepted: true,
      duplicate: event.duplicate,
      notice: this.noticeStore.get(event.notice.noticeId),
      deliveredSessionId: target?.status === SESSION_OPEN ? target.id : null,
    };
  }

  tunnel(input = {}) {
    if (input?.type === 'transcript') {
      const sessionId = requiredString(input.sessionId, 'sessionId');
      if (!['assistant', 'system'].includes(input.role)) {
        throw new VoiceControlError('invalid_request', 'tunnel transcripts must be assistant or system messages', {
          status: 400,
        });
      }
      return {
        accepted: true,
        event: this.appendTranscript(sessionId, {
          role: input.role,
          text: input.text,
          dedupeKey: input.dedupeKey || null,
        }).event,
      };
    }
    if (input?.type === 'voice' || input?.type === 'activity') {
      const sessionId = requiredString(input.sessionId, 'sessionId');
      return { accepted: true, event: this.appendEvent(sessionId, input).event };
    }
    return this.acceptExternalEvent(input);
  }

  listNotices({ sessionId = null } = {}) {
    return this.noticeStore?.pending({ sessionId }) || [];
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
    const notices = this.noticeStore?.summary() || { total: 0, pending: 0 };
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
      chat: {
        configured: this.chatProvider?.configured === true,
      },
      notices,
    };
  }

  #deliverPendingNotices(session) {
    if (!this.noticeStore) return;
    for (const notice of this.noticeStore.pending({ sessionId: session.id })) {
      this.#deliverNotice(session, notice);
    }
  }

  #deliverNotice(session, notice) {
    const result = this.#append(session, {
      type: 'trigger',
      text: notice.text,
      noticeId: notice.noticeId,
      eventId: notice.eventId,
      topic: notice.topic,
      dedupeKey: `notice:${notice.noticeId}`,
    });
    if (!result.duplicate) this.noticeStore?.markDelivered(notice.noticeId, session.id);
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
