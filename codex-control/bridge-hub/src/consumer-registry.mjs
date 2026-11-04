import path from 'node:path';

import { HubError } from './errors.mjs';
import { AtomicJsonStore } from './storage.mjs';
import {
  assertObject,
  cloneJson,
  isoNow,
  requireText,
} from './util.mjs';

const FACT_KEYS = new Set(['installed', 'configured', 'healthy']);

function consumerId(value) {
  const id = requireText(value, 'consumer', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    throw new HubError(400, 'invalid_request', 'consumer contains unsupported characters');
  }
  return id;
}

function subscriptionId(value) {
  const id = requireText(value, 'subscription.id', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    throw new HubError(400, 'invalid_request', 'subscription.id contains unsupported characters');
  }
  return id;
}

function normalizeTopics(value) {
  if (!Array.isArray(value) || !value.length || value.length > 64) {
    throw new HubError(400, 'invalid_request', 'subscription topics must contain 1-64 entries');
  }
  return [...new Set(value.map((item) => requireText(item, 'subscription.topic', 128)))];
}

function normalizeFilters(value) {
  if (value === undefined) return {};
  const filters = assertObject(value, 'subscription.filters');
  if (JSON.stringify(filters).length > 16384) {
    throw new HubError(400, 'invalid_request', 'subscription filters are too large');
  }
  return cloneJson(filters);
}

function normalizeDelivery(value) {
  const delivery = value === undefined ? {} : assertObject(value, 'subscription.delivery');
  return {
    mode: delivery.mode || 'idle',
    dedupe: delivery.dedupe || 'eventId',
    ackRequired: delivery.ackRequired !== false,
  };
}

function lookup(event, key) {
  if (key in (event.scope || {})) return event.scope[key];
  if (key in (event.payload || {})) return event.payload[key];
  if (key in event) return event[key];
  const path = key.split('.');
  let value = event;
  for (const part of path) {
    if (!value || typeof value !== 'object' || !(part in value)) return undefined;
    value = value[part];
  }
  return value;
}

function filterMatches(event, filters) {
  for (const [key, expected] of Object.entries(filters)) {
    if (expected === '*') continue;
    const actual = lookup(event, key);
    if (Array.isArray(expected)) {
      if (!expected.includes(actual)) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

export class ConsumerRegistry {
  constructor({ dataDir = null } = {}) {
    this.trustFile = dataDir ? path.join(dataDir, 'trust.json') : null;
    this.subscriptionFile = dataDir ? path.join(dataDir, 'subscriptions.json') : null;
    this.trust = new AtomicJsonStore(this.trustFile, { consumers: {} });
    this.subscriptionStore = new AtomicJsonStore(this.subscriptionFile, { subscriptions: {} });
  }

  #ensure(consumer) {
    const id = consumerId(consumer);
    const value = this.trust.read();
    if (!value.consumers[id]) {
      value.consumers[id] = {
        id,
        installed: false,
        configured: false,
        healthy: false,
        paired: false,
        updatedAt: isoNow(),
      };
      this.trust.write(value);
    }
    return id;
  }

  setFacts(consumer, facts) {
    const id = this.#ensure(consumer);
    const input = assertObject(facts, 'facts');
    const unsupported = Object.keys(input).filter((key) => !FACT_KEYS.has(key));
    if (unsupported.length) {
      throw new HubError(400, 'invalid_request', `unsupported trust facts: ${unsupported.join(', ')}`);
    }
    if (!Object.keys(input).length) {
      throw new HubError(400, 'invalid_request', 'at least one trust fact is required');
    }
    for (const [key, value] of Object.entries(input)) {
      if (typeof value !== 'boolean') {
        throw new HubError(400, 'invalid_request', `trust fact ${key} must be boolean`);
      }
    }
    const data = this.trust.read();
    const record = data.consumers[id];
    Object.assign(record, input);
    if (!record.installed) {
      record.configured = false;
      record.healthy = false;
      record.paired = false;
    } else if (!record.configured) {
      record.healthy = false;
      record.paired = false;
    } else if (!record.healthy) {
      record.paired = false;
    }
    record.updatedAt = isoNow();
    this.trust.write(data);
    return this.get(id);
  }

  pair(consumer, { confirmed = false } = {}) {
    const id = this.#ensure(consumer);
    if (confirmed !== true) {
      throw new HubError(400, 'pairing_confirmation_required', 'pairing requires explicit confirmation');
    }
    const data = this.trust.read();
    const record = data.consumers[id];
    if (!(record.installed && record.configured && record.healthy)) {
      throw new HubError(
        409,
        'pairing_precondition_failed',
        'consumer must be installed, configured, and healthy before pairing',
      );
    }
    record.paired = true;
    record.updatedAt = isoNow();
    this.trust.write(data);
    return this.get(id);
  }

  unpair(consumer) {
    const id = this.#ensure(consumer);
    const data = this.trust.read();
    data.consumers[id].paired = false;
    data.consumers[id].updatedAt = isoNow();
    this.trust.write(data);
    return this.get(id);
  }

  #subscriptionsFor(consumer) {
    const data = this.subscriptionStore.read();
    return Object.values(data.subscriptions).filter((item) => item.consumer === consumer);
  }

  get(consumer) {
    const id = consumerId(consumer);
    const record = this.trust.read().consumers[id] || {
      id,
      installed: false,
      configured: false,
      healthy: false,
      paired: false,
      updatedAt: null,
    };
    const subscriptions = this.#subscriptionsFor(id);
    const subscribed = subscriptions.length > 0;
    return {
      ...cloneJson(record),
      subscribed,
      active: Boolean(
        record.installed
        && record.configured
        && record.healthy
        && record.paired
        && subscribed
      ),
      subscriptionCount: subscriptions.length,
    };
  }

  list() {
    const ids = Object.keys(this.trust.read().consumers);
    return ids.map((id) => this.get(id));
  }

  addSubscription(input) {
    const subscription = assertObject(input, 'subscription');
    const id = subscriptionId(subscription.id);
    const consumer = consumerId(subscription.consumer);
    const state = this.get(consumer);
    if (!state.paired) {
      throw new HubError(
        409,
        'pairing_required',
        'consumer must be paired before an event subscription can be created',
      );
    }
    const normalized = {
      id,
      consumer,
      topics: normalizeTopics(subscription.topics),
      filters: normalizeFilters(subscription.filters),
      delivery: normalizeDelivery(subscription.delivery),
      createdAt: isoNow(),
    };
    const data = this.subscriptionStore.read();
    if (data.subscriptions[id]) {
      throw new HubError(409, 'subscription_exists', 'subscription id already exists');
    }
    data.subscriptions[id] = normalized;
    this.subscriptionStore.write(data);
    return cloneJson(normalized);
  }

  listSubscriptions(consumer = null) {
    const items = Object.values(this.subscriptionStore.read().subscriptions);
    return cloneJson(consumer ? items.filter((item) => item.consumer === consumerId(consumer)) : items);
  }

  getSubscription(id) {
    return cloneJson(this.subscriptionStore.read().subscriptions[subscriptionId(id)] || null);
  }

  removeSubscription(id) {
    const key = subscriptionId(id);
    const data = this.subscriptionStore.read();
    if (!data.subscriptions[key]) {
      throw new HubError(404, 'subscription_not_found', 'subscription does not exist');
    }
    delete data.subscriptions[key];
    this.subscriptionStore.write(data);
    return { deleted: true, id: key };
  }

  matchingSubscriptions(consumer, event) {
    return this.#subscriptionsFor(consumerId(consumer)).filter((subscription) => {
      const topicMatch = subscription.topics.includes('*') || subscription.topics.includes(event.topic);
      return topicMatch && filterMatches(event, subscription.filters);
    });
  }

  canConsume(consumer, event) {
    return this.get(consumer).active && this.matchingSubscriptions(consumer, event).length > 0;
  }
}
