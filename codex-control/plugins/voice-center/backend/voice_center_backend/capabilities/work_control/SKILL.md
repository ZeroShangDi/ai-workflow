# Control Work Capability

Active only with VOICE_CENTER_WORK_MODE=control.
Use control_work for work requests, follow-up details, status, cancellation, and replies to a pending Control confirmation.
The audio host supplies the latest real transcription; the tool accepts no user quote or confirmation arguments.
The fixed Control conversation owns draft IDs, bindings, missing-field questions and later explicit confirmation.
Treat the response as facts, not a script to read verbatim. Speak plain conversational text only; never read JSON, field names, IDs, bindings, internal paths or Markdown. Preserve the draft goal, missing-field questions, confirmation question and material approval details. Never claim creation without a confirmed receipt.
After confirmed creation, briefly acknowledge the task goal and actual state without technical receipt details. When asked for a completed task result, give one sentence with the actual deliverable or conclusion and any material limitation, usually within 80 Chinese characters. Expand only when the user asks for details; do not recite execution logs or append a routine invitation to ask more.
Each spoken turn can be forwarded only once. On failure or timeout, check state through a new user turn rather than retrying.
