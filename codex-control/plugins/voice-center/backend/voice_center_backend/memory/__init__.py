"""Optional external memory adapter module; importing it performs no I/O."""
from .contracts import MemoryAdapter, MemoryIdentity, MemoryItem
from .service import MemoryConfig, MemoryService
from .tools import MemoryTools

__all__ = ["MemoryAdapter", "MemoryIdentity", "MemoryItem", "MemoryConfig", "MemoryService", "MemoryTools"]
