'use strict';
/**
 * cli/lib/client.cjs — Session Server 的 HTTP 客户端（薄封装）
 *
 * 只做三件事：拼 URL（带上 `?p=<projectRoot>` 让单 server 多项目路由到本项目）、发 JSON、
 * 把非 2xx 归一成 `{ ok:false, error }`。**不含任何编排判断** —— 是否该提交、何时该停，
 * 都由调用方（commands/）与宿主决定。
 *
 * 端点表与 server 的 web/api/* 一一对应；新增端点时两边一起加。
 */

const ENDPOINTS = {
  status: ['GET', '/status'],
  probe: ['GET', '/probe'],
  shutdown: ['POST', '/shutdown'],
  // 会话注入（宿主/tmux 会话）
  send: ['POST', '/send'],
  respond: ['POST', '/respond'],
  // run 宿主
  runSubmit: ['POST', '/run/submit'],
  runStatus: ['GET', '/run/status'],
  runEvents: ['GET', '/run/events'],
  // state 写原语（CLI 不再直写 state）
  runMode: ['POST', '/run/state/mode'],
  runBackup: ['POST', '/run/state/backup'],
};

/**
 * @param {{ port: number, project: string, fetchImpl?: Function }} opts
 *   project  本次 run 的项目根 —— 所有请求带 `?p=`，避免落到 server 的 boot 项目
 */
function createClient({ port, project, fetchImpl = fetch }) {
  const base = `http://127.0.0.1:${port}`;

  /** 给路径补上 ?p= 路由参数（已有 query 时用 & 拼接） */
  function withProject(pathname) {
    if (!project) return pathname;
    return `${pathname}${pathname.includes('?') ? '&' : '?'}p=${encodeURIComponent(project)}`;
  }

  async function request(method, pathname, body, { timeoutMs = 10_000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}${withProject(pathname)}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      if (!res.ok) return { ok: false, status: res.status, error: data?.error || `HTTP ${res.status}`, ...data };
      return data ?? { ok: true };
    } catch (err) {
      // 连不上 / 超时都归为「拿不到」，由调用方决定是重试还是判服务器未起
      return { ok: false, error: err.name === 'AbortError' ? `请求超时（${timeoutMs}ms）` : err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 按端点表发请求；params 为 query 对象（可选） */
  function call(name, { body, query, timeoutMs } = {}) {
    const [method, pathname] = ENDPOINTS[name];
    const qs = query ? new URLSearchParams(query).toString() : '';
    return request(method, qs ? `${pathname}?${qs}` : pathname, body, { timeoutMs });
  }

  return {
    port,
    project,
    request,
    call,
    /** 服务器是否在跑（探针：拿不到或未返回 state → false） */
    async alive(timeoutMs = 1500) {
      const r = await request('GET', '/status', undefined, { timeoutMs });
      return r?.ok === true;
    },
    getStatus: (query) => call('status', { query }),
    submitRun: (body) => call('runSubmit', { body }),
    runSnapshot: (query) => call('runStatus', { query }),
    pollRunEvents: (query) => call('runEvents', { query }),
    setMode: (mode) => call('runMode', { body: { mode } }),
    sendText: (text) => call('send', { body: { text } }),
    /** 回应决策；answeredBy 标明走了哪条路由（human / auto / ai），服务端据此落记录 */
    respond: (value, answeredBy) => call('respond', { body: { value, answeredBy } }),
  };
}

module.exports = { createClient, ENDPOINTS };
