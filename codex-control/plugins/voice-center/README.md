# Voice Center

`voice-center` is the self-contained successor voice plugin. The market voice-service core is copied into `backend/`; no ai-market source or service is imported at runtime.

```text
Node host: page, open/close/tunnel, SSE, notice ledger, Control integration
Python backend: WebRTC, VAD, ASR, LLM, streaming TTS, task notices
SQLite: append-only local transcript history
```

## Capability modes

- `voice_history`: always on; local SQLite is core-owned, external conversation mirroring is optional.
- `web_search`: always loaded; requires a configured external agent search service and token.
- `work_market`: retained optional market/mobile host integration; select explicitly with `VOICE_CENTER_WORK_MODE=market`.
- `work_control` (default): Control conversation delegation over public WebSocket; selected with `VOICE_CENTER_WORK_MODE=control`.
- `none`: voice chat and history only.

`GET/PUT /api/config/work-mode` reads or persists the mode. A mode change applies on the next backend start. Only one work capability is loaded at a time.

## Start

```sh
uv venv .local/runtime-venv --python 3.12
uv pip install --python .local/runtime-venv/bin/python -e backend
npm start
```

Default port: `8891`.

Work Control forwards host-observed speech once to the fixed Control conversation, which owns drafts and subsequent confirmation. It requires initialized Control configuration and its trusted voice-controller profile. Market work integration is retained but not enabled by default. It still requires the external services and mobile host bridge. Explicitly saved none mode is respected.
