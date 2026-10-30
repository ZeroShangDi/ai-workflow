---
name: bridge-control
description: Use the adapter-based Bridge Control MCP plugin to inspect projects and sessions, configure a bridge, and send a message while observing its real-time event stream.
---

# Bridge Control

Use this skill when the user asks Codex to operate an external agent bridge, especially Codex Mobile Bridge.

## Workflow

1. Call `bridge_status` to verify configuration and authentication.
2. If configuration is missing, call `bridge_configure`. Never ask for a plaintext password in the conversation; use an existing environment variable or local password file.
3. Call `bridge_projects` or `bridge_sessions` to find the correct destination.
4. Call `bridge_chat` with an existing `sessionId`, or provide a `project` and `title` to create a test chat.
5. Report the returned reply, state update count, first-update latency, and total elapsed time.

The plugin keeps software-specific behavior behind adapters. The current adapter is `cmb`; future bridge software should add an adapter without changing the public tools.
