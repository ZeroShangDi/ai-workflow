import crypto from 'node:crypto';

export const WS_PROTOCOL_VERSION = 1;
export const WS_MAX_MESSAGE_BYTES = 1024 * 1024;
export const WS_MAX_TOPICS = 100;

const TOPIC_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*(?:\.\*)?$/;

export function requireWsString(value, field, maximum = 4096) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  const text = value.trim();
  if (text.length > maximum) throw new Error(`${field} is too long`);
  return text;
}

export function normalizeTopics(value) {
  if (!Array.isArray(value) || !value.length || value.length > WS_MAX_TOPICS) {
    throw new Error(`topics must contain 1-${WS_MAX_TOPICS} entries`);
  }
  const topics = [...new Set(value.map((topic) => requireWsString(topic, 'topic', 256)))];
  for (const topic of topics) {
    if (!TOPIC_PATTERN.test(topic)) throw new Error(`invalid topic: ${topic}`);
  }
  return topics;
}

export function topicMatches(subscription, topic) {
  if (subscription === topic) return true;
  return subscription.endsWith('.*') && topic.startsWith(subscription.slice(0, -1));
}

export function normalizeEvent(value, { source = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('event must be an object');
  if (value.schemaVersion !== 1) throw new Error('event.schemaVersion must be 1');
  const topic = requireWsString(value.topic, 'event.topic', 256);
  if (!TOPIC_PATTERN.test(topic) || topic.endsWith('.*')) throw new Error('event.topic is invalid');
  const eventSource = requireWsString(value.source, 'event.source', 128);
  if (source && eventSource !== source) throw new Error('event.source does not match the authenticated client');
  const payload = value.payload === undefined ? {} : value.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('event.payload must be an object');
  }
  const encodedPayload = JSON.stringify(payload);
  if (Buffer.byteLength(encodedPayload) > WS_MAX_MESSAGE_BYTES / 2) {
    throw new Error('event.payload is too large');
  }
  return {
    schemaVersion: 1,
    eventId: typeof value.eventId === 'string' && value.eventId.trim()
      ? requireWsString(value.eventId, 'event.eventId', 256)
      : `evt_${crypto.randomUUID()}`,
    correlationId: value.correlationId === undefined || value.correlationId === null
      ? null
      : requireWsString(value.correlationId, 'event.correlationId', 256),
    topic,
    source: eventSource,
    createdAt: typeof value.createdAt === 'string' && !Number.isNaN(Date.parse(value.createdAt))
      ? value.createdAt
      : new Date().toISOString(),
    payload,
  };
}

export function eventForDelivery(event, cursor) {
  return { ...event, cursor: String(cursor) };
}
