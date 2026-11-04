"""Work capability backed by the public Bridge Control WebSocket protocol."""

import asyncio
import json
import os
import uuid
from pathlib import Path

import websockets


def _config_path():
    explicit = os.environ.get("VOICE_CENTER_INTEGRATION_CONFIG")
    if explicit:
        return Path(explicit)
    return Path(__file__).resolve().parents[4] / "config" / "settings.json"


def _load_config():
    path = _config_path()
    value = json.loads(path.read_text())
    control = value.get("plugins", {}).get("control", {})
    workspace = value.get("workspace", {})
    return {
        "url": os.environ.get("VOICE_CENTER_CONTROL_WS_URL") or control.get("websocketUrl"),
        "token_file": os.environ.get("VOICE_CENTER_CONTROL_WS_TOKEN_FILE") or control.get("tokenFile"),
        "voice_session_id": workspace.get("voiceSessionId"),
    }


class WorkControl:
    def __init__(self, identity, context=None, host=None):
        self.identity = identity
        self.context = context
        self.host = host
        self.enabled = True
        self.latest_turn = None
        self.inflight = False

    async def _request(self, topic, payload, response_topics):
        config = _load_config()
        if not config["url"] or not config["token_file"]:
            raise RuntimeError("Control WebSocket is not configured")
        token = Path(config["token_file"]).read_text().strip()
        if len(token) < 32:
            raise RuntimeError("Control WebSocket token is invalid")
        correlation = "req_" + str(uuid.uuid4())
        event_id = "evt_" + str(uuid.uuid4())
        event = {
            "schemaVersion": 1,
            "eventId": event_id,
            "correlationId": correlation,
            "topic": topic,
            "source": "voice-center-runtime",
            "createdAt": __import__("datetime").datetime.now(
                __import__("datetime").timezone.utc
            ).isoformat(),
            "payload": payload,
        }
        async with websockets.connect(config["url"], open_timeout=5, close_timeout=3) as socket:
            await socket.send(json.dumps({
                "type": "hello",
                "protocolVersion": 1,
                "client": {"id": "voice-center-runtime", "version": "0.1.0"},
                "token": token,
                "cursor": "0",
            }))
            while True:
                message = json.loads(await asyncio.wait_for(socket.recv(), 5))
                if message.get("type") == "error":
                    raise RuntimeError(message.get("error", {}).get("message", "Control protocol error"))
                if message.get("type") == "hello.ack":
                    break
            await socket.send(json.dumps({
                "type": "subscribe",
                "topics": response_topics,
            }))
            while True:
                message = json.loads(await asyncio.wait_for(socket.recv(), 5))
                if message.get("type") == "error":
                    raise RuntimeError(message.get("error", {}).get("message", "Control protocol error"))
                if message.get("type") == "replay.complete":
                    break
            await socket.send(json.dumps({"type": "event", "event": event}))
            while True:
                message = json.loads(await asyncio.wait_for(socket.recv(), 150))
                if message.get("type") == "error":
                    raise RuntimeError(message.get("error", {}).get("message", "Control protocol error"))
                if message.get("type") != "event":
                    continue
                returned = message.get("event") or {}
                if returned.get("correlationId") != correlation:
                    continue
                if returned.get("topic") not in response_topics:
                    continue
                if returned.get("topic") in {"control.error", "control.tool.call.failed", "control.chat.failed"}:
                    raise RuntimeError(returned.get("payload", {}).get("message", "Control request failed"))
                return returned.get("payload", {})

    def _session_id(self):
        value = _load_config().get("voice_session_id")
        if not value:
            raise RuntimeError("Fixed Control voice session is not initialized")
        return value

    async def _record_user_turn(self, text):
        return await self._request(
            "voice.chat.user",
            {"voiceSessionId": self._session_id(), "text": text},
            ["control.chat.reply", "control.chat.failed", "control.error"],
        )

    def record_transcript(self, role, text, identity):
        # Only the audio host calls this hook; model arguments never supply authorization.
        if role == "user" and isinstance(text, str) and text.strip():
            self.latest_turn = {"text": text.strip(), "consumed": False}

    async def execute(self, name, args):
        if name != "control_work":
            raise ValueError(f"Unsupported work tool: {name}")
        turn = self.latest_turn
        if self.inflight or not turn or turn["consumed"]:
            raise RuntimeError("No fresh host-observed user turn; check Control state before retrying")
        # Consume before any external write. Unknown outcomes must never replay the turn.
        turn["consumed"] = True
        self.inflight = True
        try:
            async with asyncio.timeout(150):
                return await self._record_user_turn(turn["text"])
        finally:
            self.inflight = False


def activate(**kwargs):
    return WorkControl(**kwargs)
