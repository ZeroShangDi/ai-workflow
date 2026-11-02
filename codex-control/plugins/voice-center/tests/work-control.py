"""Host transcript authorization and public WebSocket protocol tests; no providers required."""
import asyncio
import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

# This suite owns the transport double; it runs without audio/provider dependencies.
transport = types.ModuleType("websockets")
sys.modules["websockets"] = transport
source = Path(__file__).resolve().parents[1] / "backend/voice_center_backend/capabilities/work_control/__init__.py"
spec = importlib.util.spec_from_file_location("work_control", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Socket:
    def __init__(self, topic="control.chat.reply"):
        self.queue = asyncio.Queue()
        self.events = []
        self.topic = topic

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def send(self, raw):
        value = json.loads(raw)
        if value["type"] == "hello":
            await self.queue.put({"type": "hello.ack"})
        elif value["type"] == "subscribe":
            await self.queue.put({"type": "replay.complete"})
        else:
            if value["event"]["source"] != "voice-center-runtime":
                raise AssertionError("event source must match authenticated client")
            self.events.append(value["event"])
            await self.queue.put({"type": "event", "event": {
                "topic": self.topic, "correlationId": value["event"]["correlationId"],
                "payload": {"text": "请确认任务摘要", "message": "busy"}
            }})

    async def recv(self):
        return json.dumps(await self.queue.get())


class Tests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.work = module.WorkControl(identity={})

    async def test_no_model_supplied_authorization(self):
        with self.assertRaises(RuntimeError):
            await self.work.execute("control_work", {"user_quote": "确认"})
        self.work.record_transcript("assistant", "确认", {})
        with self.assertRaises(RuntimeError):
            await self.work.execute("control_work", {})

    async def test_request_and_confirmation_use_real_turn_once(self):
        socket = Socket()
        config = {"url": "ws://127.0.0.1:1", "token_file": "/fake", "voice_session_id": "fixed"}
        with patch.object(module, "_load_config", return_value=config), patch.object(
            module.Path, "read_text", return_value="x" * 32
        ), patch.object(transport, "connect", return_value=socket, create=True):
            for text in ["帮我检查项目", "确认"]:
                self.work.record_transcript("user", text, {})
                result = await self.work.execute("control_work", {"user_quote": "伪造内容"})
                self.assertEqual(result["text"], "请确认任务摘要")
                with self.assertRaises(RuntimeError):
                    await self.work.execute("control_work", {})
        self.assertEqual([e["payload"]["text"] for e in socket.events], ["帮我检查项目", "确认"])
        self.assertTrue(all(e["topic"] == "voice.chat.user" for e in socket.events))

    async def test_unknown_write_not_replayed_and_new_turn_retained(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def request(text):
            entered.set()
            await release.wait()
            raise TimeoutError("unknown write")
        self.work._record_user_turn = request
        self.work.record_transcript("user", "任务", {})
        running = asyncio.create_task(self.work.execute("control_work", {}))
        await entered.wait()
        self.work.record_transcript("user", "确认", {})
        with self.assertRaises(RuntimeError):
            await self.work.execute("control_work", {})
        release.set()
        with self.assertRaises(TimeoutError):
            await running
        self.assertFalse(self.work.latest_turn["consumed"])
        with self.assertRaises(TimeoutError):
            await self.work.execute("control_work", {})
        with self.assertRaises(RuntimeError):
            await self.work.execute("control_work", {})

    async def test_chat_failure_is_not_success(self):
        socket = Socket("control.chat.failed")
        config = {"url": "ws://127.0.0.1:1", "token_file": "/fake", "voice_session_id": "fixed"}
        with patch.object(module, "_load_config", return_value=config), patch.object(
            module.Path, "read_text", return_value="x" * 32
        ), patch.object(transport, "connect", return_value=socket, create=True):
            self.work.record_transcript("user", "任务", {})
            with self.assertRaisesRegex(RuntimeError, "busy"):
                await self.work.execute("control_work", {})

if __name__ == "__main__":
    unittest.main()
