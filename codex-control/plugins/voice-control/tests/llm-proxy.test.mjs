import assert from 'node:assert/strict';
import test from 'node:test';

import { OpenAICompatibleProxy } from '../src/llm-proxy.mjs';

test('injects independent search results before forwarding the chat request', async () => {
  let forwarded;
  const proxy = new OpenAICompatibleProxy({
    upstreamUrl: 'http://llm.test/v1/chat/completions',
    apiKey: 'test-key',
    searchProvider: {
      configured: true,
      async search(query) {
        assert.equal(query, '搜索今天的上海天气');
        return {
          answer: '上海今天晴。',
          sources: [{ title: '上海天气', url: 'https://example.test/weather' }],
        };
      },
    },
    fetchImpl: async (url, options) => {
      forwarded = { url: String(url), body: JSON.parse(options.body) };
      return new Response('data: {"type":"done"}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  });
  const result = await proxy.complete({
    stream: true,
    messages: [
      { role: 'system', content: '你是语音助手。' },
      { role: 'user', content: '搜索今天的上海天气' },
    ],
  });
  assert.equal(result.status, 200);
  assert.equal(forwarded.url, 'http://llm.test/v1/chat/completions');
  assert.equal(forwarded.body.messages.some((message) => message.role === 'system' && message.content.includes('上海今天晴')), true);
  assert.equal(forwarded.body.messages.some((message) => message.content?.includes('https://example.test/weather')), true);
});
