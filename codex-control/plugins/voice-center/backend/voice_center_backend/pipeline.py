"""Pipecat owns audio turns, interruptions, generation cancellation and aggregation."""
import logging

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import BotStartedSpeakingFrame, BotStoppedSpeakingFrame, UserStartedSpeakingFrame, ErrorFrame, TranscriptionFrame, AggregatedTextFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker, PipelineParams
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy

from .plugin_host import PluginHost
from .work_bridge import WorkAnnouncements
from .character import character_context
from .persistence import TranscriptStore
from .providers import create_stt, StreamingPCMService, VoiceLLMService, required, voice_llm_extra

SYSTEM = """你是统子哥的语音对话助手。用自然简短的中文交流，通常一到三句，不使用 Markdown。
日常对话直接回答；其他能力按已装载插件的工具和指引使用。角色资料只约束交流风格，当前插件协议决定能力用法。
不要声称执行了未执行的操作，没有结果时不要编造。用户插话后以最新问题为准。
"""


class VoiceTranscripts(FrameProcessor):
    def __init__(self, connection, store, plugins, identity):
        super().__init__()
        self.connection = connection
        self.store = store
        self.plugins = plugins
        self.identity = identity

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, TranscriptionFrame) and frame.text.strip():
            self.connection.send_app_message({"type": "transcript", "role": "user", "text": frame.text[:6000]})
            self.store.append("user", frame.text, identity=self.identity)
            self.plugins.record_transcript("user", frame.text, self.identity)
        await self.push_frame(frame, direction)


class VoiceStates(FrameProcessor):
    def __init__(self, connection, announcements, store, plugins, identity):
        super().__init__()
        self.connection = connection
        self.announcements = announcements
        self.store = store
        self.plugins = plugins
        self.identity = identity

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if self.announcements: self.announcements.observe(frame)
        if isinstance(frame, ErrorFrame):
            self.connection.send_app_message({"type": "voice", "state": "warning", "message": "这次语音处理失败，可以继续说话或让我再说一次"})
        elif direction == FrameDirection.DOWNSTREAM:
            if type(frame) is AggregatedTextFrame and frame.will_be_spoken and frame.text.strip():
                self.store.append("assistant", frame.text, identity=self.identity)
                self.plugins.record_transcript("assistant", frame.text, self.identity)
                # Show the sentence scheduled by TTS output, rather than raw speculative LLM deltas.
                self.connection.send_app_message({"type": "transcript", "role": "assistant", "text": frame.text[:6000]})
            elif isinstance(frame, UserStartedSpeakingFrame):
                self.connection.send_app_message({"type": "voice", "state": "listening", "event": "user_started"})
            elif isinstance(frame, BotStartedSpeakingFrame):
                self.connection.send_app_message({"type": "voice", "state": "speaking", "event": "bot_started"})
            elif isinstance(frame, BotStoppedSpeakingFrame):
                self.connection.send_app_message({"type": "voice", "state": "listening", "event": "bot_stopped"})
        await self.push_frame(frame, direction)


def build_pipeline(connection, identity):
    transport = SmallWebRTCTransport(connection, TransportParams(audio_in_enabled=True, audio_out_enabled=True))
    stt, tts = create_stt(), StreamingPCMService(voice=identity.get("character") or None)
    llm = VoiceLLMService(api_key=required("VOICE_LLM_API_KEY"), base_url=required("VOICE_LLM_URL"),
                           settings=VoiceLLMService.Settings(model=required("VOICE_LLM_MODEL"), max_tokens=600, extra=voice_llm_extra()))
    persona = character_context(identity)
    context = LLMContext(messages=[])
    plugins = PluginHost(connection, identity, context)
    store = TranscriptStore()
    context.add_message({"role": "system", "content": SYSTEM + persona + "\n" + "\n".join(plugins.instructions)})
    context.set_tools([spec for spec, _ in plugins.specs])
    plugins.register(llm)
    announcements = WorkAnnouncements(connection, context, prepare_notice=plugins.prepare_notice,
        on_close=plugins.close, notice_delivered=plugins.notice_delivered)

    @transport.event_handler('on_app_message')
    async def app_message(_transport, message, _sender):
        plugins.bridge.receive(message)
        if identity.get('host_task_bridge'): announcements.receive(message)

    aggregators = LLMContextAggregatorPair(context, user_params=LLMUserAggregatorParams(
        vad_analyzer=SileroVADAnalyzer(params=VADParams(start_secs=0.15, stop_secs=0.3)),
        user_turn_strategies=UserTurnStrategies(stop=[SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=0.6)])))
    worker = PipelineWorker(Pipeline([transport.input(), stt, VoiceTranscripts(connection, store, plugins, identity), aggregators.user(), llm, announcements, tts,
                                      transport.output(), VoiceStates(connection, announcements, store, plugins, identity), aggregators.assistant()]),
                            enable_rtvi=False, idle_timeout_secs=None, params=PipelineParams(audio_in_sample_rate=16000, audio_out_sample_rate=24000))

    @worker.event_handler("on_pipeline_error")
    async def pipeline_error(_worker, frame):
        logging.getLogger(__name__).warning('voice_pipeline_error processor=%s exception=%s status=%s category=%s',
            type(frame.processor).__name__, type(frame.exception).__name__,
            getattr(frame.exception, 'status_code', None), frame.category)
        # Provider errors travel upstream and never reach the output state observer.
        connection.send_app_message({"type": "voice", "state": "error" if frame.fatal else "warning",
            "message": "语音连接已结束，请重新打开" if frame.fatal else "这次语音处理失败，可以继续说话或让我再说一次"})

    @transport.event_handler("on_client_disconnected")
    async def disconnected(_transport, _client):
        await worker.cancel()

    return worker
