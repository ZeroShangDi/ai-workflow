# Codex Control Architecture

## 1. Goal

Codex Control provides a voice-first control plane for external agent software.

The user should be able to:

- create and start work by speaking;
- answer missing-parameter questions in the same voice conversation;
- query progress and results;
- continue, queue, steer, or stop work;
- receive questions and approvals;
- approve, reject, or answer without opening a work page;
- hear completion, failure, and pending-action notices;
- reconnect without losing events or replaying writes.

The first external software is Codex Mobile Bridge (CMB). The architecture must also support other bridge software without copying the whole voice or message stack.

## 2. Components

### 2.1 `plugins/voice-control`

An independently installable, remotely deployable voice plugin.

It owns:

- microphone and WebRTC lifecycle;
- ASR and TTS provider integration;
- voice session state and interruption handling;
- audio playback arbitration;
- the voice page and minimal host SDK;
- generic voice event transport;
- external trigger subscriptions supplied by its host or integrator.

It does not own:

- CMB or other task-control APIs;
- work creation, status, approval, or task persistence;
- `bridge-hub`;
- `bridge-control` domain logic.

Local development and remote deployment use the same public API. Only transport, configuration, and authentication differ.

### 2.2 `plugins/bridge-control`

An internal capability plugin loaded by trusted hosts. It is not an ordinary globally exposed plugin.

It contains two runtime profiles:

- `voice-controller`: loaded only in the dedicated voice or app control conversation;
- `work-reporter`: loaded only in work sessions created by the controller.

`voice-controller` may create, find, inspect, continue, stop, read, answer, and approve work.

`work-reporter` may emit progress, request input, request approval, publish artifacts, and finish work. It must not create work, answer its own questions, approve itself, or subscribe to control events.

### 2.3 `bridge-hub`

The single deployable backend and integration layer.

It owns:

- CMB and future software adapters;
- plugin loading and capability registration;
- append-only event storage and cursor allocation;
- subscription and external-trigger registry;
- pairing, trust, tenant, user, and device scope;
- session binding between control, work, and voice conversations;
- durable inbox, delivery policy, deduplication, and acknowledgements;
- the public API/SSE/WebSocket surface used by trusted hosts.

It does not own microphone, ASR, TTS, audio playback, or voice-page rendering.

## 3. Dependency Rules

```text
bridge-hub        -> CMB and other external software
bridge-hub        -> bridge-control domain contracts
bridge-hub        -. optional public SDK/API .-> voice-control

voice-control     -> no bridge-hub dependency
voice-control     -> no bridge-control dependency
bridge-control    -> no concrete bridge-hub dependency
```

Rules:

- `voice-control` may be installed and used for ordinary voice conversation without either other component.
- `bridge-control` may be tested against a fake hub and must expose a stable domain contract.
- only `bridge-hub` may depend directly on concrete external software such as CMB;
- `bridge-hub` may depend on `voice-control` only through its public SDK or remote API;
- `voice-control` must never import or assume `bridge-hub` internals;
- no plugin may import the CMB submodule source. All access is through CMB's public HTTP/SSE contract.

## 4. Activation Lifecycle

Installed is not usable.

```text
installed -> configured -> healthy -> paired -> subscribed -> active
```

- `installed`: package is present.
- `configured`: endpoint, credentials reference, providers, and retention settings exist.
- `healthy`: session and event dependencies pass a health check.
- `paired`: trusted instance and user scope are established.
- `subscribed`: required event triggers are mapped.
- `active`: the host may route user requests to the plugin.

A voice plugin without task-control triggers can still provide ordinary voice chat. It must not claim task-control support until the pairing and subscription checks pass.

## 5. Voice Flow

There are three output sources:

1. user speech converted to text by ASR;
2. conversational assistant speech generated from the current model turn;
3. system announcements emitted by the notification scheduler.

The voice host owns one audio arbiter:

- user speech interrupts assistant or system speech;
- only one source speaks at a time;
- background notices wait for an idle gap;
- direct answers to the current user request have priority over background notices;
- interrupted announcements remain persisted and are not marked spoken;
- a reconnect replays events from the last acknowledged cursor.

The plugin never calls TTS or controls the microphone.

## 6. Create Flow

1. The voice host converts the user request and sends it to the voice model.
2. The model calls `bridge_chat_create` with a draft.
3. The plugin returns `needs_input` when fields are missing.
4. The model asks the returned questions in the same voice conversation.
5. The user answers and the model updates the same draft.
6. When complete, the plugin returns `awaiting_confirmation` with a deterministic summary and confirmation prompt.
7. The voice host ensures the confirmation prompt is spoken.
8. The user answers with an explicit affirmative or negative.
9. The model calls `bridge_chat_confirm`.
10. The backend verifies the latest user transcript against the pending draft and either confirms or cancels.

The backend, not the model, decides whether the user confirmed. A model-provided boolean is never sufficient authorization.

The create receipt is returned to the current voice turn. The model or host may speak it using a returned speech template. Creation success means "accepted", never "completed".

## 7. Background Events

Long-running work cannot be awaited inside the create turn.

1. A persistent Hub worker ingests CMB state changes.
2. Events are appended with stable IDs and sequence numbers.
3. Subscription rules decide whether a voice plugin should see each event.
4. The voice host reads events with `bridge_chat_events`.
5. Notices are queued and spoken only during an allowed idle period.
6. The host writes `spoken`, `interrupted`, or `failed` playback acknowledgements.

A disconnected voice session does not cancel work and does not lose events.

## 8. Security Boundaries

- No arbitrary URL proxy.
- No plaintext credentials in tool arguments or persisted event payloads.
- Work sessions receive only the `work-reporter` profile.
- High-risk approvals require explicit user-confirmed interaction binding.
- Unknown write results are reconciled, never automatically replayed.
- Retrieved work or chat content is data, not executable instructions.
- Raw audio and transcript logging are opt-in and retention-controlled.
- Plugin installation does not imply trust, pairing, or event authorization.

## 9. Non-goals for the First Slice

- Full production STUN/TURN and multi-region relay.
- Mobile native app packaging.
- Automatic provider account provisioning.
- Arbitrary third-party plugin sandboxing.
- Replacing CMB's own UI or modifying CMB source.
