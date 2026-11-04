"""All Qwen-specific configuration, including future emotion/environment policy."""
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


def boolean(env, name, default):
    value = env.get(name, str(default)).lower()
    if value not in {"true", "false", "1", "0"}:
        raise ValueError(f"{name} must be true or false")
    return value in {"true", "1"}


@dataclass(frozen=True)
class Config:
    url: str
    api_key: str = field(repr=False)
    voice: str = "longanqian_v3.1"
    emotion: bool = True
    turn_detection: str = "smart_turn_v2"
    history_turns: int = 10
    speech_rate: float = 1.0
    voiceprints: tuple = ()

    @classmethod
    def load(cls, env=None):
        env = os.environ if env is None else env
        key = env.get("VOICE_CENTER_QWEN_API_KEY", "").strip()
        if not key and env.get("VOICE_CENTER_QWEN_API_KEY_FILE"):
            credential_file = Path(env["VOICE_CENTER_QWEN_API_KEY_FILE"])
            if not credential_file.is_absolute():
                raise ValueError("VOICE_CENTER_QWEN_API_KEY_FILE must be an absolute path")
            key = credential_file.read_text().strip()
        if not key:
            raise ValueError("Configure VOICE_CENTER_QWEN_API_KEY_FILE or VOICE_CENTER_QWEN_API_KEY")
        # Explicit regional URL avoids assuming a workspace-specific endpoint.
        endpoint = urlsplit(env.get("VOICE_CENTER_QWEN_REALTIME_URL", ""))
        if endpoint.scheme != "wss" or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.fragment:
            raise ValueError("VOICE_CENTER_QWEN_REALTIME_URL must be a credential-free wss URL")
        query = dict(parse_qsl(endpoint.query))
        if any(k.lower() in {"token", "key", "api_key", "authorization"} for k in query):
            raise ValueError("Qwen URL must not contain credentials")
        model = env.get("VOICE_CENTER_QWEN_MODEL", query.get("model", "qwen-audio-3.1-realtime-flash"))
        if model not in {"qwen-audio-3.1-realtime-flash", "qwen-audio-3.1-realtime-plus"}:
            raise ValueError("Unsupported Qwen realtime model")
        query["model"] = model
        turn = env.get("VOICE_CENTER_QWEN_TURN_DETECTION", "smart_turn_v2")
        if turn not in {"server_vad", "smart_turn", "smart_turn_v2"}:
            raise ValueError("Unsupported Qwen turn detection")
        history = int(env.get("VOICE_CENTER_QWEN_HISTORY_TURNS", "10"))
        rate = float(env.get("VOICE_CENTER_QWEN_SPEECH_RATE", "1"))
        if not 1 <= history <= 50 or not 0.5 <= rate <= 2:
            raise ValueError("Invalid Qwen history turns or speech rate")
        prints = json.loads(env.get("VOICE_CENTER_QWEN_VOICEPRINT_URLS", "[]"))
        if not isinstance(prints, list) or len(prints) > 5 or any(
            not isinstance(v, str) or urlsplit(v).scheme != "https" or not urlsplit(v).hostname
            or urlsplit(v).username or urlsplit(v).password for v in prints
        ):
            raise ValueError("VOICE_CENTER_QWEN_VOICEPRINT_URLS must contain at most five HTTPS URLs")
        if prints and turn == "server_vad":
            raise ValueError("Speaker enhancement requires smart_turn or smart_turn_v2")
        return cls(urlunsplit(endpoint._replace(query=urlencode(query))), key,
                   voice=env.get("VOICE_CENTER_QWEN_VOICE", "longanqian_v3.1"),
                   emotion=boolean(env, "VOICE_CENTER_QWEN_EMOTION", True),
                   turn_detection=turn, history_turns=history, speech_rate=rate, voiceprints=tuple(prints))

    def session(self, instructions, tools):
        turn = {"type": self.turn_detection}
        if self.voiceprints:
            turn["voiceprint_audio_urls"] = list(self.voiceprints)
        return {"modalities": ["text", "audio"], "voice": self.voice,
                "input_audio_format": "pcm", "output_audio_format": "pcm",
                "input_audio_transcription": {"language": "zh"},
                "enable_speech_emotion": self.emotion, "speech_rate": self.speech_rate,
                "max_history_turns": self.history_turns, "turn_detection": turn,
                "instructions": instructions, "tools": tools}
