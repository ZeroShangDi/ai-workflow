"""ASR, conversation and streaming PCM TTS adapters used by the local runtime."""

import asyncio
import logging
import os
import re
from collections.abc import AsyncGenerator
from urllib.parse import urlsplit

import httpx
from pipecat.frames.frames import ErrorFrame, Frame, TranscriptionFrame, TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.openai.stt import OpenAISTTService
from pipecat.services.settings import STTSettings, TTSSettings
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.services.tts_service import TTSService
from pipecat.transcriptions.language import Language
from pipecat.utils.time import time_now_iso8601


def _file_value(value: str | None) -> str:
    return value.strip() if isinstance(value, str) else ""


def secret(name: str, default: str | None = None) -> str:
    value = _file_value(os.environ.get(name))
    file_path = _file_value(os.environ.get(name + "_FILE"))
    if file_path:
        with open(file_path, "r", encoding="utf-8") as stream:
            value = stream.read().strip()
    if value:
        return value
    if default is not None:
        return default
    raise RuntimeError(f"Missing {name}")


def required(name: str) -> str:
    return secret(name)


def voice_llm_extra() -> dict:
    if urlsplit(required("VOICE_CONTROL_LLM_URL")).hostname == "api.deepseek.com":
        return {"extra_body": {"thinking": {"type": "disabled"}}}
    return {}


class VoiceLLMService(OpenAILLMService):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.supports_developer_role = urlsplit(kwargs.get("base_url", "")).hostname != "api.deepseek.com"


class MlxASRService(SegmentedSTTService):
    def __init__(self):
        self.url = required("VOICE_CONTROL_ASR_URL").rstrip("/") + "/audio/transcribe"
        self.key = secret("VOICE_CONTROL_ASR_API_KEY", "local")
        super().__init__(
            sample_rate=16000,
            settings=STTSettings(
                model=os.environ.get("VOICE_CONTROL_ASR_MODEL", "qwen3-asr"),
                language=Language.ZH,
            ),
        )

    async def run_stt(self, audio: bytes):
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(45, connect=3),
                follow_redirects=False,
                trust_env=False,
            ) as client:
                response = await client.post(
                    self.url,
                    content=audio,
                    headers={"Authorization": "Bearer " + self.key, "Content-Type": "audio/wav"},
                )
                response.raise_for_status()
                text = response.json()["text"]
                if not isinstance(text, str) or len(text) > 6000:
                    raise ValueError()
                if text.strip():
                    yield TranscriptionFrame(text.strip(), self._user_id, time_now_iso8601(), finalized=True)
        except (httpx.HTTPError, ValueError, KeyError) as error:
            logging.getLogger(__name__).warning(
                "asr_failed error_type=%s status=%s",
                type(error).__name__,
                error.response.status_code if isinstance(error, httpx.HTTPStatusError) else None,
            )
            yield ErrorFrame("语音识别失败，请再说一次")


def create_stt():
    mode = os.environ.get("VOICE_CONTROL_ASR_PROTOCOL", "qwen-mlx-http")
    if mode == "qwen-mlx-http":
        return MlxASRService()
    if mode != "openai-http":
        raise RuntimeError("Unsupported VOICE_CONTROL_ASR_PROTOCOL")
    options = dict(
        api_key=secret("VOICE_CONTROL_ASR_API_KEY", "local"),
        base_url=required("VOICE_CONTROL_ASR_URL"),
    )
    return OpenAISTTService(
        **options,
        settings=OpenAISTTService.Settings(
            model=os.environ.get("VOICE_CONTROL_ASR_MODEL", "whisper-1"),
            language=Language.ZH,
        ),
    )


def speech_segments(text: str):
    for sentence in re.findall(r"[^。！？!?；;]+[。！？!?；;]?|[。！？!?；;]", text):
        sentence = sentence.strip()
        if not any(char.isalnum() for char in sentence):
            continue
        while len(sentence) > 120:
            head = sentence[:120]
            boundary = max(head.rfind(mark) for mark in "，,、：:")
            cut = boundary + 1 if boundary >= 40 else 120
            if any(char.isalnum() for char in sentence[:cut]):
                yield sentence[:cut]
            sentence = sentence[cut:]
        if any(char.isalnum() for char in sentence):
            yield sentence


class StreamingPCMService(TTSService):
    """OpenAI-compatible speech endpoint returning signed 16-bit little-endian PCM."""

    def __init__(self, voice: str | None = None):
        self.url = required("VOICE_CONTROL_TTS_URL").rstrip("/") + "/audio/speech"
        self.key = secret("VOICE_CONTROL_TTS_API_KEY", "local")
        self.model = os.environ.get("VOICE_CONTROL_TTS_MODEL", "qwen3-tts")
        self.voice = voice or os.environ.get("VOICE_CONTROL_TTS_VOICE", "default")
        super().__init__(
            sample_rate=int(os.environ.get("VOICE_CONTROL_TTS_SAMPLE_RATE", "24000")),
            settings=TTSSettings(model=self.model, voice=self.voice, language=Language.ZH),
        )

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        yield TTSStartedFrame(context_id=context_id)
        try:
            async with asyncio.timeout(90), httpx.AsyncClient(
                timeout=httpx.Timeout(30, connect=5),
                follow_redirects=False,
                trust_env=False,
            ) as client:
                for segment in speech_segments(text):
                    for attempt in range(9):
                        async with client.stream(
                            "POST",
                            self.url,
                            headers={"Authorization": f"Bearer {self.key}"},
                            json={
                                "model": self.model,
                                "voice": self.voice,
                                "input": segment,
                                "response_format": "pcm",
                                "stream": True,
                            },
                        ) as response:
                            if response.status_code == 429 and attempt < 8:
                                await asyncio.sleep(0.25 * (attempt + 1))
                                continue
                            response.raise_for_status()
                            content_type = response.headers.get("content-type", "").split(";")[0]
                            if content_type not in {"audio/pcm", "audio/raw", "application/octet-stream"}:
                                raise ValueError("Expected raw PCM")
                            pending, received = b"", 0
                            max_bytes = int(min(45, max(8, len(segment) * 0.6)) * self.sample_rate * 2)
                            async for chunk in response.aiter_bytes(chunk_size=4800):
                                pending += chunk
                                size = len(pending) // 2 * 2
                                if size:
                                    received += size
                                    if received > max_bytes:
                                        raise ValueError("Speech exceeded duration budget")
                                    yield TTSAudioRawFrame(pending[:size], self.sample_rate, 1, context_id=context_id)
                                    pending = pending[size:]
                            if pending or not received:
                                raise ValueError("Incomplete PCM")
                            break
        except (httpx.HTTPError, ValueError, TimeoutError) as error:
            logging.getLogger(__name__).warning(
                "tts_failed error_type=%s status=%s",
                type(error).__name__,
                error.response.status_code if isinstance(error, httpx.HTTPStatusError) else None,
            )
            yield ErrorFrame("语音合成失败，可以继续对话")
        finally:
            yield TTSStoppedFrame(context_id=context_id)
