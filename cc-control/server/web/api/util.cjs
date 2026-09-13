'use strict';
/**
 * api/util.cjs — api 层共享工具（入口与各域共用）
 *
 * 这里只放「与具体路由无关」的出水口/入水口：请求体解析、统一 JSON 响应、两个入口规则的判据
 * （写类缺 ?p、tmux 缺席）与 pause 闩锁校验。各域模块 `require('./util.cjs')` 取用，
 * 避免同一份判据在多个域里各写一遍。
 */

/**
 * 读并解析请求体 JSON。
 * 解析失败（非法 JSON）→ resolve(null)，由调用方判空；空体 → {}。
 */
function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    // 必须显式 utf8：不设编码时 data 是 Buffer，逐块 `raw += Buffer` 会对**每个 chunk 单独** toString
    // —— 多字节字符跨 chunk 边界即被切成 U+FFFD（state 请求体几百 KB 中文必中）。
    req.setEncoding('utf8');
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    });
  });
}

/** 统一 JSON 响应出口（写状态码 + content-type + JSON body） */
function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

/**
 * 自动介入只允许在 CLI pause 闩锁已生效后执行。
 * 返回 true = 放行；false = 已回 409，调用方必须 return（不继续）。
 * 语义：介入（intervene/interrupt）是对运行时的人工干预，必须先暂停编排，否则会与在跑的任务打架。
 */
function requirePaused(rt, res) {
  const s = rt.ctx.stores.state.readSync();
  if (s?.mode === 'pause') return true;
  send(res, 409, { ok: false, error: `intervention requires mode=pause (current: ${s?.mode || 'unknown'})` });
  return false;
}

// 不依赖任何项目 state 的写端点（唯一例外）；其余写类都要求显式 ?p
const PROJECT_AGNOSTIC_WRITES = new Set(['/shutdown']);
/** 判断该请求是否为「需要项目上下文的写」——是则缺 ?p 必须 400（读/HEAD/OPTIONS 不受限） */
function writeNeedsProject(method, pathname) {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  return !PROJECT_AGNOSTIC_WRITES.has(pathname);
}

/** tmux 缺席时的统一响应（503 —— 服务在但外部依赖不在，不是 404/500） */
function noSession(res, rt) {
  return send(res, 503, { ok: false, error: `tmux session '${rt.ctx.tmux.sessionName}' not found; run bootstrap.sh` });
}

module.exports = { readJson, send, requirePaused, writeNeedsProject, noSession };
