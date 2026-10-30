# Bridge Hub

`bridge-hub` is the first backend slice for Codex Control. It connects to
Codex Mobile Bridge (CMB) through CMB's public HTTP and SSE contracts and does
not import CMB source code.

The package has no third-party runtime dependencies and requires Node.js 22 or
newer.

## Run

1. Copy `config.example.json` to `config.json`.
2. Set `cmb.baseUrl` and `cmb.username`.
3. Put the CMB password in a private file and set `cmb.passwordFile`, or use
   `BRIDGE_HUB_CMB_PASSWORD`.
4. Start the service:

```bash
npm start
```

Use `node src/server.mjs --config /absolute/path/to/config.json` for another
configuration file.

When the listener is not loopback-only, `BRIDGE_HUB_API_TOKEN` is required.
All routes except `GET /health` then require
`Authorization: Bearer <token>`.

The password can be supplied as:

```text
BRIDGE_HUB_CMB_PASSWORD
BRIDGE_HUB_CMB_PASSWORD_FILE
```

The API token can be supplied as:

```text
BRIDGE_HUB_API_TOKEN
BRIDGE_HUB_API_TOKEN_FILE
```

Credentials are never accepted in URLs, included in status responses, written
to event payloads, or returned through the API.

## Lifecycle

Installing a consumer does not subscribe or activate it. The Hub exposes the
following derived chain:

```text
installed -> configured -> healthy -> paired -> subscribed -> active
```

Consumers must be paired before a subscription can be registered. Event
delivery remains disabled when no subscription exists.

## Persistence

The configured `dataDir` contains:

- `events.jsonl`: append-only event envelopes;
- `trust.json`: lifecycle facts and pairing state;
- `subscriptions.json`: explicit consumer subscriptions;
- `bindings.json`: control, work, and voice session bindings;
- `control.json`: bounded real-user transcripts, work state, and pending interactions;
- `inbox.json`: durable delivery state;
- `idempotency.json`: write receipts and unreconciled `unknown` results.

No raw audio is stored.

## HTTP API

### Health and status

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Process health and current event cursor |
| `GET` | `/api/status` | Hub, consumer, subscription, CMB, and voice status |

### Events

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/events` | Append a producer event |
| `GET` | `/api/events?after=<cursor>&limit=<n>` | Read from an exclusive cursor |
| `GET` | `/api/events?...&topic=<topic>&consumer=<id>` | Read through an active subscription |

An invalid or future cursor returns `409 cursor_resync`; it is never silently
skipped. Event IDs are stable, cursors are Hub allocated, and producer
`dedupeKey` values are scoped by `source`.

### Trust and subscriptions

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/trust` | List lifecycle states |
| `GET` | `/api/trust/:consumer` | Read one lifecycle state |
| `PATCH` | `/api/trust/:consumer` | Set `installed`, `configured`, or `healthy` |
| `POST` | `/api/trust/:consumer/pair` | Pair with `{ "confirmed": true }` |
| `DELETE` | `/api/trust/:consumer/pair` | Remove pairing |
| `GET` | `/api/subscriptions` | List subscriptions |
| `POST` | `/api/subscriptions` | Register an explicit subscription |
| `DELETE` | `/api/subscriptions/:id` | Remove a subscription |

### Session binding

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/bindings` | Bind control, work, and voice sessions |
| `GET` | `/api/bindings` | Query bindings by session ID |
| `GET` | `/api/bindings/:id` | Read one binding |

### Durable delivery

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/inbox` | Queue an event for an active consumer |
| `GET` | `/api/inbox` | Read by consumer or status |
| `POST` | `/api/inbox/:id/start` | Move `queued` to `speaking` |
| `POST` | `/api/inbox/:id/ack` | Explicit consumer playback receipt |

Acknowledged outcomes are `spoken`, `interrupted`, or `failed`. The consumer
must match the delivery owner and must include `playbackObserved: true`.

### CMB public adapter

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/cmb/status` | Authenticated CMB instance status |
| `GET` | `/api/cmb/sessions` | List sessions |
| `GET` | `/api/cmb/sessions/:id` | Read a session view |
| `POST` | `/api/cmb/sessions/:id/send` | Send a message |
| `GET` | `/api/cmb/sessions/:id/events` | Proxy the CMB SSE stream |

CMB sends require an active control consumer and an `Idempotency-Key` header or
`idempotencyKey` body field. The same key and request return the stored receipt.
The same key with different content returns `409 idempotency_conflict`.

A timeout, disconnected write, or upstream 5xx is returned as `unknown`. The
result must be reconciled by reading CMB state. The Hub never automatically
replays an unknown or failed write.

### Control protocol

The internal control plugin connects through the same token-protected Hub API.
Set:

```text
BRIDGE_HUB_URL
BRIDGE_HUB_API_TOKEN
BRIDGE_CONTROL_CONSUMER
BRIDGE_VOICE_CONSUMER
BRIDGE_CONTROL_TIMEOUT_MS
BRIDGE_CONTROL_HUB_MODULE=/absolute/path/to/bridge-hub/src/control-client.mjs
```

The host posts final real user speech to `POST /api/v1/transcripts` before
asking the control plugin to confirm or resolve an interaction. The Hub reads
that persisted transcript again; the model cannot supply authorization text.
Create work additionally requires the same affirmative transcript to be the
newest stored turn, and consumes it once so it cannot authorize two drafts.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/transcripts` | Persist one final real user transcript |
| `GET` | `/api/v1/chat/latest-user-transcript` | Read the newest transcript |
| `POST` | `/api/v1/chat/work/create` | Create a CMB session from a confirmed draft |
| `GET` | `/api/v1/chat/work/find` | Find local or CMB work |
| `GET` | `/api/v1/chat/work/status` | Merge work, CMB, and pending state |
| `POST` | `/api/v1/chat/work/send` | Send, queue, or steer a message |
| `GET` | `/api/v1/chat/work/read` | Read history or Hub activity |
| `GET` | `/api/v1/chat/events` | Read subscribed events after a cursor |
| `POST` | `/api/v1/chat/work/answer` | Resolve a bound question |
| `POST` | `/api/v1/chat/work/approve` | Resolve a bound approval |
| `POST` | `/api/v1/chat/work/stop` | Stop a work session |
| `POST` | `/api/v1/chat/work/progress` | Report bounded work progress |
| `POST` | `/api/v1/chat/work/request-input` | Create a pending question |
| `POST` | `/api/v1/chat/work/request-approval` | Create a pending approval |
| `POST` | `/api/v1/chat/work/artifact` | Register an artifact reference |
| `POST` | `/api/v1/chat/work/finish` | Record a terminal outcome |
| `POST` | `/api/v1/chat/announcement/ack` | Record an observed playback outcome |

Approval and answer writes verify both the immutable interaction binding and
the newest persisted user transcript. Unknown external writes remain
unreconciled and are never retried automatically.

## Voice boundary

`src/voice-client.mjs` is an optional public HTTP protocol client. It imports no
voice-control implementation and is not required for the Hub's CMB, event,
subscription, binding, or inbox functionality. Trigger dispatch stays disabled
unless both `voice.baseUrl` and an explicit `voice.triggerId` are configured.

## Test

```bash
npm test
```

The suite starts a local mock CMB over HTTP/SSE and verifies public adapter
contracts, cursor replay, subscription default-off behavior, pairing
requirements, persisted transcript authorization, idempotency, unknown writes,
inbox acknowledgement, authenticated Hub routes, and dependency isolation.
