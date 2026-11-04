"""Optional Qwen duplex runtime. Provider and emotion policies stay in this package."""
import os


def enabled():
    mode = os.environ.get("VOICE_CENTER_VOICE_MODE", "pipeline")
    if mode not in {"pipeline", "qwen-realtime"}:
        raise ValueError("VOICE_CENTER_VOICE_MODE must be pipeline or qwen-realtime")
    return mode == "qwen-realtime"


def build_pipeline(connection, identity):
    from .pipeline import build_pipeline as build
    return build(connection, identity)
