import path from 'node:path';

import { BindingStore } from './bindings.mjs';
import { CmbAdapter } from './cmb-adapter.mjs';
import { ConsumerRegistry } from './consumer-registry.mjs';
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

function subscriptionAckRequired(registry, consumer, event) {
  const matches = registry.matchingSubscriptions(consumer, event);
  return matches.length === 0 || matches.some((item) => item.delivery.ackRequired);
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

  sendMessage({
    consumer,
    sessionId,
    idempotencyKey,
    message,
  }) {
    const state = this.consumers.get(consumer);
    if (!state.active) {
      throw new HubError(403, 'subscription_required', 'control consumer is not active');
    }
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
