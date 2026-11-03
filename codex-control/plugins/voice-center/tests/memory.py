"""No external memory service, provider credentials or audio dependencies required."""
import asyncio
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from voice_center_backend.memory import MemoryConfig, MemoryIdentity, MemoryItem, MemoryService, MemoryTools


class Adapter:
    def __init__(self): self.calls = []
    async def search(self, identity, query, limit):
        self.calls.append(('search', identity))
        return [MemoryItem('m1', '偏好简短回答', 'turn-1')]
    async def remember(self, identity, content, source, request_id):
        self.calls.append(('remember', identity, source, request_id))
        return 'm2'
    async def forget(self, identity, identifier, request_id):
        self.calls.append(('forget', identity, request_id))


class Tests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.identity = MemoryIdentity('tenant-1', 'user-1')
        self.adapter = Adapter()

    async def test_disabled_never_calls_adapter_or_exposes_tools(self):
        service = MemoryService(self.identity, self.adapter, MemoryConfig())
        tools = MemoryTools(service, 'turn-1')
        self.assertEqual(tools.definitions(), [])
        for result in [await service.search('问题'), await service.remember('事实', 'turn-1'), await service.forget('m1')]:
            self.assertEqual(result['status'], 'disabled')
        self.assertEqual(self.adapter.calls, [])

    async def test_enabled_without_adapter_is_noop(self):
        service = MemoryService(self.identity, config=MemoryConfig(True))
        self.assertFalse(service.available)
        self.assertEqual((await service.search('问题'))['status'], 'unconfigured')
        self.assertEqual(MemoryTools(service, 'turn-1').definitions(), [])

    async def test_adapter_receives_only_host_identity_and_source(self):
        service = MemoryService(self.identity, self.adapter, MemoryConfig(True))
        tools = MemoryTools(service, 'host-turn')
        result = await tools.execute('bridge_chat_memory_search', {'query': '偏好'})
        self.assertEqual(result['items'][0]['id'], 'm1')
        self.assertEqual((await tools.execute('bridge_chat_memory_remember', {'text': '喜欢中文'}))['status'], 'stored')
        self.assertEqual(self.adapter.calls[1][1:3], (self.identity, 'host-turn'))
        for arguments in [{'query': 'x', 'user': 'another'}, {'text': 'x', 'source': 'forged'}]:
            with self.assertRaises(ValueError): await tools.execute('bridge_chat_memory_search', arguments)
        self.assertEqual((await tools.execute('bridge_chat_memory_forget', {'memoryId': 'm1'}))['status'], 'deleted')

    async def test_search_timeout_degrades_to_empty_background(self):
        async def slow(*args):
            await asyncio.sleep(1)
        self.adapter.search = slow
        service = MemoryService(self.identity, self.adapter, MemoryConfig(True, .01))
        self.assertEqual(await service.search('问题'), {'status': 'unavailable', 'items': []})

    async def test_unknown_write_not_retried_or_reported_as_success(self):
        calls = []
        async def fail(*args):
            calls.append(args)
            raise RuntimeError('private-key-and-url')
        self.adapter.remember = fail
        service = MemoryService(self.identity, self.adapter, MemoryConfig(True))
        result = await service.remember('事实', 'turn-1')
        self.assertEqual(result['status'], 'unknown')
        self.assertFalse(result['retryable'])
        self.assertEqual(len(calls), 1)
        self.assertNotIn('private-key', str(result))

    async def test_invalid_results_cannot_be_injected_as_memory(self):
        async def invalid(*args): return [{'text': 'unchecked data'}]
        self.adapter.search = invalid
        service = MemoryService(self.identity, self.adapter, MemoryConfig(True))
        self.assertEqual((await service.search('问题'))['items'], [])

    def test_configuration_and_identity_validation(self):
        self.assertFalse(MemoryConfig.load({}).enabled)
        self.assertTrue(MemoryConfig.load({'VOICE_CENTER_MEMORY_ENABLED': 'true'}).enabled)
        with self.assertRaises(ValueError): MemoryIdentity('', 'user')
        with self.assertRaises(ValueError): MemoryConfig(True, 100)


if __name__ == '__main__': unittest.main()
