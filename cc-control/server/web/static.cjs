'use strict';
/**
 * static.cjs — web/ 构建产物的静态托管原语（server/public 的宿主）
 *
 * 页面**只有一个来源**：`web/` 的构建产物（T1-118 接进 pipeline，落 `server/public`，
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
 * 安全：路径解析禁止 '..' 越权；无扩展名路径按 aliases/同名 .html 兜底；缺省根 = 本目录(server/)。
 *
 * 纯函数式：不缓存文件内容，每次 resolve/serve 都实时查磁盘 —— 产物更新无需重启进程。
 */

const fs = require('node:fs');
const path = require('node:path');

// 扩展名 → Content-Type。只列 web 产物会用到的类型；未命中回退 octet-stream。
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

/** 按扩展名查 MIME；未知扩展名回退 application/octet-stream（浏览器按二进制处理） */
function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/**
 * @param {{ root?, aliases?, spa? }} [opts]
 *   root    托管根目录（缺省本文件所在目录 server/）
 *   aliases 精确路径 → 文件名的映射（调用方显式给出，见文件头）
 *   spa     SPA 回退入口文件名；非空时「无扩展名且查不到文件」的路径回退到它（默认关闭）
 *   aliases 由调用方显式给出 —— 原 defaultAliases()（把 /diagnostics 等映射到 legacy html）
 *   随 T1-119 退役旧观测页一并删除：现在页面只有 web/ 构建产物一个来源，不再有「无扩展名→某 html」的默认表。
 */
function createStaticHost({ root = __dirname, aliases = {}, spa = null } = {}) {
  const rootResolved = path.resolve(root);

  /** 把 URL path 解析到 root 下文件；越权/不存在 → null；spa 开启时无扩展名路径回退 index */
  function resolve(urlPath) {
    const raw = String(urlPath || '/');
    // 去 query/hash（URL pathname 本不带，但 urlPath 可能来自未经 URL 解析的调用方）
    const p = raw.split(/[?#]/)[0];
    // 禁止相对越权：只要出现 '..' 一律拒（比逐段 resolve 更保守，宁拒不放）
    if (p.includes('..')) return null;

    // 别名（无扩展名 UI 路径 → html）：显式表优先于磁盘探测
    const alias = aliases[p];
    if (alias) return path.join(rootResolved, alias);

    const joined = path.join(rootResolved, p);
    // 解析后必须仍在 root 之内（防 path.join 归一化把 /a/../../b 逃出生天）
    if (!joined.startsWith(rootResolved + path.sep) && joined !== rootResolved) return null;
    // 直接文件或同 html 兜底（/foo → foo.html）
    let file = joined;
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      const html = `${joined}.html`;
      if (fs.existsSync(html) && !fs.statSync(html).isDirectory()) file = html;
      else file = null;
    }
    // SPA 回退：无扩展名的前端路由（如 /wbs-tree）→ index.html（产物托管；默认关闭）
    // 判据「basename 不含 .」：带扩展名的多半是资源文件，缺了就该 404，不能一律回 index
    if (file == null && spa) {
      const base = path.basename(p);
      if (base.indexOf('.') === -1) {
        const idx = path.join(rootResolved, spa);
        if (fs.existsSync(idx) && !fs.statSync(idx).isDirectory()) file = idx;
      }
    }
    if (file == null) return null;
    if (fs.statSync(file).isDirectory()) return null; // 目录不可直接输出（无自动 index 探测）
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
      return false; // 解析到了但读失败（权限/竞态被删）→ 交调用方 404，不抛
    }
    res.writeHead(200, { 'content-type': mimeFor(file) });
    res.end(body);
    return true;
  }

  return { root: rootResolved, resolve, serve };
}

module.exports = { createStaticHost, MIME };
