# cc-control / tmux-http

> 中文文档见 [README.zh-CN.md](./README.zh-CN.md)。

Control one persistent, interactive Claude Code session over HTTP by driving a
tmux pane. Focused on **input**: send messages, send slash commands (`/clear`,
custom), keep multi-turn context. Turn-completion ("ready") is detected via
Claude Code **hooks**, not screen scraping.

```
HTTP client ──POST──> server.js ──tmux send-keys──> [tmux pane: claude]
                          ^                                  │
                          └────── POST /hook <── curl <── Stop/UserPromptSubmit hook
```

## Prerequisites

- `brew install tmux`
- `claude` on PATH (logged in)

## Run

```sh
# 1. start the control service (terminal A)
node server.js                 # listens on 127.0.0.1:8787

# 2. start the controlled claude session (terminal B)
./bootstrap.sh                 # renders hooks -> ../sandbox/.claude/settings.json, launches tmux session 'cc'

# 3. drive it
curl -s localhost:8787/status
curl -s -X POST localhost:8787/send -H 'content-type: application/json' -d '{"text":"hello"}'

# watch it live
tmux attach -t cc              # detach: Ctrl-b then d
```

## API

| Method + path | Body | Effect |
|---|---|---|
| `POST /send` | `{"text": "..."}` | wait until ready, type text, press Enter |
| `POST /cmd`  | `{"cmd": "/clear"}` | same, for slash commands (has a fallback ready-timer) |
| `POST /key`  | `{"keys": "Escape"}` or `"C-c"` | send raw tmux keys (interrupt / edit) |
| `GET  /status` | — | `{state, session}`; add `?snapshot=1` for a pane dump |
| `POST /hook` | `{"event": "Stop"}` | internal — called by the controlled claude's hooks |

State machine: `SessionStart`/`Stop` → **ready**, `UserPromptSubmit` → **busy**.
`/send` blocks until **ready** (up to `CC_READY_TIMEOUT_MS`, then `409`).

## Config (env vars)

`CC_PORT` (8787), `CC_SESSION` (cc), `CC_WORKDIR` (../sandbox),
`CC_READY_TIMEOUT_MS` (120000), `CC_ENTER_DELAY_MS` (200),
`CC_LOCAL_CMD_MS` (1500).

## Test

```sh
./test/smoke.sh
```
Proves multi-turn context (turn 2 recalls the number) and that `/clear` wipes it
(turn 3 does not).

## Verified behavior (v2.1.197)

- Hooks execute from project `settings.json` with no approval prompt.
- `UserPromptSubmit` fires on submit → busy; `Stop` fires on turn end → ready.
- `/clear` emits a **`SessionStart`** hook (not `Stop`), which also maps to ready.
  So readiness recovers correctly after `/clear`; the `CC_LOCAL_CMD_MS` fallback
  is just a safety net.
- Multi-turn context is preserved across `/send` calls; `/clear` wipes it.

## Known fragile points

- **Ready detection depends on hooks firing.** Covered for `/clear` via the
  `SessionStart` mapping; unknown local commands fall back on `CC_LOCAL_CMD_MS`.
- **Trust prompt:** first run in a fresh `sandbox/` shows a "trust this folder?"
  dialog; `bootstrap.sh` sends one Enter to accept.
- **Multi-line input** is not handled (Enter submits). Single-line messages only.
- Sizing is fixed at 200x50; very long output wrapping is a display concern only.
