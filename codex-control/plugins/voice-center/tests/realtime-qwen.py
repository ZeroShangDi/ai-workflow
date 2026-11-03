"""Provider-free tests for the duplex boundary and authorization lifecycle."""
import asyncio
import base64
import json
import importlib.util
import os
import tempfile
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from voice_center_backend.realtime_qwen import enabled
from voice_center_backend.realtime_qwen.config import Config
from voice_center_backend.realtime_qwen.client import RealtimeClient
from voice_center_backend.realtime_qwen.session import RealtimeSession


class ConfigTests(unittest.TestCase):
    def test_default_pipeline_and_strict_mode(self):
        with patch.dict("os.environ", {}, clear=True):
            self.assertFalse(enabled())
        with patch.dict("os.environ", {"VOICE_CENTER_VOICE_MODE": "qwen-realtime"}):
            self.assertTrue(enabled())
        with patch.dict("os.environ", {"VOICE_CENTER_VOICE_MODE": "typo"}):
            with self.assertRaises(ValueError): enabled()

    def config(self, **extra):
        return Config.load({"VOICE_CENTER_QWEN_API_KEY": "private-key",
            "VOICE_CENTER_QWEN_REALTIME_URL": "wss://example.test/realtime", **extra})

    def test_emotion_and_smart_turn_are_module_owned(self):
        value = self.config()
        session = value.session("persona", [])
        self.assertEqual(session["turn_detection"], {"type": "smart_turn_v2"})
        self.assertTrue(session["enable_speech_emotion"])
        self.assertIn("model=qwen-audio-3.1-realtime-flash", value.url)
        self.assertNotIn("private-key", repr(value))
        self.assertFalse(self.config(VOICE_CENTER_QWEN_EMOTION="false").emotion)
        for extra in [{"VOICE_CENTER_QWEN_HISTORY_TURNS": "0"},
                      {"VOICE_CENTER_QWEN_REALTIME_URL": "ws://example.test"},
                      {"VOICE_CENTER_QWEN_REALTIME_URL": "wss://example.test?token=secret"},
                      {"VOICE_CENTER_QWEN_EMOTION": "maybe"}]:
            with self.assertRaises(ValueError): self.config(**extra)


class Socket:
    def __init__(self):
        self.messages = []
        self.queue = asyncio.Queue()
        self.closed = False
    async def send(self, raw):
        value = json.loads(raw)
        self.messages.append(value)
        if value["type"] == "session.update":
            await self.queue.put(json.dumps({"type": "session.updated"}))
    def __aiter__(self): return self
    async def __anext__(self):
        value = await self.queue.get()
        if value is None: raise StopAsyncIteration
        return value
    async def close(self): self.closed = True


class ClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_handshake_continuous_audio_and_no_reconnect(self):
        socket, events, failures, connects = Socket(), [], [], []
        async def connect(url, **options):
            connects.append(options)
            return socket
        async def event(value): events.append(value)
        async def failed(): failures.append(True)
        client = RealtimeClient(Config("wss://example.test", "secret"), event, failed, connect)
        await client.start({"turn_detection": {"type": "smart_turn_v2"}})
        await client.audio(bytes(1280))  # Silence is still sent, twice, without VAD gating.
        self.assertEqual([m["type"] for m in socket.messages],
                         ["session.update", "input_audio_buffer.append", "input_audio_buffer.append"])
        self.assertEqual(connects[0]["additional_headers"], {"Authorization": "Bearer secret"})
        await socket.queue.put(json.dumps({"type": "error", "error": {"message": "secret"}}))
        await asyncio.wait_for(client.reader, 1)
        self.assertEqual(failures, [True])
        self.assertEqual(len(connects), 1)
        with self.assertRaises(RuntimeError):
            await client.send({"type": "response.create"})
        await client.close()
        self.assertTrue(socket.closed)


class Plugins:
    def __init__(self):
        self.turns, self.calls, self.delivered = [], [], []
        self.specs = [(SimpleNamespace(name="control_work"), self)]
        self.timeouts = {"control_work": 1}
        self.bridge = SimpleNamespace(receive=lambda value: None)
    def record_transcript(self, role, text, identity): self.turns.append((role, text))
    async def execute(self, name, args):
        self.calls.append((name, self.turns[-1], args))
        return {"text": "请确认任务摘要"}
    async def prepare_notice(self, notice): return notice["text"]
    def notice_delivered(self, key): self.delivered.append(key)
    def close(self): pass


class SessionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.output, self.sent, self.saved = [], [], []
        self.plugins = Plugins()
        async def send(value): self.sent.append(value)
        self.session = RealtimeSession(SimpleNamespace(send_app_message=self.output.append), self.plugins,
            SimpleNamespace(append=lambda role, text, **kw: self.saved.append((role, text))),
            {"host_task_bridge": True}, SimpleNamespace(send=send))

    async def turn(self, key="u1", text="帮我检查项目"):
        await self.session.event({"type": "input_audio_buffer.speech_started", "item_id": key})
        await self.session.event({"type": "input_audio_buffer.speech_stopped", "item_id": key})
        await self.session.event({"type": "conversation.item.input_audio_transcription.completed",
                                  "item_id": key, "transcript": text})

    async def response(self, key="r1"):
        await self.session.event({"type": "response.created", "response": {"id": key}})
        return self.session.responses[key]

    def call(self, key="c1"):
        return {"type": "function_call", "call_id": key, "name": "control_work", "arguments": '{"user_quote":"伪造确认"}'}

    async def test_real_transcript_and_call_id_are_consumed_once(self):
        await self.turn()
        response = await self.response()
        await self.session.tools([self.call()], response)
        await self.session.tools([self.call()], response)
        self.assertEqual(len(self.plugins.calls), 1)
        self.assertEqual(self.plugins.calls[0][1], ("user", "帮我检查项目"))
        self.assertEqual(sum(m["type"] == "conversation.item.create" for m in self.sent), 1)
        self.assertEqual(sum(m["type"] == "response.create" for m in self.sent), 1)

    async def test_no_user_transcript_or_notice_can_authorize_tools(self):
        response = await self.response()
        await self.session.tools([self.call()], response)
        await self.turn()
        response = await self.response("r2")
        response["notice"] = "notice"
        await self.session.tools([self.call("c2")], response)
        self.assertEqual(self.plugins.calls, [])

    async def test_old_turn_cannot_authorize_after_new_speech(self):
        await self.turn()
        response = await self.response()
        await self.turn("u2", "先别做")
        await self.session.tools([self.call()], response)
        self.assertEqual(self.plugins.calls, [])
        self.assertEqual([v["type"] for v in self.output].count("realtime.audio.cancel"), 1)

    async def test_late_transcript_does_not_replace_latest_turn(self):
        await self.session.event({"type": "input_audio_buffer.speech_started", "item_id": "u1"})
        await self.turn("u2", "取消")
        await self.session.event({"type": "conversation.item.input_audio_transcription.completed",
                                  "item_id": "u1", "transcript": "确认"})
        self.assertEqual(self.plugins.turns[-1], ("user", "取消"))
        await self.session.event({"type": "conversation.item.ambient_audio_transcription.completed",
                                  "item_id": "noise", "transcript": "确认"})
        self.assertEqual(self.plugins.turns[-1], ("user", "取消"))

    async def test_unknown_tool_result_is_not_replayed(self):
        await self.turn()
        response = await self.response()
        async def fail(name, args):
            self.plugins.calls.append(name)
            raise TimeoutError("unknown external write")
        self.plugins.execute = fail
        await self.session.tools([self.call()], response)
        await self.session.tools([self.call()], response)
        self.assertEqual(len(self.plugins.calls), 1)
        self.assertIn("not confirmed", self.sent[0]["item"]["output"])

    async def test_generation_done_is_not_playback_ack(self):
        await self.turn()
        self.session.pending_notice = "n1"
        response = await self.response()
        await self.session.event({"type": "response.audio.delta", "response_id": "r1",
                                  "delta": base64.b64encode(bytes(960)).decode()})
        await self.session.event({"type": "response.audio_transcript.done", "response_id": "r1", "transcript": "任务完成"})
        self.session.receive({"type": "realtime.playback.result", "playbackId": "r1", "status": "spoken"})
        self.assertEqual(self.plugins.delivered, [])
        await self.session.event({"type": "response.done", "response": {"id": "r1", "status": "completed"}})
        self.assertEqual(self.plugins.delivered, [])
        self.assertEqual(self.saved, [("user", "帮我检查项目")])
        self.session.receive({"type": "realtime.playback.result", "playbackId": "r1", "status": "spoken"})
        self.assertEqual(self.plugins.delivered, ["n1"])
        self.assertEqual(self.saved[-1], ("assistant", "任务完成"))

    async def test_interrupted_audio_cannot_be_marked_spoken(self):
        await self.turn()
        response = await self.response()
        response.update(audio=True, done=True, text="不能记录为已播放")
        await self.turn("u2", "停")
        self.session.receive({"type": "realtime.playback.result", "playbackId": "r1", "status": "spoken"})
        self.assertIn("r1", self.session.responses)
        self.session.receive({"type": "realtime.playback.result", "playbackId": "r1", "status": "interrupted"})
        self.assertNotIn("r1", self.session.responses)
        self.assertNotIn(("assistant", "不能记录为已播放"), self.saved)
        await self.session.event({"type": "response.done", "response": {"id": "r1", "status": "cancelled"}})
        self.assertIsNone(self.session.active_response)

    async def test_tool_response_waits_for_its_final_user_transcript(self):
        await self.session.event({"type": "input_audio_buffer.speech_started", "item_id": "u1"})
        await self.response()
        await self.session.event({"type": "response.done", "response": {
            "id": "r1", "status": "completed", "output": [self.call()]}})
        await asyncio.sleep(0)
        self.assertEqual(self.plugins.calls, [])
        # Empty audio on a function-only reply must not cancel the pending call.
        self.session.receive({"type": "realtime.playback.result", "playbackId": "r1", "status": "failed"})
        await self.session.event({"type": "conversation.item.input_audio_transcription.completed",
            "item_id": "u1", "transcript": "真实的确认"})
        await asyncio.gather(*self.session.tasks)
        self.assertEqual(self.plugins.calls[0][1], ("user", "真实的确认"))

    async def test_notice_flows_to_observed_playback_without_tools(self):
        self.session.quiet_since = 0
        self.session.receive({"type": "task_notice", "id": "n1", "text": "任务完成"})
        loop = asyncio.create_task(self.session.notices_loop())
        try:
            await asyncio.sleep(0.35)
            self.assertEqual(self.session.pending_notice, "n1")
            item_id = self.sent[0]["item"]["id"]
            response = await self.response()
            self.assertEqual(response["notice"], "n1")
            await self.session.event({"type": "response.audio.delta", "response_id": "r1",
                "delta": base64.b64encode(bytes(960)).decode()})
            await self.session.event({"type": "response.done", "response": {
                "id": "r1", "status": "completed"}})
            self.assertIn({"type": "conversation.item.delete", "item_id": item_id}, self.sent)
            self.assertEqual(self.plugins.delivered, [])
            self.session.receive({"type": "realtime.playback.result", "playbackId": "r1", "status": "spoken"})
            self.assertEqual(self.plugins.delivered, ["n1"])
            self.session.receive({"type": "task_notice", "id": "n1", "text": "任务完成"})
            self.assertEqual(self.session.notices, {})
        finally:
            loop.cancel()
            await asyncio.gather(loop, return_exceptions=True)


@unittest.skipUnless(importlib.util.find_spec("pipecat"), "Install the optional Python voice runtime for Pipecat integration")
class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_pipecat_worker_streams_pcm_and_closes_provider(self):
        from pipecat.frames.frames import InputAudioRawFrame, EndFrame
        from pipecat.pipeline.pipeline import Pipeline
        from pipecat.pipeline.worker import PipelineWorker, PipelineParams
        from pipecat.workers.runner import WorkerRunner
        from voice_center_backend.realtime_qwen.pipeline import QwenAudioProcessor
        output = []
        socket = Socket()
        async def connect(*args, **kwargs): return socket
        session = RealtimeSession(SimpleNamespace(send_app_message=output.append), Plugins(),
            SimpleNamespace(append=lambda *a, **kw: None), {})
        config = Config("wss://example.test", "fake-key")
        session.client = RealtimeClient(config, session.event, session.failed, connect)
        processor = QwenAudioProcessor(session, config.session("test", []))
        worker = PipelineWorker(Pipeline([processor]), enable_rtvi=False, idle_timeout_secs=None,
            params=PipelineParams(audio_in_sample_rate=16000, audio_out_sample_rate=24000))
        runner = WorkerRunner(handle_sigint=False)
        await runner.add_workers(worker)
        await worker.queue_frames([InputAudioRawFrame(audio=bytes(640), sample_rate=16000, num_channels=1), EndFrame()])
        await asyncio.wait_for(runner.run(), 15)
        self.assertEqual([m["type"] for m in socket.messages], ["session.update", "input_audio_buffer.append"])
        self.assertTrue(socket.closed)
        self.assertIsNone(processor.notice_task)

    async def test_real_websocket_round_trip_uses_host_transcription(self):
        from websockets.asyncio.server import serve
        output, saved = [], []
        plugins = Plugins()
        session = RealtimeSession(SimpleNamespace(send_app_message=output.append), plugins,
            SimpleNamespace(append=lambda role, text, **kw: saved.append((role, text))), {})
        finished = asyncio.Event()
        async def provider(socket):
            self.assertEqual(socket.request.headers["Authorization"], "Bearer fake-key")
            async for raw in socket:
                message = json.loads(raw)
                if message["type"] == "session.update":
                    await socket.send(json.dumps({"type": "session.updated"}))
                elif message["type"] == "input_audio_buffer.append":
                    for event in [
                        {"type": "input_audio_buffer.speech_started", "item_id": "u1"},
                        {"type": "input_audio_buffer.speech_stopped", "item_id": "u1"},
                        {"type": "conversation.item.input_audio_transcription.completed", "item_id": "u1", "transcript": "请检查项目"},
                        {"type": "response.created", "response": {"id": "r1"}},
                        {"type": "response.done", "response": {"id": "r1", "status": "completed", "output": [
                            {"type": "function_call", "call_id": "c1", "name": "control_work", "arguments": '{}'}]}},
                    ]:
                        await socket.send(json.dumps(event))
                elif message["type"] == "response.create":
                    finished.set()
        async with serve(provider, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RealtimeClient(Config(f"ws://127.0.0.1:{port}", "fake-key"), session.event, session.failed)
            session.client = client
            await client.start({"tools": []})
            await client.audio(bytes(640))
            await asyncio.wait_for(finished.wait(), 3)
            self.assertEqual(plugins.calls[0][1], ("user", "请检查项目"))
            self.assertEqual(saved, [("user", "请检查项目")])
            await session.close()


if __name__ == "__main__": unittest.main()
