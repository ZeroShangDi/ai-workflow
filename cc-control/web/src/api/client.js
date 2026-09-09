// web/src/api/client.js — 前端 api client：HTTP + WebSocket 封装，请求/连接带 sid（多 run 寻址）。
// 纯 ESM、零依赖（fetch/WebSocket 可注入，便于测试与降级）。行为语义：按当前 run（sid）操作。

/**
 * @param {{ base?: string, sid?: string|null, httpFetch?: Function, wsFactory?: Function }} opts
 *   base        server 基址（默认 http://127.0.0.1:8787）
 *   sid         当前 run 标识；提供时所有请求/连接附 ?sid= （软边界，只碰本 run）
 *   httpFetch   fetch 注入（测试）
 *   wsFactory   (url) => WebSocket 注入（测试/降级）
 */
export function createApiClient({
  base = 'http://127.0.0.1:8787',
  sid = null,
  httpFetch = (...a) => globalThis.fetch(...a),
  wsFactory = (url) => new WebSocket(url),
} = {}) {
  const sidQ = sid ? `sid=${encodeURIComponent(String(sid))}` : '';

  /** 路径附 sid（保留原 query） */
  function withSid(path) {
    const [p, q = ''] = String(path).split('?');
    const parts = [q, sidQ].filter(Boolean);
    return parts.length ? `${p}?${parts.join('&')}` : p;
  }
  function urlOf(path) {
    return new URL(withSid(path), base).toString();
  }

  async function request(path, { method = 'GET', body } = {}) {
    const res = await httpFetch(urlOf(path), {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    try { return await res.json(); } catch { return { ok: false, error: `http ${res.status}` }; }
  }

  return {
    base,
    sid: sid ?? null,
    get(path) { return request(path); },
    post(path, body) { return request(path, { method: 'POST', body }); },
    /**
     * WebSocket 连接（ws/wss 由 http(s) 基址换算）；返回 ws 实例（调用方挂 onopen/onmessage）。
     * @returns {object} WebSocket 实例
     */
    stream(path) {
      const wsUrl = urlOf(path).replace(/^http/, 'ws');
      return wsFactory(wsUrl);
    },
    /** 当前 sid（观察用） */
    url(path) { return urlOf(path); },
  };
}
