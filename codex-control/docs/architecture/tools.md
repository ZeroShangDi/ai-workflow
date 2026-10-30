# Tool Contracts

All new tool names use the `bridge_chat_` prefix. Existing `bridge_chat` remains only as a simple short-turn convenience and must not be used for approvals, creation confirmation, or background notifications.

## Voice Controller Profile

Loaded only in the dedicated voice or app control conversation.

### `bridge_chat_create`

Creates no durable work on the first call.

Returns one of:

- `needs_input`: missing fields and questions;
- `awaiting_confirmation`: complete draft, summary, and confirmation prompt;
- `confirmed`: final creation receipt after `bridge_chat_confirm`.

### `bridge_chat_confirm`

Confirms or cancels a pending create draft.

The control backend inspects the latest real user transcript recorded by Voice
Control. Accept short explicit
affirmative or negative replies. The model does not provide the authoritative
boolean. An affirmative turn is consumed once and cannot create a second work.

### `bridge_chat_find`

Finds work or conversations. Returns bounded candidates and requires disambiguation when multiple records match.

### `bridge_chat_status`

Returns task state, latest progress, pending interactions, unread count, and latest result summary.

### `bridge_chat_send`

Continues an existing work session or conversation.

Modes:

- `send`
- `queue`
- `steer`

Returns a receipt. It does not wait for long-running completion.

### `bridge_chat_read`

Reads history, results, errors, activity, and artifacts using stable before/after cursors. Long fields are paginated by character offset.

### `bridge_chat_events`

Long-polls or reads events after a cursor. Supports topic filters and bounded batches.

Response includes `events` and `nextCursor`.

### `bridge_chat_pending`

Returns a pending question or approval with immutable interaction ID and binding.

### `bridge_chat_answer`

Submits explicit answers for one question or one question group. Answers map to stable question IDs.

### `bridge_chat_approve`

Submits approve/reject for an existing interaction. The backend verifies interaction binding and the latest user utterance. It rejects ambiguous or stale replies.

### `bridge_chat_stop`

Stops or interrupts a running task. Separate from ordinary conversation stop.

### `bridge_chat_ack`

Internal host callback, not exposed to the model.

Marks announcement delivery only after actual playback has stopped.

## Work Reporter Profile

Loaded only in work sessions created by the controller.

### `bridge_chat_emit_progress`

Appends a bounded progress event and optional artifact reference.

### `bridge_chat_request_input`

Creates a pending question with stable question IDs and an immutable interaction binding.

### `bridge_chat_request_approval`

Creates a pending approval with operation, target, impact, reversibility, and a deterministic spoken summary.

### `bridge_chat_publish_artifact`

Registers an existing artifact reference for later retrieval.

### `bridge_chat_finish`

Records success, failure, interruption, or blocking outcome. Includes stable result and artifact references.

## Forbidden Tool Exposure

The `work-reporter` profile must not expose:

- `bridge_chat_create`
- `bridge_chat_confirm`
- `bridge_chat_find`
- `bridge_chat_status`
- `bridge_chat_send`
- `bridge_chat_read`
- `bridge_chat_events`
- `bridge_chat_pending`
- `bridge_chat_answer`
- `bridge_chat_approve`
- `bridge_chat_stop`

The `voice-controller` profile must not expose work-reporting tools.

## Speech Boundary

Tools return structured facts and optional speech templates. They do not synthesize or play audio.

The voice host decides:

- template or model paraphrase;
- immediate speech or queue;
- interruption;
- quiet-mode deferral;
- delivery acknowledgement.
