"""Provider-neutral external-memory contracts. Identity is supplied by the host."""
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class MemoryIdentity:
    tenant: str
    user: str

    def __post_init__(self):
        if not all(isinstance(v, str) and v.strip() for v in (self.tenant, self.user)):
            raise ValueError("Memory requires a host-bound tenant and user")


@dataclass(frozen=True)
class MemoryItem:
    id: str
    text: str
    source: str = ""


class MemoryAdapter(Protocol):
    """Implement for a chosen external service, including identity isolation.

    Credentials stay in the adapter's private configuration. Writes must forward
    request_id as an idempotency key; unknown outcomes must never be retried blindly.
    """
    async def search(self, identity: MemoryIdentity, query: str, limit: int) -> list[MemoryItem]: ...
    async def remember(self, identity: MemoryIdentity, text: str, source: str, request_id: str) -> str: ...
    async def forget(self, identity: MemoryIdentity, memory_id: str, request_id: str) -> None: ...
