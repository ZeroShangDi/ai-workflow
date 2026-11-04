# Codex Control Architecture

## 1. Product Goal

Codex Control provides a voice-first control plane while keeping its two plugins independently usable.

- `voice-control` alone supports a complete voice-chat loop.
- `bridge-control` alone supports CMB task control.
- Installing both adds task creation, progress notices, approvals, completion announcements, and playback receipts to the same voice page.
- `bridge-hub` is optional and only serves future mobile-App integration. It is never required by either plugin.

## 2. Components

### 2.1 `plugins/voice-control`

A self-contained local or remote voice runtime. It owns:

- the voice page and a single start/stop interaction;
- ASR and TTS through browser or host providers;
- the conversation-provider loop;
- live voice sessions, SSE events and interruption behavior;
- task-notice ingestion, queueing and durable playback state;
- observed playback acknowledgements;
- public `open`, `close`, and `tunnel` endpoints.

It does not import or require `bridge-hub`, `bridge-control`, CMB, or ai-market code.

### 2.2 `plugins/bridge-control`

An independently runnable internal control plugin backed directly by CMB public HTTP/SSE. It owns:

- CMB login, projects, sessions, send, history, respond and stop;
- `voice-controller` and `work-reporter` profiles;
- task creation confirmation based on the newest real user message in the fixed CMB/Codex conversation;
- task and interaction state;
- task-event production for Voice Control.

It does not import or require Hub or Voice Control implementation code.

### 2.3 `bridge-hub`

Optional backend for a future mobile App. It may independently depend on CMB and use Voice Control through its public `open`, `close`, and `tunnel` interfaces. It must not be part of the local two-plugin control path and neither plugin may depend on it.

## 3. Dependency Graph

```text
bridge-control ───────────────────> CMB public HTTP/SSE
bridge-control <──local WebSocket──> voice-control

bridge-hub ──────────────────────> CMB public HTTP/SSE              # optional
bridge-hub ──open/close/tunnel───> voice-control                    # optional

voice-control  ──X──> bridge-hub
voice-control  ──X──> bridge-control
bridge-control ──X──> bridge-hub
bridge-control ──X──> voice-control implementation
```

The primary event transport is an authenticated local WebSocket owned by Bridge Control. Voice connects as a client and falls back to standalone mode when the server is unavailable.

Task events are also retained in the configured JSONL ledger for compatibility and inspection:

```text
plugins/voice-control/config/settings.json
├── eventFiles.taskEvents
```

- `task-events.jsonl` is written by Bridge Control for task creation, progress, interactions and completion.
- Voice Control reads task events, owns notice state, and records observed playback outcomes in its own ledger.
- Bridge Control receives explicit public parameters from Voice events; it does not read Voice config or import Voice implementation code.
- Voice chat history is persisted by the fixed Codex conversation. Voice Control does not maintain a parallel transcript file.

## 4. Standalone and Combined Modes

### Voice only

```text
microphone -> ASR -> conversation provider -> assistant text -> TTS
```

The page needs only one start/stop switch, state text, and the current conversation text.

### Control only

```text
MCP tools -> bridge-control -> CMB
```

CMB task control works without Voice Control. Events remain durable in the local event file for a later Voice instance.

### Both installed

```text
voice chat -> host model/tools -> bridge-control -> CMB
                                      |
                                      v
                            task-events.jsonl
                                      |
                                      v
voice-control notice ledger -> page/TTS -> playback receipt
```

Hub is not present in this path.

## 5. Voice Page

The reference behavior comes from the existing uni-app/voice-service surface: one voice switch plus text. The plugin page must not expose a dashboard or multiple control panels.

Required states:

- idle;
- opening;
- listening;
- thinking;
- speaking;
- error.

User speech interrupts active assistant or task-notice playback. A notice is only marked `spoken` after observed playback ends.

## 6. Create and Authorization

1. The fixed Codex conversation persists the final user text as a native user message.
2. `bridge-control` builds a draft and returns missing fields.
3. A complete draft enters `awaiting_confirmation` with the latest conversation turn as its baseline.
4. Only a newer explicit affirmative user message can confirm creation.
5. The same user message cannot authorize two tasks.
6. CMB create/send results are idempotent; unknown write outcomes are not replayed.

## 7. Hub Boundary

Hub work is deferred until mobile-App requirements are concrete. When added:

- Hub depends directly on CMB public HTTP/SSE;
- Hub uses only `voice-control`'s public `open`, `close`, and `tunnel` endpoints;
- Hub must not import Voice Control or Bridge Control internals;
- Hub must not become the storage owner for Voice notice state or the default task-control path.

## 8. Security

- No plaintext credentials in tool arguments or events.
- CMB credentials come from environment variables or private files.
- Event files are created private to the current user.
- Work sessions receive only `work-reporter`.
- Approvals and creation use the newest real user message from the fixed Codex conversation and immutable interaction bindings.
- Unknown external writes are reconciled, never automatically replayed.
- Raw audio is never stored by the event bus.

## Voice Center successor (2026-11-02)

`plugins/voice-center` is the independently runnable successor voice runtime.
Its Python backend owns WebRTC/VAD/ASR/TTS and local SQLite voice transcripts; its Node host owns the page, tickets, notice ledger and public Control WebSocket client.
This local transcript ledger belongs to Voice Center and does not change the legacy Voice Control history contract.

Work mode defaults to `control`. `market` is retained as an explicitly selected legacy mode; `none` disables work capabilities.
The audio host captures real transcription outside model arguments. Its internal work capability forwards each observed turn at most once through `voice.chat.user`.
The fixed trusted Control conversation owns the entire draft, missing-input and subsequent explicit confirmation workflow.
Voice Center must not issue a second external create/confirm call after that conversation replies.
Timeouts and unknown writes consume the turn; users must check state with a new turn.
The market/mobile work-host bridge is retained for future use and is not a dependency of the default Control path.
Native work sessions still load only work-reporter. CMB source remains read-only.

## Optional Qwen duplex runtime (2026-11-03)

Voice Center keeps `pipeline` as its default voice mode. Setting
`VOICE_CENTER_VOICE_MODE=qwen-realtime` selects the isolated
`plugins/voice-center/backend/voice_center_backend/realtime_qwen/` package.
Voice mode is independent of `VOICE_CENTER_WORK_MODE` (control/market/none).
The existing host HTTP, task-control WS and notice ledger contracts are reused.

The package owns the Qwen provider connection, continuous PCM input, semantic
turn detection, tool adaptation, transcript mapping, browser PCM playback and
all provider-specific emotion/environment configuration and future policies.
Shared code supplies only runtime selection, startup validation, a static module
route and generic page lifecycle/delivery hooks. Emotion interpretation must not
spread into Control, persona storage, shared HTTP configuration or task authority.

Microphone capture still uses the existing WebRTC connection. In Qwen mode,
output PCM uses the ordered DataChannel and the package's browser AudioContext
player, allowing cancellation of scheduled samples and observed playback end.
The legacy mode continues to use its original WebRTC output track. This output
choice needs real-device latency/echo testing before production activation.
Qwen owns turn detection; local VAD must not segment or suppress its input audio.
No provider audio, affect estimate or ambient transcription is a task authorization.
Only finalized user transcription observed by the runtime may feed the existing
work capability, which delegates the complete workflow to Control.
Provider disconnects and unknown writes are never automatically replayed.

## Voice Center internal character module (preparation, 2026-11-03)

`plugins/voice-center/backend/voice_center_backend/characters/` owns a provider-independent
character catalog, bundled character resources, style instructions and local selection.
It uses only Python standard-library APIs and does not import or access the standalone
character plugin at runtime. Resources preserve the existing schema and licenses.
Selection is private and atomically persisted under Voice Center's own data directory.

This first stage provides the module without changing the current `character.py`
loader, active voice sessions, HTTP/MCP exposure, or the standalone character plugin.
Future runtime migration consumes this module's public Python API. Character data may
express general communication style, but Qwen voice mapping and all Qwen-specific
emotion/environment behavior remain inside `realtime_qwen/`. Neither character data
nor selection changes authorize work, approvals or playback acknowledgements.

## Optional external memory boundary (preparation, 2026-11-03)

Voice Center's `memory/` Python package defines a provider-neutral adapter protocol,
host-bound tenant/user identity, bounded operations and a model-tool facade.
It owns no memory database or extraction engine. Disabled by default, it performs
no I/O and exposes no tools without both enablement and an injected adapter.
Search failures yield empty context; unknown writes never claim success or retry.

This stage does not register memory in PluginHost or either voice pipeline.
Future integration may preload a small profile and offer on-demand tools. Qwen
wire/context adaptation stays in realtime_qwen. Memory data is background only,
never task authority or a replacement for current task-state queries.
