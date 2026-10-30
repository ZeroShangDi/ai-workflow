# Development Plan

## Current Baseline

The two-plugin direct path is the product baseline:

- `voice-control` is self-contained and provides voice chat plus its own notice/playback ledger;
- `bridge-control` talks directly to CMB and does not require Hub;
- the plugins exchange task and transcript events through private local JSONL files;
- two-plugin installation supports voice chat, task creation, progress notices and playback acknowledgement;
- `bridge-hub` is optional future App infrastructure.

## Track A: Voice Control

Acceptance:

- one start/stop switch plus state and conversation text on the page;
- ASR -> conversation provider -> assistant text -> TTS loop;
- no imports or runtime API dependency on Hub or Control;
- durable local task-notice queue and playback receipt;
- public `open`, `close`, and `tunnel` interfaces;
- user speech interrupts active playback;
- tests use a fake conversation provider and need no real model, microphone or CMB.

## Track B: Bridge Control

Acceptance:

- CMB public HTTP/SSE client lives inside the plugin;
- no Hub configuration, module injection or HTTP dependency;
- `voice-controller` and `work-reporter` remain isolated;
- task events are emitted to the shared local event files;
- creation and approval require a newer real voice transcript;
- task control remains useful with Voice Control absent;
- tests use mock CMB and need no real credentials.

## Track C: Optional Hub

Not part of the current two-plugin acceptance path.

When requirements are defined:

- depend directly on CMB;
- consume Voice Control only through `open`, `close`, and `tunnel`;
- add App identity/device/pages and mobile-specific CMB forwarding;
- never import plugin internals or own Voice playback state.

## Integration Gate

1. run `npm run check:boundaries`;
2. run each plugin's tests;
3. start a mock CMB;
4. exercise voice chat, draft, confirmation, CMB create, progress event, voice notice and playback receipt;
5. verify the loop does not start or reference Hub;
6. verify Voice and Control can each start independently.

## Out of Scope

- production TURN/relay deployment;
- native mobile packaging;
- real provider credentials in tests;
- automatic marketplace installation;
- Hub App UI until mobile requirements are finalized.
