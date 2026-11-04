import path from 'node:path';

import { HubError } from './errors.mjs';
import { JsonLinesStore } from './storage.mjs';
import {
  assertObject,
  boundedInteger,
  canonicalJson,
  cloneJson,
  isoNow,
  requireText,
  sha256,
} from './util.mjs';

const TOPIC = /^[a-z][a-z0-9_.-]{0,127}$/;
const SECRET_KEYS = new Set([
  'authorization',
  'cookie',
  'password',
  'passphrase',
  'secret',
  'apikey',
  'api_key',
  'access_token',
  'refresh_token',
  'private_key',
]);

function assertNoCredentialFields(value, location = 'payload') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentialFields(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.has(key.toLowerCase())) {
      throw new HubError(
        400,
        'credential_payload_rejected',
        `${location}.${key} looks like a credential and cannot be stored in an event`,
      );
    }
    assertNoCredentialFields(item, `${location}.${key}`);
  }
}

function normalizeScope(scope) {
  const value = assertObject(scope || {}, 'scope');
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (typeof item !== 'string' && item !== null) {
      throw new HubError(400, 'invalid_request', `scope.${key} must be a string or null`);
    }
    output[key] = item;
  }
  return output;
}

function normalizeEventInput(input) {
  const source = requireText(input.source || 'bridge-hub', 'source', 128);
  const topic = requireText(input.topic, 'topic', 128);
  if (!TOPIC.test(topic)) {
    throw new HubError(400, 'invalid_request', 'topic contains unsupported characters');
  }
  const scope = normalizeScope(input.scope);
  const payload = assertObject(input.payload || {}, 'payload');
  assertNoCredentialFields(payload);
  const dedupeKey = requireText(input.dedupeKey, 'dedupeKey', 512);
  const normalized = {
    schemaVersion: 1,
    source,
    topic,
    scope,
    payload: cloneJson(payload),
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    dedupeKey,
    expiresAt: input.expiresAt ?? null,
  };
  return {
    ...normalized,
    fingerprint: sha256(canonicalJson(normalized)),
  };
}

function publicEvent(record) {
  return cloneJson(record.event);
}

export class EventStore {
  constructor({ dataDir = null } = {}) {
    this.filePath = dataDir ? path.join(dataDir, 'events.jsonl') : null;
    this.storage = new JsonLinesStore(this.filePath);
    this.records = [];
    this.byEventId = new Map();
    this.byDedupeKey = new Map();
    this.#load();
  }

  #load() {
    for (const row of this.storage.readAll()) {
      this.#index(row);
    }
  }

  #index(record) {
    if (!record?.event?.eventId || !record?.event?.cursor || !record?.fingerprint) {
      throw new HubError(500, 'store_corrupt', 'event store contains an invalid record');
    }
    if (this.byEventId.has(record.event.eventId)) {
      throw new HubError(500, 'store_corrupt', 'event store contains a duplicate eventId');
    }
    const expectedCursor = String(this.records.length + 1);
    if (record.event.cursor !== expectedCursor) {
      throw new HubError(500, 'store_corrupt', 'event cursors are not contiguous');
    }
    this.records.push(record);
    this.byEventId.set(record.event.eventId, record);
    this.byDedupeKey.set(`${record.event.source}\0${record.event.dedupeKey}`, record);
  }

  get lastCursor() {
    return this.records.length;
  }

  append(input) {
    const normalized = normalizeEventInput(assertObject(input, 'event'));
    const dedupeIdentity = `${normalized.source}\0${normalized.dedupeKey}`;
    const duplicate = this.byDedupeKey.get(dedupeIdentity);
    if (duplicate) {
      if (duplicate.fingerprint !== normalized.fingerprint) {
        throw new HubError(
          409,
          'dedupe_conflict',
          'dedupeKey was already used with different event content',
        );
      }
      return { event: publicEvent(duplicate), duplicate: true };
    }

    const eventId = `evt_${sha256(`${normalized.source}\0${normalized.dedupeKey}`).slice(0, 32)}`;
    if (this.byEventId.has(eventId)) {
      throw new HubError(409, 'event_id_conflict', 'stable eventId already exists');
    }
    const record = {
      fingerprint: normalized.fingerprint,
      event: {
        schemaVersion: 1,
        eventId,
        cursor: String(this.records.length + 1),
        publishedAt: isoNow(),
        source: normalized.source,
        scope: normalized.scope,
        topic: normalized.topic,
        correlationId: normalized.correlationId,
        causationId: normalized.causationId,
        dedupeKey: normalized.dedupeKey,
        expiresAt: normalized.expiresAt,
        payload: normalized.payload,
      },
    };
    this.storage.append(record);
    this.#index(record);
    return { event: publicEvent(record), duplicate: false };
  }

  read({
    after = '0',
    limit = 100,
    topics = null,
  } = {}) {
    if (!/^(0|[1-9][0-9]*)$/.test(String(after))) {
      throw new HubError(409, 'cursor_resync', 'invalid event cursor');
    }
    const cursor = Number(after);
    if (cursor > this.records.length) {
      throw new HubError(409, 'cursor_resync', 'event cursor is ahead of the retained log', {
        lastCursor: String(this.records.length),
      });
    }
    const size = boundedInteger(limit, {
      fallback: 100,
      minimum: 1,
      maximum: 500,
      field: 'limit',
    });
    const topicSet = Array.isArray(topics) && topics.length ? new Set(topics) : null;
    const scanned = this.records
      .slice(cursor, cursor + size)
      .map(publicEvent);
    const events = scanned.filter((event) => !topicSet || topicSet.has(event.topic));
    return {
      events,
      nextCursor: scanned.length ? scanned.at(-1).cursor : String(cursor),
      lastCursor: String(this.records.length),
    };
  }

  get(eventId) {
    const record = this.byEventId.get(eventId);
    return record ? publicEvent(record) : null;
  }
}
