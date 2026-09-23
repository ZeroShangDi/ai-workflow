import { getTransport } from './transport.js';
// web/src/api/client.js — 前端 api client：HTTP + WebSocket 封装，请求/连接带作用域（多项目 + 多 run 寻址）。
// 纯 ESM、零依赖（fetch/WebSocket 可注入，便于测试与降级）。行为语义：按当前项目作用域（p）操作，
// 可选聚焦到某个 run（sid）。

/**
 * @param {{ base?: string, project?: string|null, sid?: string|null, httpFetch?: Function, wsFactory?: Function }} opts
 *   base        server 基址（浏览器默认同源，非浏览器默认 http://127.0.0.1:8787）
 *   project     项目根（单 server 多项目路由键）；提供时所有请求/连接附 ?p=（缺省 = server boot 项目）
 *   sid         当前 run 标识；提供时所有请求/连接附 ?sid=
 *   httpFetch   fetch 注入（测试）
 *   wsFactory   (url) => WebSocket 注入（测试/降级）
 */
export function createApiClient({
  base = globalThis.location?.origin || 'http://127.0.0.1:8787',
  project = null,
  sid = null,
  httpFetch = (...a) => getTransport().fetch(...a),
  wsFactory = url => getTransport().socket(url),
} = {}) {
  function urlOf(path) {
    const url = new URL(path, base);
    // A caller cannot accidentally escape the client's project/session scope.
    if (project) url.searchParams.set('p', project);
    if (sid) url.searchParams.set('sid', sid);
    return url.toString().replace(/\+/g, '%20');
  }
  async function request(path, { method = 'GET', body, signal, timeoutMs = 15000 } = {}) {
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason);
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('请求超时，请重试')), timeoutMs);
    try {
      const res = await httpFetch(urlOf(path), {
        method,
        signal: controller.signal,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let data;
      try {
        data = await res.json();
      } catch {
        return { ok: false, error: `http ${res.status}` };
      }
      if (!data || typeof data !== 'object') return { ok: false, error: '接口返回了无效数据' };
      return res.ok === false
        ? { ...data, ok: false, error: data.error || `http ${res.status}` }
        : data;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }

  return {
    base,
    project: project ?? null,
    sid: sid ?? null,
    get(path, options) {
      return request(path, options);
    },
    post(path, body, options) {
      return request(path, {
        ...options,
        method: 'POST',
        body,
      });
    },
    /**
     * WebSocket 连接（ws/wss 由 http(s) 基址换算）；返回 ws 实例（调用方挂 onopen/onmessage）。
     * @returns {object} WebSocket 实例
     */
    stream(path) {
      const wsUrl = urlOf(path).replace(/^http/, 'ws');
      return wsFactory(wsUrl);
    },
    /** 当前作用域（观察用） */
    url(path) {
      return urlOf(path);
    },
  };
}
