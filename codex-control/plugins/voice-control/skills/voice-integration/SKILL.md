---
name: voice-integration
description: Initialize the fixed Voice Control workspace from a Control-created independent initialization session.
---

# Voice Integration Initialization

Use this skill only inside the independent initialization session created by Bridge Control.

## Inputs

The initialization message must provide:

- absolute `configPath`;
- absolute `workspacePath`;
- `chatTitle`.

Do not ask for the same values again when they are already present.

## Flow

1. Call `bridge_chat_voice_config_load` with `configPath`.
2. Call `bridge_chat_control_config_load` with the same `configPath`.
3. Verify the Control and character plugins are available. Stop if either is missing.
4. Call `bridge_chat_control_workspace_ensure` with `{ "createDirectory": true }`.
5. Require a stable `workspace.projectKey` from the result.
6. Call `bridge_chat_voice_config_update` with:

```json
{
  "configPath": "<absolute-config-path>",
  "workspace": {
    "path": "<absolute-workspace-path>",
    "projectKey": "<returned-project-key>",
    "voiceSessionId": "",
    "voiceSessionTitle": "<chat-title>",
    "initialized": false
  }
}
```

7. Stop after the workspace is persisted.

## Boundaries

- Do not create the fixed voice chat session here.
- Do not create a work session or task here.
- Do not store chat transcripts or create another event ledger.
- The fixed chat session is created by the next Control WebSocket event after Voice observes the updated config.
