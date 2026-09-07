import { describe, it, expect, vi } from 'vitest';
import { createRunClient, API_ENDPOINTS } from '../../src/cli/run-client.js';

// cli 调用形态（W1-038）：提交 + 订阅(轮询桩) + 应答 —— 传输可注入，薄化本体在 W3-005。

describe('createRunClient', () => {
  it('submit/respond 经注入 http 调用对应路径', async () => {
    const calls = [];
    const client = createRunClient({
      http: {
        postJson: async (path, body) => { calls.push(['postJson', path, body]); return { ok: true }; },
        respond: async (value) => { calls.push(['respond', value]); return { ok: true }; },
        status: async () => ({ state: 'ready' }),
      },
      sleep: async () => {},
    });
    await client.submit('你好');
    await client.respond('A');
    expect(calls).toEqual([
      ['postJson', '/send', { text: '你好' }],
      ['respond', 'A'],
    ]);
  });

  it('waitReady：状态 ready 即返回 true；busy 轮询后超时 false', async () => {
    const seq = [{ state: 'busy' }, { state: 'busy' }, { state: 'ready' }];
    const client = createRunClient({ http: { status: async () => seq.shift() }, sleep: async () => {} });
    expect(await client.waitReady({ timeoutMs: 100 })).toBe(true);

    const busy = createRunClient({ http: { status: async () => ({ state: 'busy' }) }, sleep: async () => {} });
    expect(await busy.waitReady({ timeoutMs: 5, intervalMs: 2 })).toBe(false);
  });
});

describe('client 端点集中 + 订阅接缝（T1-056）', () => {
  it('API_ENDPOINTS 覆盖 send/respond/status/awf-state 等', () => {
    expect(API_ENDPOINTS.send.path).toBe('/send');
    expect(API_ENDPOINTS.awfState.path).toBe('/awf/state');
    expect(API_ENDPOINTS.status.method).toBe('GET');
  });

  it('subscribe：onEvent 收到 status 事件；unsubscribe 停止', async () => {
    const events = [];
    let n = 0;
    const client = createRunClient({
      http: { status: async () => ({ state: n++ % 2 ? 'ready' : 'busy' }) },
      sleep: async () => {},
    });
    const unsub = client.subscribe({ intervalMs: 1, onEvent: (e) => { if (events.length < 2) events.push(e); else unsub(); } });
    await new Promise((r) => setTimeout(r, 10));
    unsub();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].type).toBe('status');
  });
});
