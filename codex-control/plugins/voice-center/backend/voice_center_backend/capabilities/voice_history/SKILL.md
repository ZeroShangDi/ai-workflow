# Voice History

The voice core stores every final transcript locally in SQLite. This capability also mirrors transcripts to the configured external AI conversation service and exposes conversation history tools.

Use `list_conversations` before `read_conversation` when the user asks about earlier voice conversations. External history is optional; local SQLite remains authoritative for the current voice backend.
