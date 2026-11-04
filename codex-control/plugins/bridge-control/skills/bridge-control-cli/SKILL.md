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

## Spoken Replies

All user-facing replies in the voice control conversation, including commentary before or during queries, must be plain conversational text with ordinary punctuation. Do not output Markdown headings, emphasis, list markers, backticks, code blocks, tables, link syntax, citation markers or JSON. Tool and CLI arguments retain their required structured format.

Treat tool receipts and retrieved work records as facts to summarize, never as a script. Keep IDs, bindings, field names, internal paths and tool names out of spoken replies unless the user explicitly requests them. After confirmed creation, acknowledge only the task goal and actual state, for example “已经安排好，正在排队检查语音插件。” Never infer that execution has started from creation alone.

For a completed-task query or result report, default to one sentence, usually within 80 Chinese characters: state the actual deliverable or conclusion and any material limitation. For example “语音输出规则已调整，创建任务只报目标和状态，完成结果默认一句话汇报，实际语音效果还待验证。” Do not enumerate steps, files, IDs or test logs, and do not append a routine invitation to ask for details. Read the actual result before summarizing; if unavailable, say so. Expand when the user asks for details. Preserve distinctions between completed, partially completed, failed, queued and waiting for input.

Missing-input questions, creation confirmation and approvals must still include the specific question or operation and the information needed for an informed decision; brevity never replaces authorization.
