// web/src/api/client.js — 前端 api client：HTTP + WebSocket 封装，请求/连接带作用域（多项目 + 多 run 寻址）。
// 纯 ESM、零依赖（fetch/WebSocket 可注入，便于测试与降级）。行为语义：按当前项目作用域（p）操作，
// 可选聚焦到某个 run（sid）。

/**
 * @param {{ base?: string, project?: string|null, sid?: string|null, httpFetch?: Function, wsFactory?: Function }} opts
 *   base        server 基址（默认 http://127.0.0.1:8787）
 *   project     项目根（单 server 多项目路由键）；提供时所有请求/连接附 ?p=（缺省 = server boot 项目）
 *   sid         当前 run 标识；提供时所有请求/连接附 ?sid=
 *   httpFetch   fetch 注入（测试）
 *   wsFactory   (url) => WebSocket 注入（测试/降级）
 */
export function createApiClient({
  base = 'http://127.0.0.1:8787',
  project = null,
  sid = null,
  httpFetch = (...a) => globalThis.fetch(...a),
  wsFactory = (url) => new WebSocket(url),
} = {}) {
  const scopeParts = [];
  if (project) scopeParts.push(`p=${encodeURIComponent(String(project))}`);
  if (sid) scopeParts.push(`sid=${encodeURIComponent(String(sid))}`);
  const scopeQ = scopeParts.join('&');

  /** 路径附作用域（保留原 query） */
  function withScope(path) {
    const [p, q = ''] = String(path).split('?');
    const parts = [q, scopeQ].filter(Boolean);
    return parts.length ? `${p}?${parts.join('&')}` : p;
  }
  function urlOf(path) {
    return new URL(withScope(path), base).toString();
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
    project: project ?? null,
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
    /** 当前作用域（观察用） */
    url(path) { return urlOf(path); },
  };
}
