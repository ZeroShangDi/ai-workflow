import { describe, it, expect } from 'vitest';

import client from '../../cli/lib/client.cjs';

const { createClient, ENDPOINTS } = client;

/**
 * cli/lib/client.cjs — Session Server 的 HTTP 客户端（薄封装）
 *
 * 随旧树退役重写。旧版测的是另一个面（submit/subscribe/waitReady/getState/slotStatus/
 * markRunTaskActive/runGateComplete…）—— 那些能力已随「CLI 不再直写 state、编排归宿主」一并消失
 * 或改名。新版按新契约重写，并用 client 自带的 `fetchImpl` 注入做忠实断言（无需 mock 机制）。
 */

/** 造一个假 fetch：记录 URL/方法/body，按脚本应答 */
function fakeFetch(script = {}) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined });
    const body = typeof script.body === 'function' ? script.body(calls.length - 1, String(url)) : script.body;
    return {
      ok: script.ok !== false,
      status: script.status ?? 200,
      text: async () => JSON.stringify(body ?? { ok: true }),
    };
  };
  return { fn, calls };
}

describe('ENDPOINTS — 端点表形状与覆盖', () => {
  it('每条都是 [method, path] 二元组（新增端点两边一起加）', () => {
    for (const [name, v] of Object.entries(ENDPOINTS)) {
      expect(Array.isArray(v), `${name} 应为 [method, path]`).toBe(true);
      expect(v).toHaveLength(2);
      expect(['GET', 'POST']).toContain(v[0]);
      expect(v[1].startsWith('/')).toBe(true);
    }
  });

  it('覆盖会话/宿主/state 写原语三类端点', () => {
    expect(ENDPOINTS.status).toEqual(['GET', '/status']);
    expect(ENDPOINTS.probe).toEqual(['GET', '/probe']);
    expect(ENDPOINTS.send).toEqual(['POST', '/send']);
    expect(ENDPOINTS.respond).toEqual(['POST', '/respond']);
    expect(ENDPOINTS.runSubmit).toEqual(['POST', '/run/submit']);
    expect(ENDPOINTS.runStatus).toEqual(['GET', '/run/status']);
    expect(ENDPOINTS.runEvents).toEqual(['GET', '/run/events']);
    expect(ENDPOINTS.runMode).toEqual(['POST', '/run/state/mode']);
  });
});

describe('createClient — 项目路由（单 server 多项目）', () => {
  it('带 project → 每个请求都附 ?p=（缺了会落到 server 的 boot 项目）', async () => {
    const { fn, calls } = fakeFetch();
    const c = createClient({ port: 8787, project: '/proj/a', fetchImpl: fn });
    await c.getStatus();
    expect(calls[0].url).toBe('http://127.0.0.1:8787/status?p=%2Fproj%2Fa');
  });

  it('已有 query 时用 & 拼接（不出现两个 ?）', async () => {
    const { fn, calls } = fakeFetch();
    const c = createClient({ port: 8787, project: '/p', fetchImpl: fn });
    await c.pollRunEvents({ afterSeq: 5, runId: 'r1' });
    const u = calls[0].url;
    expect(u).toContain('/run/events?afterSeq=5&runId=r1');
    expect(u.match(/\?/g)).toHaveLength(1);
    expect(u).toContain('&p=%2Fp');
  });

  it('无 project → 不加 ?p（只用于探活类调用）', async () => {
    const { fn, calls } = fakeFetch();
    await createClient({ port: 8787, fetchImpl: fn }).alive();
    expect(calls[0].url).toBe('http://127.0.0.1:8787/status');
  });
});

describe('request — 错误归一（不把失败当成成功）', () => {
  it('非 2xx → { ok:false, status, error }（并带上服务端给的字段）', async () => {
    const { fn } = fakeFetch({ ok: false, status: 503, body: { ok: false, error: '宿主未就绪' } });
    const r = await createClient({ port: 1, fetchImpl: fn }).getStatus();
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
    expect(r.error).toBe('宿主未就绪');
  });

  it('连不上 → { ok:false, error }（调用方据此判「server 未起」）', async () => {
    const fn = async () => { throw new Error('ECONNREFUSED'); };
    const r = await createClient({ port: 1, fetchImpl: fn }).getStatus();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('ECONNREFUSED');
  });

  it('超时 → 归一为「请求超时」（AbortError 不裸抛给调用方）', async () => {
    const fn = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    const r = await createClient({ port: 1, fetchImpl: fn }).getStatus();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('请求超时');
  });

  it('alive()：只有 ok:true 才算活着', async () => {
    const { fn } = fakeFetch({ ok: false, status: 500, body: { ok: false } });
    expect(await createClient({ port: 1, fetchImpl: fn }).alive()).toBe(false);
  });
});

describe('便捷方法与端点的对应', () => {
  it('sendText / respond 分别打 /send、/respond，respond 带 answeredBy（决策三路由的落记录依据）', async () => {
    const { fn, calls } = fakeFetch();
    const c = createClient({ port: 8787, project: '/p', fetchImpl: fn });
    await c.sendText('做事');
    await c.respond('A', 'auto');
    expect(calls[0]).toMatchObject({ method: 'POST', body: { text: '做事' } });
    expect(calls[0].url).toContain('/send');
    expect(calls[1]).toMatchObject({ method: 'POST', body: { value: 'A', answeredBy: 'auto' } });
    expect(calls[1].url).toContain('/respond');
  });

  it('submitRun / runSnapshot / setMode 命中宿主端点', async () => {
    const { fn, calls } = fakeFetch();
    const c = createClient({ port: 8787, project: '/p', fetchImpl: fn });
    await c.submitRun({ runId: 'r1' });
    await c.runSnapshot({ runId: 'r1' });
    await c.setMode('run');
    expect(calls[0].url).toContain('/run/submit');
    expect(calls[0].body).toEqual({ runId: 'r1' });
    expect(calls[1].url).toContain('/run/status');
    expect(calls[2].url).toContain('/run/state/mode');
    expect(calls[2].body).toEqual({ mode: 'run' });
  });
});
