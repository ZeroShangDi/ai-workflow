/**
 * 测试用 HTTP 客户端（T1-110）
 *
 * server 现在拒绝**不带 ?p 的写类请求**——此前 `resolveCtx` 会静默兜底到 boot 项目
 * （2026-09-10 真机事故：一条不带 ?p 的手工 curl 把在跑的 run 暂停了 4 小时）。
 * 测试要像真实调用方一样显式声明项目作用域：`withProject()` 给写请求自动补
 * `?p=<projectRoot>`，路径里已经带了 `p` 的放行；GET/HEAD 不补（读类端点保留 boot 兜底）。
 */

/** 给写类请求补 `?p=<projectRoot>`（已带 p 或非写请求 → 原样返回） */
export function withProject(path, method, projectRoot) {
  if (!projectRoot) return path;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return path;
  if (/[?&]p=/.test(path)) return path;
  return `${path}${path.includes('?') ? '&' : '?'}p=${encodeURIComponent(projectRoot)}`;
}

/**
 * @param {string} base 形如 `http://127.0.0.1:<port>`
 * @param {string} [projectRoot] 本用例的项目根（写请求自动补 ?p）
 */
export function makeApi(base, projectRoot) {
  return async function (method, path, body) {
    const headers = { connection: 'close' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + withProject(path, method, projectRoot), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text, contentType: res.headers.get('content-type') };
  };
}
