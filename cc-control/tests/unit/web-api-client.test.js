import { describe, it, expect } from 'vitest';
import { createApiClient } from '../../web/src/api/client.js';

// T1-085：web api client（http + ws 封装，带 sid）。

function mockFetch() {
  const calls = [];
  return {
    calls,
    fetch: async (url, opts) => {
      calls.push({ url: String(url), opts });
      return { json: async () => ({ ok: true }) };
    },
  };
}

describe('createApiClient（http + ws，带 sid）', () => {
  it('无 sid：get/post 落到 base + path', async () => {
    const { calls, fetch } = mockFetch();
    const api = createApiClient({ base: 'http://127.0.0.1:8787', httpFetch: fetch });
    await api.get('/run/status');
    await api.post('/run/state/mode', { mode: 'run' });
    expect(calls[0].url).toBe('http://127.0.0.1:8787/run/status');
    expect(calls[1].url).toBe('http://127.0.0.1:8787/run/state/mode');
    expect(calls[1].opts.method).toBe('POST');
    expect(calls[1].opts.body).toBe('{"mode":"run"}');
  });

  it('带 sid：请求附 ?sid=；保留原 query 合并', async () => {
    const { calls, fetch } = mockFetch();
    const api = createApiClient({ base: 'http://127.0.0.1:8787', sid: 'r1', httpFetch: fetch });
    await api.get('/run/status?detail=1');
    expect(calls[0].url).toBe('http://127.0.0.1:8787/run/status?detail=1&sid=r1');
  });

  it('stream：http→ws 换算 + 带 sid，经注入 wsFactory', async () => {
    const seen = [];
    const api = createApiClient({
      base: 'http://127.0.0.1:8787',
      sid: 'r2',
      wsFactory: (url) => { seen.push(url); return { __ws: true }; },
    });
    const ws = api.stream('/run/events');
    expect(ws.__ws).toBe(true);
    expect(seen[0]).toBe('ws://127.0.0.1:8787/run/events?sid=r2');
  });
});

// T1-097：前端 api/ws 层单测补充——错误容忍 / 网络拒绝 / 协议换算 / sid 编码边界。

function jsonResp(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj };
}
function textErr(status) {
  return { ok: false, status, json: async () => { throw new Error('not json'); } };
}

describe('createApiClient — 边界/容忍（T1-097）', () => {
  it('服务端非 JSON / 错误码 → 兜底 { ok:false, error:http <status> }', async () => {
    const api = createApiClient({ httpFetch: async () => textErr(500) });
    expect(await api.get('/run/status')).toEqual({ ok: false, error: 'http 500' });
  });

  it('成功响应原样返回 JSON body', async () => {
    const api = createApiClient({ httpFetch: async () => jsonResp({ ok: true, total: 5 }) });
    expect(await api.get('/awf/decisions')).toEqual({ ok: true, total: 5 });
  });

  it('网络拒绝 → 原样 reject（视图以 .catch(()=>null) 兜底）', async () => {
    const api = createApiClient({ httpFetch: async () => { throw new Error('ECONNREFUSED'); } });
    await expect(api.get('/x')).rejects.toThrow('ECONNREFUSED');
  });

  it('stream：https base → wss 换算且保留 sid', async () => {
    const seen = [];
    const api = createApiClient({
      base: 'https://127.0.0.1:9443', sid: 'r1',
      wsFactory: (url) => { seen.push(url); return { __ws: true }; },
    });
    api.stream('/run/events');
    expect(seen[0]).toBe('wss://127.0.0.1:9443/run/events?sid=r1');
  });

  it('空/缺 sid → 不附 ?sid；特殊字符 sid encode', async () => {
    const { calls, fetch } = mockFetch();
    const noSid = createApiClient({ httpFetch: fetch });
    await noSid.get('/status');
    expect(calls[0].url).toBe('http://127.0.0.1:8787/status');

    const enc = createApiClient({ sid: 'a b/c', httpFetch: fetch });
    await enc.get('/status');
    expect(calls[1].url).toBe('http://127.0.0.1:8787/status?sid=a%20b%2Fc');
  });

  it('url() 返回绝对地址（含 sid）', () => {
    const api = createApiClient({ base: 'http://127.0.0.1:9000', sid: 'r2' });
    expect(api.url('/awf/state')).toBe('http://127.0.0.1:9000/awf/state?sid=r2');
  });
});
