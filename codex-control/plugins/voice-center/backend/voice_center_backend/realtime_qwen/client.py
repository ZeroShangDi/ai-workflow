"""One authenticated provider connection; never reconnect or replay audio/tool writes."""
import asyncio
import base64
import json
import uuid


class RealtimeClient:
    def __init__(self, config, on_event, on_failure, connect=None):
        self.config, self.on_event, self.on_failure = config, on_event, on_failure
        self.connect = connect
        self.socket = None
        self.reader = None
        self.ready = asyncio.Event()
        self.closed = False
        self.send_lock = asyncio.Lock()

    async def start(self, session):
        if self.connect is None:
            from websockets.asyncio.client import connect
            self.connect = connect
        try:
            self.socket = await self.connect(self.config.url,
                additional_headers={"Authorization": "Bearer " + self.config.api_key},
                open_timeout=10, close_timeout=3, max_size=1024 * 1024,
                max_queue=16, ping_interval=20, ping_timeout=20, proxy=None)
            self.reader = asyncio.create_task(self._read())
            await self.send({"type": "session.update", "session": session})
            await asyncio.wait_for(self.ready.wait(), 10)
            if self.closed:
                raise RuntimeError("Qwen session setup failed")
        except BaseException:
            await self.close()
            raise

    async def send(self, event):
        if self.closed or self.socket is None:
            raise RuntimeError("Qwen session is unavailable; reopen voice to reconnect")
        async with self.send_lock:
            await asyncio.wait_for(self.socket.send(json.dumps({
                "event_id": "evt_" + str(uuid.uuid4()), **event}, ensure_ascii=False)), 10)

    async def audio(self, pcm):
        if not self.ready.is_set() or self.closed:
            return
        # 20 ms packets. Never gate on local VAD: Qwen owns the acoustic context.
        for offset in range(0, len(pcm), 640):
            await self.send({"type": "input_audio_buffer.append",
                             "audio": base64.b64encode(pcm[offset:offset + 640]).decode()})

    async def _read(self):
        try:
            async for raw in self.socket:
                event = json.loads(raw)
                if not isinstance(event, dict):
                    raise ValueError("Invalid provider event")
                if event.get("type") == "session.updated":
                    self.ready.set()
                elif event.get("type") == "error":
                    # Provider messages can contain prompts, identifiers or credentials.
                    raise RuntimeError("Qwen rejected the session request")
                else:
                    await self.on_event(event)
            if not self.closed:
                raise RuntimeError("Qwen connection ended")
        except asyncio.CancelledError:
            raise
        except Exception:
            if not self.closed:
                self.closed = True
                self.ready.set()
                await self.on_failure()
        finally:
            if self.socket:
                await self.socket.close()

    async def close(self):
        self.closed = True
        self.ready.set()
        if self.reader and self.reader is not asyncio.current_task():
            self.reader.cancel()
            await asyncio.gather(self.reader, return_exceptions=True)
        if self.socket:
            await self.socket.close()
