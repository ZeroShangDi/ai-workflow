"""Optional memory boundary: disabled by default; bounded failures never escape into chat."""
import asyncio
from dataclasses import dataclass
import os
import uuid

from .contracts import MemoryIdentity, MemoryItem


@dataclass(frozen=True)
class MemoryConfig:
    enabled: bool = False
    timeout_seconds: float = 2.0

    def __post_init__(self):
        if not isinstance(self.enabled, bool) or not 0 < self.timeout_seconds <= 10:
            raise ValueError("Invalid memory configuration")

    @classmethod
    def load(cls, env=None):
        env = os.environ if env is None else env
        flag = env.get("VOICE_CENTER_MEMORY_ENABLED", "false").lower()
        if flag not in {"true", "false", "1", "0"}:
            raise ValueError("VOICE_CENTER_MEMORY_ENABLED must be true or false")
        return cls(flag in {"true", "1"}, float(env.get("VOICE_CENTER_MEMORY_TIMEOUT_SECONDS", "2")))


def text(value, field, maximum):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"Invalid memory {field}")
    return value.strip()


class MemoryService:
    def __init__(self, identity: MemoryIdentity, adapter=None, config=None):
        if not isinstance(identity, MemoryIdentity):
            raise ValueError("Host-bound MemoryIdentity is required")
        self.identity, self.adapter = identity, adapter
        self.config = config or MemoryConfig.load()

    @property
    def available(self):
        return self.config.enabled and self.adapter is not None

    def _inactive(self):
        return {"status": "disabled" if not self.config.enabled else "unconfigured", "items": []}

    async def search(self, query, limit=5):
        if not self.available:
            return self._inactive()
        query = text(query, "query", 2000)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 10:
            raise ValueError("Memory limit must be 1-10")
        try:
            rows = await asyncio.wait_for(self.adapter.search(self.identity, query, limit), self.config.timeout_seconds)
            if not isinstance(rows, list):
                raise ValueError("Invalid adapter result")
            items = []
            for row in rows[:limit]:
                if not isinstance(row, MemoryItem):
                    raise ValueError("Invalid memory item")
                items.append({"id": text(row.id, "id", 256), "text": text(row.text, "text", 2000),
                              "source": str(row.source)[:500]})
            return {"status": "ok", "items": items}
        except Exception:
            # Do not include provider exceptions: they can contain keys or private URLs.
            return {"status": "unavailable", "items": []}

    async def remember(self, content, source):
        if not self.available:
            return self._inactive()
        content, source = text(content, "text", 6000), text(source, "source", 500)
        request_id = str(uuid.uuid4())
        try:
            identifier = await asyncio.wait_for(
                self.adapter.remember(self.identity, content, source, request_id), self.config.timeout_seconds)
            return {"status": "stored", "id": text(identifier, "id", 256), "requestId": request_id}
        except Exception:
            return {"status": "unknown", "requestId": request_id, "retryable": False,
                    "message": "保存结果未确认，请先查询；不要自动重试。"}

    async def forget(self, memory_id):
        if not self.available:
            return self._inactive()
        identifier = text(memory_id, "id", 256)
        request_id = str(uuid.uuid4())
        try:
            await asyncio.wait_for(self.adapter.forget(self.identity, identifier, request_id), self.config.timeout_seconds)
            return {"status": "deleted", "id": identifier, "requestId": request_id}
        except Exception:
            return {"status": "unknown", "requestId": request_id, "retryable": False,
                    "message": "删除结果未确认，请先查询；不要自动重试。"}
