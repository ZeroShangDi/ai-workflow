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

describe('client run host 调用面（T1-105）', () => {
  function makeHttp() {
    const calls = [];
    return {
      calls,
      http: {
        postJson: async (p, b) => { calls.push(['postJson', p, b]); return { ok: true }; },
        getJson: async (p) => { calls.push(['getJson', p]); return { ok: true, events: [] }; },
        respond: async (v) => { calls.push(['respond', v]); return { ok: true }; },
        status: async () => ({ state: 'ready' }),
      },
    };
  }

  it('submitRun 提交 /run/submit（runId 可选）', async () => {
    const { calls, http } = makeHttp();
    const client = createRunClient({ http });
    await client.submitRun({ runId: 'r1' });
    await client.submitRun();
    expect(calls).toEqual([
      ['postJson', '/run/submit', { runId: 'r1' }],
      ['postJson', '/run/submit', {}],
    ]);
  });

  it('runSnapshot / pollRunEvents 经 getJson 命中状态/事件端点（含 query）', async () => {
    const { calls, http } = makeHttp();
    const client = createRunClient({ http });
    await client.runSnapshot({ runId: 'r1' });
    await client.runSnapshot();
    await client.pollRunEvents({ runId: 'r1', afterSeq: 5, limit: 10 });
    await client.pollRunEvents({});
    expect(calls).toEqual([
      ['getJson', '/run/status?runId=r1'],
      ['getJson', '/run/status'],
      ['getJson', '/run/events?afterSeq=5&runId=r1&limit=10'],
      ['getJson', '/run/events?afterSeq=0'],
    ]);
  });

  it('端点表含 run submit/status/events', () => {
    expect(API_ENDPOINTS.runSubmit).toEqual({ path: '/run/submit', method: 'POST' });
    expect(API_ENDPOINTS.runStatus.method).toBe('GET');
    expect(API_ENDPOINTS.runEvents.path).toBe('/run/events');
  });
});

describe('client server run api 写端点（T1-061）', () => {
  function makeHttp() {
    const calls = [];
    return {
      calls,
      http: {
        postJson: async (p, b) => { calls.push(['postJson', p, b]); return { ok: true }; },
        getJson: async (p) => { calls.push(['getJson', p]); return { ok: true }; },
        status: async () => ({ state: 'ready' }),
      },
    };
  }

  it('setRunMode / markRunTaskActive / runGateComplete / backupRun 命中 /run/state/*', async () => {
    const { calls, http } = makeHttp();
    const client = createRunClient({ http });
    await client.setRunMode('run');
    await client.markRunTaskActive('T1');
    await client.runGateComplete('R1');
    await client.backupRun();
    expect(calls).toEqual([
      ['postJson', '/run/state/mode', { mode: 'run' }],
      ['postJson', '/run/state/task/active', { taskId: 'T1' }],
      ['postJson', '/run/state/gate', { taskId: 'R1' }],
      ['postJson', '/run/state/backup', {}],
    ]);
  });

  it('端点表含 run state 写端点', () => {
    expect(API_ENDPOINTS.stateMode.path).toBe('/run/state/mode');
    expect(API_ENDPOINTS.stateTaskActive.path).toBe('/run/state/task/active');
    expect(API_ENDPOINTS.stateGate.path).toBe('/run/state/gate');
    expect(API_ENDPOINTS.stateBackup.method).toBe('POST');
  });

  it('getState 经 getJson 读 /awf/state（运行态读经 server 快照）', async () => {
    const { calls, http } = makeHttp();
    const client = createRunClient({ http });
    await client.getState();
    expect(calls).toEqual([['getJson', '/awf/state']]);
  });

  it('T1-073：slotStatus(sid) 读 server /status?sid（run 槽内存态）', async () => {
    const { calls, http } = makeHttp();
    const client = createRunClient({ http });
    await client.slotStatus('r1');
    expect(calls).toEqual([['getJson', '/status?sid=r1']]);
  });
});
