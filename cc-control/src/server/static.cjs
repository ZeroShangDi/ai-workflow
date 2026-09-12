'use strict';
/**
 * static.cjs — web/ 构建产物的静态托管原语（src/server/public 的宿主）
 *
 * 页面**只有一个来源**：`web/` 的构建产物（T1-118 接进 pipeline，落 `src/server/public`，
 * 文件名带内容哈希、由浏览器加载）。本模块给定 root 目录，把 URL path 解析到文件并以正确 MIME 输出。
 *
 * 曾经承载的 legacy html（dashboard/diagnostics/decisions/ui 内联页）已随 **T1-119** 退役，
 * 与之配套的 `defaultAliases()` 一并删除（issue 004-4）——现在别名表**由调用方显式给出**，
 * 生产调用点只有一处：`server.cjs` 传 `aliases: { '/': 'index.html' }, spa: 'index.html'`。
 *
 * createStaticHost({ root, aliases, spa }) 返回：
 *   resolve(urlPath) → 文件绝对路径（越权/不存在 → null）
 *   serve(req, res, urlPath) → 命中写响应返回 true；未命中/越权返回 false（由调用方决定 404/500）
 *
 * 安全：路径解析禁止 '..' 越权；无扩展名路径按 aliases/同名 .html 兜底；缺省根 = 本目录(src/server)。
 */

const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/**
 * @param {{ root?, aliases?, spa? }} [opts]
 *   aliases 由调用方显式给出 —— 原 defaultAliases()（把 /diagnostics 等映射到 legacy html）
 *   随 T1-119 退役旧观测页一并删除：现在页面只有 web/ 构建产物一个来源，不再有「无扩展名→某 html」的默认表。
 */
function createStaticHost({ root = __dirname, aliases = {}, spa = null } = {}) {
  const rootResolved = path.resolve(root);

  /** 把 URL path 解析到 root 下文件；越权/不存在 → null；spa 开启时无扩展名路径回退 index */
  function resolve(urlPath) {
    const raw = String(urlPath || '/');
    // 去 query/hash
    const p = raw.split(/[?#]/)[0];
    // 禁止相对越权
    if (p.includes('..')) return null;

    // 别名（无扩展名 UI 路径 → html）
    const alias = aliases[p];
    if (alias) return path.join(rootResolved, alias);

    const joined = path.join(rootResolved, p);
    if (!joined.startsWith(rootResolved + path.sep) && joined !== rootResolved) return null;
    // 直接文件或同 html 兜底（/foo → foo.html）
    let file = joined;
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      const html = `${joined}.html`;
      if (fs.existsSync(html) && !fs.statSync(html).isDirectory()) file = html;
      else file = null;
    }
    // SPA 回退：无扩展名的前端路由（如 /wbs-tree）→ index.html（产物托管；默认关闭）
    if (file == null && spa) {
      const base = path.basename(p);
      if (base.indexOf('.') === -1) {
        const idx = path.join(rootResolved, spa);
        if (fs.existsSync(idx) && !fs.statSync(idx).isDirectory()) file = idx;
      }
    }
    if (file == null) return null;
    if (fs.statSync(file).isDirectory()) return null;
    return file;
  }

  /** 命中即写响应返回 true；未命中/越权 false */
  function serve(req, res, urlPath) {
    const file = resolve(urlPath);
    if (!file) return false;
    let body;
    try {
      body = fs.readFileSync(file);
    } catch {
      return false;
    }
    res.writeHead(200, { 'content-type': mimeFor(file) });
    res.end(body);
    return true;
  }

  return { root: rootResolved, resolve, serve };
}

module.exports = { createStaticHost, MIME };
