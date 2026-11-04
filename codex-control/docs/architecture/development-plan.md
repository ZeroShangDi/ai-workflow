# Development Plan

## Current Baseline

The two-plugin direct path is the product baseline:

- `voice-control` is self-contained and provides voice chat plus its own notice/playback ledger;
- `bridge-control` talks directly to CMB and does not require Hub;
- Bridge Control publishes task events over its local WebSocket and retains a JSONL compatibility ledger;
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
- creation and approval require a newer real user message from the fixed Codex conversation;
- task control remains useful with Voice Control absent;
- tests use mock CMB and need no real credentials.

## Track C: Optional Hub

Not part of the current two-plugin acceptance path.

When requirements are defined:

- depend directly on CMB;
- consume Voice Control only through `open`, `close`, and `tunnel`;
- add App identity/device/pages and mobile-specific CMB forwarding;
- never import plugin internals or own Voice playback state.

## Ordered Delivery Queue

This queue is the only source of planned integration work. Items are executed one at a time; later items are not pulled forward without an explicit decision.

| Order | Status | Item | Owner | Exit criteria |
| --- | --- | --- | --- | --- |
| Q1 | Complete | `bridge_chat_voice_config_update` | Voice Control | Atomically updates reviewed workspace, `projectKey`, `voiceSessionId`, and initialization state in the loaded config |
| Q2 | Complete | `bridge_chat_control_workspace_ensure` | Bridge Control | Reuses a configured project or registers a missing configured directory after explicit `createDirectory` authorization |
| Q3 | Implemented, real desktop authorization pending | Fixed workspace/session orchestration | Voice integration skill + WebSocket coordinator | Independent initialization session, fixed chat creation and explicit bind are implemented and covered by integration tests |
| Q4 | Control side complete, host verification pending | Created work sessions load `work-reporter` | Bridge Control + trusted host | Task creation resolves `bridge-control-work-reporter` before sending and fails closed if absent; the host must expose only the `work-reporter` MCP profile to that session |
| Q5 | Queued | Fixed default directory/project for task creation | Bridge Control + integration skill | Use the configured default unless the user explicitly names a directory, project, or workspace |
| Q6 | Queued | Session-scoped character selection | Character Settings + integration skill | Persona, skills, voice profile, actions and voice ID resolve from the selected character for the current voice session |
| Q7 | Queued | Full task loop verification | Voice Control + Bridge Control | Voice request, oral confirmation, CMB create, progress event, speech playback and observed receipt pass end to end |
| Q8 | Queued | Character UI integration | Voice Control + Character Settings | Character cards appear only in the voice page and do not expand the primary voice interaction beyond one switch plus text |
| Q9 | Queued | Fixed Codex voice conversation | Later design | Define the stable conversation owner, history persistence, context trimming, online search and tool-profile loading |
| Q10 | Queued | ASR accuracy and voice UX review | Later design | Evaluate provider/model, audio preprocessing, contextual correction and confirmation of names/numbers without hard-coded project words |
| Q11 | Queued | Voice spoken-response and notice delivery hardening | Voice Center runtime | Filter internal Control receipt fields before model input; summarize task notices into concise plain speech; align notice size limits and coalesce progress while preserving terminal events; record interrupted playback and support explicit replay |

### Skill vs Runtime Boundary

- Runtime code owns audio, ASR/TTS, playback observation and its internal task-notice state.
- The fixed Codex conversation owns chat history and persistence; Voice Control does not maintain a parallel transcript ledger.
- The Voice integration skill orchestrates ready-made tools: load configuration, select a character, inspect/reuse resources, invoke existing creation tools and request missing user decisions.
- The skill must not implement or imply hidden runtime capabilities.
- `bridge_chat_control_voice_session_ensure` is rejected. Fixed session lookup and creation are a composition in the Voice integration skill, not a new Control tool.

### Approved Tool Additions

The two approved additions are implemented:

- `bridge_chat_voice_config_update` (Voice Control);
- `bridge_chat_control_workspace_ensure` (Bridge Control).

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
