"""Pipecat pipeline owned by the Voice Control plugin."""

import asyncio
import logging
import time
from dataclasses import dataclass

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    AggregatedTextFrame,
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    CancelFrame,
    ControlFrame,
    EndFrame,
    ErrorFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    StartFrame,
    TranscriptionFrame,
    TTSSpeakFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies

from .providers import StreamingPCMService, VoiceLLMService, create_stt, required, voice_llm_extra

SYSTEM = """你是 Voice Control 的语音助手。用自然、简短的中文回答，通常一到三句，不使用 Markdown。
日常聊天直接回答；需要任务、文件或工具时，严格使用当前会话已经加载的能力。
不要声称执行了未执行的操作，没有结果时不要编造。用户插话后以最新问题为准。
"""


class VoiceTranscripts(FrameProcessor):
    def __init__(self, connection):
        super().__init__()
        self.connection = connection

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, TranscriptionFrame) and frame.text.strip():
            self.connection.send_app_message({
                "type": "transcript",
                "role": "user",
                "text": frame.text[:6000],
            })
        await self.push_frame(frame, direction)


class VoiceStates(FrameProcessor):
    def __init__(self, connection, announcements):
        super().__init__()
        self.connection = connection
        self.announcements = announcements

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        self.announcements.observe(frame)
        if isinstance(frame, ErrorFrame):
            self.connection.send_app_message({
                "type": "voice",
                "state": "warning",
                "message": "这次语音处理失败，可以继续说话或让我再说一次",
            })
        elif direction == FrameDirection.DOWNSTREAM:
            if type(frame) is AggregatedTextFrame and frame.will_be_spoken and frame.text.strip():
                self.connection.send_app_message({
                    "type": "transcript",
                    "role": "assistant",
                    "text": frame.text[:6000],
                })
            elif isinstance(frame, UserStartedSpeakingFrame):
                self.connection.send_app_message({
                    "type": "voice",
                    "state": "listening",
                    "event": "user_started",
                })
            elif isinstance(frame, BotStartedSpeakingFrame):
                self.connection.send_app_message({
                    "type": "voice",
                    "state": "speaking",
                    "event": "bot_started",
                })
            elif isinstance(frame, BotStoppedSpeakingFrame):
                self.connection.send_app_message({
                    "type": "voice",
                    "state": "listening",
                    "event": "bot_stopped",
                })
        await self.push_frame(frame, direction)


@dataclass
class WorkNoticeEndFrame(ControlFrame):
    notice_id: str


class TaskAnnouncements(FrameProcessor):
    """Speak task notices only while the conversation is idle and acknowledge observed playback."""

    def __init__(self, connection):
        super().__init__()
        self.connection = connection
        self.pending = {}
        self.accepted = set()
        self.busy = False
        self.user_speaking = False
        self.bot_speaking = False
        self.llm_active = False
        self.waiting_reply = False
        self.quiet_since = time.monotonic()
        self.loop = None
        self.speaking_notice = None

    def observe(self, frame):
        if isinstance(frame, UserStartedSpeakingFrame):
            self.user_speaking = True
            self.waiting_reply = True
            self.speaking_notice = None
        elif isinstance(frame, UserStoppedSpeakingFrame):
            self.user_speaking = False
            self.quiet_since = time.monotonic()
        elif isinstance(frame, LLMFullResponseStartFrame):
            self.llm_active = True
        elif isinstance(frame, LLMFullResponseEndFrame):
            self.llm_active = False
        elif isinstance(frame, BotStartedSpeakingFrame):
            self.bot_speaking = True
            if not self.user_speaking:
                self.waiting_reply = False
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self.bot_speaking = False
            self.quiet_since = time.monotonic()
        elif isinstance(frame, WorkNoticeEndFrame) and self.speaking_notice == frame.notice_id:
            notice_id = self.speaking_notice
            self.speaking_notice = None
            self.quiet_since = time.monotonic()
            self.connection.send_app_message({"type": "task_notice_ack", "id": notice_id})
        self.busy = self.user_speaking or self.bot_speaking or self.llm_active or self.waiting_reply

    def receive(self, message):
        if not isinstance(message, dict):
            return
        if message.get("type") == "task_notice_cancel":
            if isinstance(message.get("id"), str):
                self.pending.pop(message["id"], None)
            return
        if message.get("type") != "task_notice":
            return
        key, text = message.get("id"), message.get("text")
        if not isinstance(key, str) or len(key) > 100 or not isinstance(text, str) or not 0 < len(text) <= 1000:
            return
        if key not in self.accepted and len(self.pending) < 10:
            self.pending[key] = {"id": key, "text": text}

    async def run_notices(self):
        while True:
            await asyncio.sleep(0.3)
            if self.busy or self.speaking_notice or not self.pending:
                continue
            if time.monotonic() - self.quiet_since < 2:
                continue
            key = next(iter(self.pending))
            notice = self.pending.pop(key)
            text = notice["text"].strip()
            if not text:
                self.accepted.add(key)
                self.connection.send_app_message({"type": "task_notice_ack", "id": key})
                continue
            self.busy = True
            self.speaking_notice = key
            self.accepted.add(key)
            await self.push_frame(TTSSpeakFrame(text=text))
            await self.push_frame(WorkNoticeEndFrame(notice_id=key))

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        self.observe(frame)
        if isinstance(frame, StartFrame) and self.loop is None:
            self.loop = asyncio.create_task(self.run_notices())
        if isinstance(frame, (EndFrame, CancelFrame)):
            await self.stop()
        await self.push_frame(frame, direction)

    async def stop(self):
        if self.loop:
            self.loop.cancel()
            await asyncio.gather(self.loop, return_exceptions=True)
            self.loop = None

    async def cleanup(self):
        await self.stop()
        await super().cleanup()


def build_pipeline(connection, identity):
    transport = SmallWebRTCTransport(
        connection,
        TransportParams(audio_in_enabled=True, audio_out_enabled=True),
    )
    stt = create_stt()
    tts = StreamingPCMService(voice=identity.get("character") or None)
    llm = VoiceLLMService(
        api_key=required("VOICE_CONTROL_LLM_API_KEY"),
        base_url=required("VOICE_CONTROL_LLM_URL"),
        settings=VoiceLLMService.Settings(
            model=required("VOICE_CONTROL_LLM_MODEL"),
            max_tokens=600,
            extra=voice_llm_extra(),
        ),
    )
    context = LLMContext(messages=[{"role": "system", "content": SYSTEM}])
    announcements = TaskAnnouncements(connection)

    @transport.event_handler("on_app_message")
    async def app_message(_transport, message, _sender):
        announcements.receive(message)

    aggregators = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(params=VADParams(start_secs=0.15, stop_secs=0.3)),
            user_turn_strategies=UserTurnStrategies(
                stop=[SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=0.6)],
            ),
        ),
    )
    worker = PipelineWorker(
        Pipeline([
            transport.input(),
            stt,
            VoiceTranscripts(connection),
            aggregators.user(),
            llm,
            announcements,
            tts,
            transport.output(),
            VoiceStates(connection, announcements),
            aggregators.assistant(),
        ]),
        enable_rtvi=False,
        idle_timeout_secs=None,
        params=PipelineParams(audio_in_sample_rate=16000, audio_out_sample_rate=24000),
    )

    @worker.event_handler("on_pipeline_error")
    async def pipeline_error(_worker, frame):
        logging.getLogger(__name__).warning(
            "voice_pipeline_error processor=%s exception=%s status=%s category=%s",
            type(frame.processor).__name__,
            type(frame.exception).__name__,
            getattr(frame.exception, "status_code", None),
            frame.category,
        )
        connection.send_app_message({
            "type": "voice",
            "state": "error" if frame.fatal else "warning",
            "message": "语音连接已结束，请重新打开" if frame.fatal else "这次语音处理失败，可以继续说话或让我再说一次",
        })

    @transport.event_handler("on_client_disconnected")
    async def disconnected(_transport, _client):
        await worker.cancel()

    return worker
