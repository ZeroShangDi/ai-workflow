import crypto from 'node:crypto';
import path from 'node:path';

import { HubError } from './errors.mjs';
import { AtomicJsonStore } from './storage.mjs';
import { cloneJson, isoNow, requireText } from './util.mjs';

const TERMINAL = new Set(['spoken', 'interrupted', 'failed']);

function inboxId(value) {
  return requireText(value, 'deliveryId', 128);
}

export class DeliveryInbox {
  constructor({ dataDir = null } = {}) {
    this.store = new AtomicJsonStore(
      dataDir ? path.join(dataDir, 'inbox.json') : null,
      { deliveries: {} },
    );
  }

  enqueue({
    event,
    consumer,
    ackRequired = true,
  }) {
    if (!event?.eventId) {
      throw new HubError(400, 'invalid_request', 'event is required for delivery');
    }
    const consumerId = requireText(consumer, 'consumer', 128);
    const data = this.store.read();
    const duplicate = Object.values(data.deliveries).find(
      (item) => item.consumer === consumerId && item.dedupeKey === event.dedupeKey,
    );
    if (duplicate) return { delivery: cloneJson(duplicate), duplicate: true };

    const record = {
      deliveryId: `dlv_${crypto.randomUUID()}`,
      consumer: consumerId,
      eventId: event.eventId,
      cursor: event.cursor,
      topic: event.topic,
      dedupeKey: event.dedupeKey,
      status: 'queued',
      ackRequired: ackRequired !== false,
      scope: cloneJson(event.scope || {}),
      payload: cloneJson(event.payload || {}),
      queuedAt: isoNow(),
      startedAt: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      outcome: null,
      error: null,
    };
    data.deliveries[record.deliveryId] = record;
    this.store.write(data);
    return { delivery: cloneJson(record), duplicate: false };
  }

  get(id) {
    return cloneJson(this.store.read().deliveries[inboxId(id)] || null);
  }

  list({ consumer, status } = {}) {
    return Object.values(this.store.read().deliveries)
      .filter((item) => !consumer || item.consumer === consumer)
      .filter((item) => !status || item.status === status)
      .map(cloneJson);
  }

  start(id, { consumer }) {
    const key = inboxId(id);
    const consumerId = requireText(consumer, 'consumer', 128);
    const data = this.store.read();
    const record = data.deliveries[key];
    if (!record) throw new HubError(404, 'delivery_not_found', 'delivery does not exist');
    if (record.consumer !== consumerId) {
      throw new HubError(403, 'consumer_mismatch', 'delivery belongs to another consumer');
    }
    if (record.status !== 'queued') {
      throw new HubError(409, 'delivery_transition_invalid', `cannot start a ${record.status} delivery`);
    }
    record.status = 'speaking';
    record.startedAt = isoNow();
    data.deliveries[key] = record;
    this.store.write(data);
    return cloneJson(record);
  }

  acknowledge(id, {
    consumer,
    outcome,
    playbackObserved,
    error = null,
  }) {
    const key = inboxId(id);
    const consumerId = requireText(consumer, 'consumer', 128);
    if (!TERMINAL.has(outcome)) {
      throw new HubError(400, 'invalid_request', 'outcome must be spoken, interrupted, or failed');
    }
    if (outcome !== 'failed' && playbackObserved !== true) {
      throw new HubError(
        400,
        'playback_observation_required',
        'acknowledgement requires playbackObserved=true from the consumer',
      );
    }
    if (outcome === 'failed' && !String(error || '').trim()) {
      throw new HubError(400, 'invalid_request', 'failed acknowledgement requires an error');
    }
    const data = this.store.read();
    const record = data.deliveries[key];
    if (!record) throw new HubError(404, 'delivery_not_found', 'delivery does not exist');
    if (record.consumer !== consumerId) {
      throw new HubError(403, 'consumer_mismatch', 'only the delivery consumer may acknowledge it');
    }
    if (TERMINAL.has(record.status)) {
      if (record.status === outcome && record.acknowledgedBy === consumerId) {
        return cloneJson(record);
      }
      throw new HubError(409, 'delivery_ack_conflict', 'delivery is already acknowledged');
    }
    if (record.status !== 'queued' && record.status !== 'speaking') {
      throw new HubError(409, 'delivery_transition_invalid', `cannot acknowledge a ${record.status} delivery`);
    }
    record.status = outcome;
    record.outcome = outcome;
    record.acknowledgedAt = isoNow();
    record.acknowledgedBy = consumerId;
    record.error = outcome === 'failed' ? String(error).slice(0, 2000) : null;
    data.deliveries[key] = record;
    this.store.write(data);
    return cloneJson(record);
  }
}
