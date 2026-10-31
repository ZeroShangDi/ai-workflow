"""Loopback-only WebRTC endpoint owned by the Voice Control plugin."""

import asyncio
from contextlib import asynccontextmanager
import json
import os

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from loguru import logger
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.workers.runner import WorkerRunner

from .pipeline import build_pipeline
from .providers import required
from .tickets import verify_ticket


def create_app():
    secret = required("VOICE_CONTROL_TICKET_SECRET")
    if len(secret) < 32:
        raise RuntimeError("VOICE_CONTROL_TICKET_SECRET must be at least 32 characters")
    maximum_sessions = max(1, min(16, int(os.environ.get("VOICE_CONTROL_RUNTIME_MAX_SESSIONS", "4"))))
    logger.remove()
    used, sessions = {}, {}
    lock = asyncio.Lock()

    @asynccontextmanager
    async def lifespan(_app):
        yield
        pending = list(sessions.values())
        for connection, task in pending:
            task.cancel()
            try:
                await asyncio.wait_for(connection.disconnect(), 3)
            except Exception:
                pass
        await asyncio.gather(*(task for _, task in pending), return_exceptions=True)

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def headers(request, call_next):
        response = await call_next(request)
        response.headers.update({
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
        })
        return response

    @app.get("/health")
    async def health():
        return {
            "status": "ok",
            "sessions": len(sessions),
            "maximumSessions": maximum_sessions,
            "serverVad": True,
            "continuousTurns": True,
            "bargeIn": True,
            "streamingTts": True,
        }

    @app.post("/offer")
    async def offer(request: Request):
        try:
            identity = verify_ticket(
                request.headers.get("Authorization", "").removeprefix("Bearer "),
                secret,
                used,
            )
        except ValueError:
            raise HTTPException(401, "Voice session credential is invalid") from None
        async with lock:
            if len(sessions) >= maximum_sessions:
                raise HTTPException(429, "Too many voice sessions")
            raw = bytearray()
            async for chunk in request.stream():
                raw.extend(chunk)
                if len(raw) > 64000:
                    raise HTTPException(413, "Request too large")
            try:
                data = json.loads(raw)
                if data.get("type") != "offer" or not isinstance(data.get("sdp"), str):
                    raise ValueError("Invalid offer")
            except (ValueError, AttributeError):
                raise HTTPException(400, "Invalid voice offer") from None
            connection = SmallWebRTCConnection()
            try:
                await asyncio.wait_for(connection.initialize(sdp=data["sdp"], type="offer"), 15)
                identity["host_task_bridge"] = data.get("host_task_bridge") is True
                identity["host_plugin_bridge"] = False
                worker = build_pipeline(connection, identity)
            except Exception:
                await connection.disconnect()
                raise HTTPException(503, "Voice runtime is not ready") from None

            async def run():
                try:
                    runner = WorkerRunner(handle_sigint=False)
                    await runner.add_workers(worker)
                    await runner.run()
                except asyncio.CancelledError:
                    raise
                except Exception:
                    connection.send_app_message({
                        "type": "voice",
                        "state": "error",
                        "message": "Voice connection ended; please reopen",
                    })
                finally:
                    try:
                        await worker.cancel()
                    finally:
                        try:
                            await connection.disconnect()
                        finally:
                            sessions.pop(connection.pc_id, None)

            task = asyncio.create_task(run())
            sessions[connection.pc_id] = (connection, task)
            return JSONResponse(connection.get_answer())

    return app


def main():
    import uvicorn

    host = os.environ.get("VOICE_CONTROL_RUNTIME_HOST", "127.0.0.1")
    port = int(os.environ.get("VOICE_CONTROL_RUNTIME_PORT", "0"))
    uvicorn.run(create_app(), host=host, port=port, access_log=False)


if __name__ == "__main__":
    main()
