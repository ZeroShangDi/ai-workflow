# Voice Control Runtime

This package is the voice backend owned by `voice-control`. It is a drop-in replacement for the previously configured external voice service and does not import or call ai-market code.

## HTTP contract

```text
GET  /health
POST /offer
Authorization: Bearer <voice ticket>
```

`POST /offer` accepts the same payload used by the existing Voice Control client:

```json
{
  "type": "offer",
  "sdp": "<sdp>",
  "host_task_bridge": true,
  "host_plugin_bridge": false
}
```

It returns:

```json
{
  "type": "answer",
  "sdp": "<sdp>"
}
```

The module owns WebRTC, server VAD, continuous turns, interruption, ASR provider calls, the conversation-provider bridge, streaming PCM TTS, task-notice playback and observed playback acknowledgement.

## Install

```sh
uv venv ../.local/runtime-venv --python 3.12
uv pip install --python ../.local/runtime-venv/bin/python -e .
```

## Provider configuration

```text
VOICE_CONTROL_RUNTIME_PYTHON
VOICE_CONTROL_RUNTIME_PORT
VOICE_CONTROL_ASR_PROTOCOL
VOICE_CONTROL_ASR_URL
VOICE_CONTROL_ASR_MODEL
VOICE_CONTROL_ASR_API_KEY or VOICE_CONTROL_ASR_API_KEY_FILE
VOICE_CONTROL_TTS_URL
VOICE_CONTROL_TTS_MODEL
VOICE_CONTROL_TTS_VOICE
VOICE_CONTROL_TTS_SAMPLE_RATE
VOICE_CONTROL_TTS_API_KEY or VOICE_CONTROL_TTS_API_KEY_FILE
```

The launcher also supplies the shared ticket secret and the internal Voice Control LLM endpoint. The outer plugin only changes `VOICE_CONTROL_AUDIO_SERVICE_URL` to `http://127.0.0.1:48087`.
