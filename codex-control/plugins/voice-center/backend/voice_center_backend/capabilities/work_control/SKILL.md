# Control Work Capability

Active only with VOICE_CENTER_WORK_MODE=control.
Use control_work for work requests, follow-up details, status, cancellation, and replies to a pending Control confirmation.
The audio host supplies the latest real transcription; the tool accepts no user quote or confirmation arguments.
The fixed Control conversation owns draft IDs, bindings, missing-field questions and later explicit confirmation.
Read its response faithfully to the user, including the draft summary and confirmation question. Never claim creation without a confirmed receipt.
Each spoken turn can be forwarded only once. On failure or timeout, check state through a new user turn rather than retrying.
