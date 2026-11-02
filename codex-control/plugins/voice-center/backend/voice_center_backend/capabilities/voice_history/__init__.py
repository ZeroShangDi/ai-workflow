"""Always-on external transcript persistence and history query capability."""

import asyncio
import os
import uuid

import httpx


def _base():
    return os.environ.get("VOICE_CENTER_AI_SERVICE_URL", os.environ.get("AI_SERVICE_URL", "http://127.0.0.1:48081")).rstrip("/")


def _token():
    return os.environ.get("VOICE_CENTER_AI_INTERNAL_TOKEN", os.environ.get("AI_INTERNAL_TOKEN", ""))


class VoiceHistory:
    def __init__(self, identity, context=None, host=None):
        self.identity = identity
        self.context = context
        self.host = host
        self.enabled = True
        self.conversation_id = None
        self.lock = asyncio.Lock()
        self.pending = set()

    def _headers(self):
        token = _token()
        if len(token) < 32:
            return None
        return {
            "Authorization": "Bearer " + token,
            **{f"X-AI-{key.title()}": str(self.identity.get(key, "")) for key in ("tenant", "user", "device")},
        }

    async def _request(self, method, path, body=None):
        headers = self._headers()
        if headers is None:
            return None
        async with httpx.AsyncClient(timeout=15, trust_env=False, follow_redirects=False) as client:
            response = await client.request(method, _base() + path, headers=headers, json=body)
            response.raise_for_status()
            value = response.json()
            return value.get("data", value)

    async def _ensure_conversation(self):
        async with self.lock:
            if self.conversation_id:
                return self.conversation_id
            value = await self._request("POST", "/internal/v1/ai/conversations", {"source_type": "voice"})
            if not value:
                return None
            candidate = value.get("id") if isinstance(value, dict) else value
            if candidate is None:
                return None
            self.conversation_id = str(candidate)
            return self.conversation_id

    async def _append(self, role, text):
        if not text or self._headers() is None or role not in {"user", "assistant"}:
            return
        conversation_id = await self._ensure_conversation()
        if not conversation_id:
            return
        await self._request(
            "POST",
            f"/internal/v1/ai/conversations/{conversation_id}/transcripts",
            {"request_id": str(uuid.uuid4()), "role": role, "content": text[:6000]},
        )

    def record_transcript(self, role, text, identity):
        self.identity = identity or self.identity
        task = asyncio.create_task(self._append(role, text))
        self.pending.add(task)
        task.add_done_callback(self.pending.discard)

    async def execute(self, name, args):
        if name not in {"list_conversations", "read_conversation"}:
            return {"error": "unsupported history tool"}
        if self._headers() is None:
            return {"items": [], "next_cursor": None, "notice": "external voice history is not configured"}
        if name == "list_conversations":
            limit = max(1, min(30, int(args.get("limit", 20))))
            query = f"?limit={limit}"
            cursor = args.get("cursor")
            if cursor:
                query += "&cursor=" + str(httpx.QueryParams({"cursor": cursor}))
            value = await self._request("GET", "/internal/v1/ai/conversations" + query)
            return value or {"items": [], "next_cursor": None}
        conversation_id = str(args.get("conversation_id", ""))
        if not conversation_id.isdigit():
            raise ValueError("invalid conversation_id")
        limit = max(1, min(30, int(args.get("limit", 20))))
        query = f"limit={limit}"
        if args.get("cursor"):
            query += "&cursor=" + str(httpx.QueryParams({"cursor": args["cursor"]}))
        value = await self._request("GET", f"/internal/v1/ai/conversations/{conversation_id}/messages?{query}")
        return value or {"items": [], "next_cursor": None}

    def close(self):
        for task in list(self.pending):
            task.cancel()
        self.pending.clear()


def activate(**kwargs):
    return VoiceHistory(**kwargs)
