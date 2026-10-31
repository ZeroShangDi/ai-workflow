---
name: bridge-control-cli
description: Use the Bridge Control public CLI event interface for task creation, confirmation, status, and control operations.
---

# Bridge Control CLI

Use the workspace command `.codex-control/bridge-cli.sh` for every Control operation.

Never use `codex_app.create_thread` or another built-in task-creation tool. Task creation must go through this CLI so Control owns drafts, confirmation, work sessions, progress events, and playback receipts.

## Task Creation

The fixed workspace is the default. Omit `project` unless the user explicitly names a different project. Do not ask the user to repeat the fixed workspace name, and do not pass an ASR-misheard project name.

Run:

```sh
.codex-control/bridge-cli.sh --profile voice-controller --tool bridge_chat_create --args '{"draft":{"request":"<request>"}}'
```

Interpret the JSON result:

- `needs_input`: ask only for the returned missing fields, then call again with `draftId`, `binding`, and updated `draft`.
- A missing `project` is valid when using the fixed workspace; only `request` must be supplied by default.
- Only include `project` when the user explicitly requests a different project: `{"draft":{"project":"<project>","request":"<request>"}}`.
- `awaiting_confirmation`: speak the summary and ask for explicit confirmation.
- After a clear affirmative user reply, call `bridge_chat_confirm` with the returned `draftId` and `binding`.
- Never claim a task was created until `bridge_chat_confirm` returns `confirmed`.

## Other Operations

Use the same command with the corresponding `bridge_chat_*` tool and JSON arguments. The CLI automatically supplies the current Codex thread as `sessionId`.

If the command fails, report the actual error. Do not bypass it with built-in creation tools.
