# Development Plan

## Baseline

The documentation, dependency rules, and current prototype are committed before parallel implementation.

Current prototype scope:

- ordinary Codex MCP proof of concept;
- CMB login, session listing, send, SSE, and reply wait;
- local tests only.

The first integrated slice now also provides:

- a standalone voice plugin with bounded events, explicit triggers, and local playback receipts;
- isolated `voice-controller` and `work-reporter` profiles;
- a Hub-hosted control API backed by persisted transcripts, work state, and interactions;
- CMB session creation and continuation through public HTTP only;
- an end-to-end confirmation, progress, approval, completion, notice, and playback-ack test.

This remains a local development slice; it is not yet a globally installed plugin release.

## Three Parallel Tracks

### Track A: `plugins/voice-control`

Write scope:

```text
plugins/voice-control/**
```

Deliverables for the first slice:

- plugin manifest and local/remote runtime modes;
- minimal voice page and host SDK;
- session create/close and generic event stream;
- external-trigger configuration contract;
- provider interfaces for ASR/TTS;
- local mock provider for tests;
- tests for session lifecycle, trigger configuration, and isolation from `bridge-hub`.

Acceptance:

- runs standalone without `bridge-hub`;
- does not import `bridge-control` or `bridge-hub`;
- ordinary voice-chat capability works with a mock provider;
- task-control triggers remain disabled until configured.

### Track B: `plugins/bridge-control`

Write scope:

```text
plugins/bridge-control/**
```

Deliverables for the first slice:

- stable domain and Hub interfaces;
- `voice-controller` and `work-reporter` profiles;
- all public tools use `bridge_chat_*`;
- create draft and explicit confirmation state machine;
- no concrete CMB access in the control plugin;
- no ordinary Codex global exposure in the production profile;
- tests for profile isolation, confirmation, approval binding, and unknown writes.

Acceptance:

- voice-controller can run against a fake Hub;
- work-reporter cannot create, answer, approve, or subscribe;
- ambiguous confirmation is rejected;
- no audio/TTS code exists in the plugin.

### Track C: `bridge-hub`

Write scope:

```text
bridge-hub/**
```

Deliverables for the first slice:

- CMB adapter using public HTTP/SSE only;
- append-only event store with cursor and dedupe;
- subscription registry and explicit pairing state;
- session binding and bounded control API;
- delivery inbox and acknowledgement;
- optional voice SDK client boundary;
- tests with a mock CMB service and fake voice consumer.

Acceptance:

- Hub depends on CMB through HTTP, never imports CMB source;
- no voice service internals are imported;
- reconnect resumes after acknowledged cursor;
- duplicate writes are idempotent;
- contract tests pass for control and voice consumers.

## Integration

After the three tracks complete:

1. run each project's tests;
2. run a Hub contract test against fake CMB;
3. run voice-control with mock ASR/TTS and a fake trigger source;
4. pair voice-control and bridge-control through the Hub;
5. run one end-to-end create, confirm, complete, notice, spoken, ack flow;
6. verify work-reporter cannot access controller tools;
7. verify CMB submodule remains clean.

## Commit Policy

- one baseline documentation commit;
- one commit per implementation track when the track is reviewed;
- avoid mechanical or WIP commits;
- integration corrections are folded into the relevant track commit where practical;
- final integration documentation, if needed, gets one separate commit.

## Out of Scope for First Slice

- production TURN/relay deployment;
- native mobile packages;
- real provider credentials in tests;
- automatic marketplace installation;
- general-purpose Codex exposure of the internal control profile.
