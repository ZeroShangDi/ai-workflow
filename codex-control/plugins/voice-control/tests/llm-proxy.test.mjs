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

test('uses the managed fixed Codex conversation for streaming chat when available', async () => {
  const calls = [];
  const proxy = new OpenAICompatibleProxy({
    managedChatProvider: {
      available: true,
      async reply(body) {
        calls.push(body);
        return { text: '这是固定 Codex 会话的回复。', messageId: 'assistant-1' };
      },
    },
  });
  const result = await proxy.complete({
    stream: true,
    model: 'gpt-test',
    messages: [{ role: 'user', content: '你好' }],
  });
  assert.equal(result.status, 200);
  assert.equal(result.contentType.startsWith('text/event-stream'), true);
  assert.match(result.body, /这是固定 Codex 会话的回复/);
  assert.match(result.body, /data: \[DONE\]/);
  assert.equal(calls[0].messages.at(-1).content, '你好');
});
