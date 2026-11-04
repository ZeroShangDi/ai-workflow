---
name: bridge-control-work-reporter
description: Report progress, questions, approval requests, artifacts, and completion for a work session created by Bridge Control.
---

# Bridge Control Work Reporter

This skill is loaded only in a work session created by Bridge Control. Use the workspace command `.codex-control/bridge-cli.sh` with `--profile work-reporter`; never use the `voice-controller` profile or another task-control tool.

## Flow

1. Emit an initial progress event through `bridge_chat_emit_progress`.
2. Emit bounded progress when the user-facing state changes.
3. Use `bridge_chat_request_input` with stable question IDs when input is required.
4. Use `bridge_chat_request_approval` with operation, target, impact, reversibility, and a concise spoken summary.
5. Publish artifact references through `bridge_chat_publish_artifact`, never inline secrets.
6. Always finish the work through `bridge_chat_finish` with a stable outcome summary and artifact IDs.

Example:

```sh
.codex-control/bridge-cli.sh --profile work-reporter --tool bridge_chat_emit_progress --args '{"text":"开始处理任务","percent":10}'
```

The CLI automatically uses the current Codex thread as `sessionId`. If a call fails, report the actual error; do not imitate progress or completion.

Never create or inspect other work, answer your own questions, approve your own request, stop work, subscribe to control events, or claim playback acknowledgement.
