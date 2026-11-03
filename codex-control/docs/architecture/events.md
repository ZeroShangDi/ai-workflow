# Event Protocol

The primary control plane between the two plugins is a local WebSocket event channel.

```text
bridge-control: WebSocket Server
voice-control: WebSocket Client
```

The channel is bidirectional. Both sides can publish and subscribe. Voice can still start without Control; if the authenticated WebSocket handshake fails, Voice runs in standalone mode.

## Connection

1. Voice connects to `BRIDGE_CONTROL_WS_URL`.
2. Voice sends `hello` with protocol version, client identity, token and last cursor.
3. Control returns `hello.ack`.
4. Voice sends `subscribe` with its topic filters.
5. Control replays retained events after the supplied cursor and returns `replay.complete`.
6. Both sides may publish events with `eventId`, `correlationId`, `topic`, `source`, `createdAt` and `payload`.
7. Every accepted event is persisted in SQLite before delivery.

Authentication uses a private token file. The server listens on loopback only by default.

## Topics

Initialization and fixed chat:

- `voice.initialization.requested`
- `control.initialization.started`
- `control.initialization.failed`
- `voice.chat_session.create.requested`
- `control.chat_session.ready`
- `control.chat_session.failed`
- `voice.chat_session.bind.requested`
- `control.chat_session.bound`
- `voice.chat.user`
- `control.chat.reply`
- `control.chat.failed`

Task control and work reporting:

- `task.created`
- `task.progress`
- `task.completed`
- `task.failed`
- `task.interrupted`
- `task.stopped`
- `interaction.requested`
- `interaction.answered`
- `artifact.ready`

Playback:

- `voice.playback.result`
- `control.playback.recorded`

## Initialization

Voice checks its own integration config. If an existing fixed `voiceSessionId` is valid, it sends `voice.chat_session.bind.requested` only.

If initialization is incomplete:

1. Voice sends `voice.initialization.requested` with explicit public parameters: config path, fixed workspace path, initialization workspace path, initialization skill path and chat title.
2. Control creates an independent initialization session outside the fixed workspace.
3. Control attaches the `voice-integration` skill.
4. The skill uses Control's public tools to ensure the fixed workspace and writes the result through Voice's config-update tool.
5. Voice observes its own config change.
6. Voice sends `voice.chat_session.create.requested`.
7. Control creates or reuses the fixed chat session in the fixed workspace.
8. Voice persists the returned ID and sends `voice.chat_session.bind.requested`.
9. Control verifies the session exists and returns `control.chat_session.bound`.

Control does not read or write Voice's config. Voice owns its config write.

## Chat

Voice sends final ASR text through `voice.chat.user`. Control sends it to the bound Codex conversation and waits for a completed assistant message. The result is returned as `control.chat.reply`.

The fixed Codex conversation owns chat persistence. Voice does not maintain a transcript ledger.

## Task Delivery

Bridge Control appends task events to the configured JSONL ledger for compatibility, then publishes the same event over WebSocket. Voice applies the existing notice lifecycle and reports playback outcomes.

Task state and playback state remain separate.

```text
queued -> spoken | interrupted | failed
```

Only observed audio completion may mark a notice `spoken`.

## Cursor and Replay

- Control persists events in SQLite in publish order.
- `eventId` is globally unique.
- Consumers advance a cursor only after processing an event.
- Reconnect starts after the last processed cursor.
- Duplicate delivery is safe and deduplicated by `eventId`.

The JSONL task ledger remains a compatibility and inspection layer; it is no longer the primary real-time transport.

## Voice Center optional Qwen DataChannel (2026-11-03)

These are private audio-host messages on Voice Center's existing WebRTC
DataChannel, **not** additional Control WebSocket topics. Implementations and
future emotion/environment policies live entirely in `realtime_qwen/`.
The shared page only starts/stops the player and forwards observed notice
outcomes through the existing HTTP `delivery` event contract.

| Message type | Direction | Meaning / fields |
| --- | --- | --- |
| `realtime.audio.start` | Python host → module browser player | 开始一段播放；playbackId、noticeId（普通回复为空） |
| `realtime.audio.delta` | Python host → module browser player | PCM 音频分片；playbackId、audio（Base64，24kHz/16bit/mono） |
| `realtime.audio.end` | Python host → module browser player | 本段生成结束；playbackId；不代表播放完成 |
| `realtime.audio.cancel` | Python host → module browser player | 停止并清空该段已排队音频；playbackId、status（interrupted/failed） |
| `realtime.playback.result` | module browser player → Python host | 实际播放结果；playbackId、status（spoken/interrupted/failed） |

Only the player may emit `spoken` after all audio sources have naturally ended
and the end marker has been received. No-audio, failed, cancelled or stopped
playbacks cannot become spoken. Notice outcomes also go to the existing
`POST /api/sessions/:id/events` with `type=delivery`; Voice persists the ledger
and sends the existing `voice.playback.result` Control WS event.
Generation completion, event acceptance and Control echo are not playback proof.
