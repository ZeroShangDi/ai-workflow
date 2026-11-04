import { randomUUID } from 'node:crypto';

import { VoiceControlError } from './errors.mjs';

export const EVENT_SCHEMA_VERSION = 1;
export const TRANSCRIPT_ROLES = new Set(['user', 'assistant', 'system']);
export const ACTIVITY_STATES = new Set(['listening', 'thinking', 'speaking', 'working']);
export const VOICE_STATES = new Set([...ACTIVITY_STATES, 'warning', 'error', 'idle']);
export const VOICE_EVENT_NAMES = new Set([
  'user_started',
  'user_stopped',
  'bot_started',
  'bot_stopped',
]);
export const DELIVERY_STATUSES = new Set(['spoken', 'interrupted', 'failed']);

const TEXT_LIMIT = 6000;
const MESSAGE_LIMIT = 1000;
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/;
const TOPIC_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/;

export function parseCursor(value, field = 'cursor') {
  if (value === undefined || value === null || value === '') return 0;
  const text = String(value);
  if (!/^\d+$/.test(text)) {
    throw new VoiceControlError('invalid_cursor', `${field} must be a non-negative integer`, {
      status: 400,
    });
  }
  const cursor = Number(text);
  if (!Number.isSafeInteger(cursor)) {
    throw new VoiceControlError('invalid_cursor', `${field} is too large`, { status: 400 });
  }
  return cursor;
}

function boundedText(value, { field = 'text', max = TEXT_LIMIT, required = true } = {}) {
  if (value === undefined || value === null) {
    if (!required) return null;
    throw new VoiceControlError('invalid_text', `${field} must be a non-empty string`, {
      status: 400,
    });
  }
  if (typeof value !== 'string') {
    throw new VoiceControlError('invalid_text', `${field} must be a string`, { status: 400 });
  }
  const text = value.trim();
  if (required && !text) {
    throw new VoiceControlError('invalid_text', `${field} must be a non-empty string`, {
      status: 400,
    });
  }
  if (text.length > max) {
    throw new VoiceControlError('invalid_text', `${field} must be at most ${max} characters`, {
      status: 400,
    });
  }
  return text || null;
}

function optionalKey(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 500) {
    throw new VoiceControlError('invalid_dedupe_key', `${field} must be at most 500 characters`, {
      status: 400,
    });
  }
  return value;
}

function enumValue(value, allowed, field) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new VoiceControlError('invalid_event_state', `${field} is invalid`, {
      status: 400,
      details: { allowed: [...allowed] },
    });
  }
  return value;
}

function normalizeEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new VoiceControlError('invalid_event', 'event must be an object', { status: 400 });
  }
  if (typeof input.type !== 'string' || !EVENT_TYPE_PATTERN.test(input.type)) {
    throw new VoiceControlError('invalid_event_type', 'type is invalid', { status: 400 });
  }
  const base = {
    type: input.type,
    role: null,
    source: 'system',
    state: null,
    event: null,
    message: null,
    text: null,
    topic: null,
    noticeId: null,
    dedupeKey: optionalKey(input.dedupeKey, 'dedupeKey'),
  };

  if (input.type === 'transcript') {
    const role = enumValue(input.role, TRANSCRIPT_ROLES, 'role');
    return {
      ...base,
      role,
      source: role,
      text: boundedText(input.text),
    };
  }
  if (input.type === 'activity') {
    return {
      ...base,
      state: enumValue(input.state, ACTIVITY_STATES, 'state'),
    };
  }
  if (input.type === 'voice') {
    const event = input.event === undefined || input.event === null
      ? null
      : enumValue(input.event, VOICE_EVENT_NAMES, 'event');
    return {
      ...base,
      state: enumValue(input.state, VOICE_STATES, 'state'),
      event,
      message: boundedText(input.message, {
        field: 'message',
        max: MESSAGE_LIMIT,
        required: false,
      }),
    };
  }
  if (input.type === 'trigger') {
    if (typeof input.topic !== 'string' || !TOPIC_PATTERN.test(input.topic)) {
      throw new VoiceControlError('invalid_topic', 'topic is invalid', { status: 400 });
    }
    return {
      ...base,
      topic: input.topic,
      noticeId: optionalKey(input.noticeId, 'noticeId'),
      text: boundedText(input.text),
    };
  }
  if (input.type === 'delivery') {
    const noticeId = optionalKey(input.noticeId, 'noticeId');
    if (!noticeId) {
      throw new VoiceControlError('invalid_notice_id', 'noticeId is required', { status: 400 });
    }
    return {
      ...base,
      noticeId,
      state: enumValue(input.status, DELIVERY_STATUSES, 'status'),
      message: boundedText(input.message, {
        field: 'message',
        max: MESSAGE_LIMIT,
        required: false,
      }),
    };
  }
  if (input.type === 'session.opened' || input.type === 'session.closed') {
    return {
      ...base,
      state: 'idle',
      message: boundedText(input.message, {
        field: 'message',
        max: MESSAGE_LIMIT,
        required: false,
      }),
    };
  }
  throw new VoiceControlError('invalid_event_type', `Unsupported event type: ${input.type}`, {
    status: 400,
  });
}

export class SessionEventLog {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.events = [];
    this.byId = new Map();
    this.byDedupeKey = new Map();
    this.sequence = 0;
  }

  append(input) {
    const normalized = normalizeEvent(input);
    if (normalized.dedupeKey && this.byDedupeKey.has(normalized.dedupeKey)) {
      return { event: this.byDedupeKey.get(normalized.dedupeKey), duplicate: true };
    }
    this.sequence += 1;
    const event = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: `evt_${randomUUID()}`,
      cursor: String(this.sequence),
      sessionId: this.sessionId,
      ...normalized,
      createdAt: new Date().toISOString(),
    };
    this.events.push(event);
    this.byId.set(event.eventId, event);
    if (event.dedupeKey) this.byDedupeKey.set(event.dedupeKey, event);
    return { event, duplicate: false };
  }

  after(cursor) {
    const after = parseCursor(cursor);
    return this.events.filter((event) => Number(event.cursor) > after);
  }

  get nextCursor() {
    return String(this.sequence);
  }
}

export function serializeSseEvent(event) {
  return `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
