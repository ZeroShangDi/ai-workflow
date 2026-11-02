"""Independent optional WebRTC endpoint; no business login or Agent implementation."""
import asyncio
from contextlib import asynccontextmanager
import json
import os

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from loguru import logger
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection

from .providers import required
from .tickets import verify_ticket
from .pipeline import build_pipeline
from .plugin_host import load_packages
from pipecat.workers.runner import WorkerRunner


def create_app():
    secret = required("VOICE_TICKET_SECRET")
    if len(secret) < 32:
        raise RuntimeError("VOICE_TICKET_SECRET must be at least 32 characters")
    # Dependency debug logs can contain transcriptions, SDP and prompts. Keep them out of logs.
    logger.remove()
    load_packages()  # Freeze plugin code and schema together before accepting calls.
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
        response.headers.update({"Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
                                 "X-Content-Type-Options": "nosniff",
                                 "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'"})
        return response

    @app.get("/health")
    async def health():
        return {"status": "ok", "speaker_verification": False}

    @app.post("/offer")
    async def offer(request: Request):
        # No await between checking/redeeming a ticket. One process owns the replay cache.
        try:
            identity = verify_ticket(request.headers.get("Authorization", "").removeprefix("Bearer "), secret, used)
        except ValueError:
            raise HTTPException(401, "语音会话凭据已失效，请重新打开") from None
        async with lock:
            if len(sessions) >= 4:
                raise HTTPException(429, "语音会话较多，请稍后重试")
            raw = bytearray()
            async for chunk in request.stream():
                raw.extend(chunk)
                if len(raw) > 64000:
                    raise HTTPException(413, "请求过大")
            try:
                data = json.loads(raw)
                if data.get("type") != "offer" or not isinstance(data.get("sdp"), str):
                    raise ValueError("Invalid offer")
            except (ValueError, AttributeError):
                raise HTTPException(400, "会话请求格式不正确") from None
            connection = SmallWebRTCConnection()
            try:
                await asyncio.wait_for(connection.initialize(sdp=data["sdp"], type="offer"), 15)
                identity["host_task_bridge"] = data.get("host_task_bridge") is True
                identity["host_plugin_bridge"] = data.get("host_plugin_bridge") is True
                worker = build_pipeline(connection, identity)
            except Exception:
                await connection.disconnect()
                raise HTTPException(503, "语音服务尚未就绪，请稍后重试") from None

            async def run():
                try:
                    runner = WorkerRunner(handle_sigint=False)
                    await runner.add_workers(worker)
                    await runner.run()
                except asyncio.CancelledError:
                    raise
                except Exception:
                    connection.send_app_message({"type": "voice", "state": "error", "message": "语音连接已结束，请重新打开"})
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
    uvicorn.run(create_app(), host=os.environ.get("VOICE_BIND_HOST", "127.0.0.1"),
                port=int(os.environ.get("VOICE_PORT", "48083")), access_log=False)


if __name__ == "__main__":
    main()
