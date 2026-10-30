# Event Protocol

## Envelope

Every Hub event uses one versioned envelope:

```json
{
  "schemaVersion": 1,
  "eventId": "evt_...",
  "cursor": "42",
  "publishedAt": "2026-10-30T03:00:00.000Z",
  "source": "bridge-control",
  "scope": {
    "tenantId": "...",
    "userId": "...",
    "deviceId": "...",
    "sessionId": "...",
    "workId": "..."
  },
  "topic": "interaction.requested",
  "correlationId": "...",
  "causationId": "...",
  "dedupeKey": "...",
  "expiresAt": null,
  "payload": {}
}
```

`cursor` is allocated by the Hub. Producers do not invent cursors.

## Topics

Control and work:

- `task.create_requested`
- `task.created`
- `task.progress`
- `task.completed`
- `task.failed`
- `task.interrupted`
- `task.stopped`
- `interaction.requested`
- `interaction.answered`
- `artifact.ready`

Voice delivery:

- `voice.session_opened`
- `voice.session_closed`
- `voice.announcement_queued`
- `voice.announcement_started`
- `voice.announcement_spoken`
- `voice.announcement_interrupted`
- `voice.announcement_failed`

## State versus Delivery

Task state and playback state are separate.

Task state:

```text
accepted -> running -> waiting_input | waiting_approval -> completed | failed | interrupted
```

Delivery state:

```text
queued -> speaking -> spoken | interrupted | failed
```

Do not set delivery to `spoken` for the same event that creates an assistant transcript. Only the host's audio-stop observation may mark playback complete.

## Subscription

A subscription binds a consumer to topics and filters:

```json
{
  "id": "voice-default",
  "consumer": "voice-control",
  "topics": ["task.completed", "task.failed", "interaction.requested", "artifact.ready"],
  "filters": {
    "workId": "*",
    "priority": ["normal", "high"]
  },
  "delivery": {
    "mode": "idle",
    "dedupe": "eventId",
    "ackRequired": true
  }
}
```

Installing a consumer does not create subscriptions. Pairing and subscription configuration are explicit.

## Cursor and Replay

- `bridge_chat_events` accepts `after` and returns `nextCursor`.
- Consumers process events in cursor order.
- A gap or invalid cursor returns a resync response; it must not silently skip events.
- Ack is per delivery, not per producer.
- Reconnect starts after the last acknowledged delivery cursor.

## Idempotency

- Writes use a caller-generated idempotency key.
- The same key and payload returns the prior receipt.
- The same key with different content is rejected.
- A timed-out response is `unknown`; callers reconcile state before retrying.

## Dedupe

`eventId` is globally unique. `dedupeKey` is producer-scoped and used for semantic deduplication, such as one completion per work sequence.

The Hub must not use message text as identity.

## Retention

- Event metadata is durable.
- Sensitive payload fields are allowlisted.
- Raw audio is never stored in the event store.
- Transcript retention is configured in `voice-control`, not inferred by the Hub.
