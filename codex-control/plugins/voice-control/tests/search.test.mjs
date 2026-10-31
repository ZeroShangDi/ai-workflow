import assert from 'node:assert/strict';
import test from 'node:test';

import { needsWebSearch, WebSearchProvider } from '../src/search.mjs';

test('detects explicit realtime search intent', () => {
  assert.equal(needsWebSearch('帮我搜索今天的上海天气'), true);
  assert.equal(needsWebSearch('你好，继续聊刚才的话题'), false);
});

test('parses a search answer and sources from the streaming provider', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"sources","items":[{"title":"上海天气","url":"https://example.test/weather"}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"type":"chunk","text":"上海今天晴。"}\n\n'));
      controller.enqueue(encoder.encode('data: {"type":"done"}\n\n'));
      controller.close();
    },
  });
  const provider = new WebSearchProvider({
    endpoint: 'http://search.test/chat',
    token: 'x'.repeat(64),
    fetchImpl: async () => new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  });
  const result = await provider.search('上海天气');
  assert.equal(result.answer, '上海今天晴。');
  assert.equal(result.sources[0].title, '上海天气');
});
