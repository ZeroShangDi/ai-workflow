'use strict';
/**
 * static.cjs — 静态托管骨架（现有 html 原样承载，web/ 迁出前的临时宿主）
 *
 * 现有页面（dashboard/diagnostics/decisions/ui）内联于 src/server/*.html，由 server.cjs 各自
 * readFileSync 返回。本模块提供统一静态宿主接缝：给定 root 目录，把 URL path 解析到文件并
 * 以正确 MIME 输出——迁移到 web/（前端工程产物托管）前先作临时承载；迁移完成后退役。
 *
 * createStaticHost({ root, aliases }) 返回：
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

/** 默认页面别名：把无扩展名的 UI 路径映射到对应 html（现状 /、/ui、/diagnostics、/decisions.html） */
function defaultAliases() {
  return {
    '/': 'dashboard.html',
    '/dashboard': 'dashboard.html',
    '/dashboard.html': 'dashboard.html',
    '/ui': 'ui.html',
    '/ui.html': 'ui.html',
    '/diagnostics': 'diagnostics.html',
    '/diagnostics.html': 'diagnostics.html',
    '/decisions': 'decisions.html',
    '/decisions.html': 'decisions.html',
  };
}

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function createStaticHost({ root = __dirname, aliases = defaultAliases() } = {}) {
  const rootResolved = path.resolve(root);

  /** 把 URL path 解析到 root 下文件；越权/不存在 → null */
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
      else return null;
    }
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
