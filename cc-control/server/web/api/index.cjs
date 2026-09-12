'use strict';
/**
 * api/index.cjs — 对外 HTTP 面（装配与入口）
 *
 * 本层只做三件事：**解析请求 → 分派到对应域 → 回兜底响应**。所有业务动作经 runtime（能力装配）完成，
 * 因此这里不出现任何 `session.state = ...` 这类状态写入 —— 那是能力自己的接口。
 *
 * 两条入口规则（原有语义，别改）：
 *   - 写类端点缺 `?p` → 400，**绝不**兜底到 boot 项目（2026-09-10 真机事故：手工 curl 缺 ?p
 *     静默暂停了在跑的 run 四小时）。唯一例外 `/shutdown`。
 *   - 读类保留 boot 兜底（`GET /status` 是 CLI 的 server 发现入口）。
 *
 * 请求 → 项目 runtime 的寻址：路径里的 `?p=<projectRoot>` 经 registry.resolveRuntime 解析；
 * 缺省落 boot（只对读类成立，见上）。**同一个 server 进程服务多项目**，靠的就是这一条。
 *
 * 域划分（按文件；各域导出 `handle(req,res,url,rt,deps)` 返回 boolean，true=已处理并响应）：
 *   util.cjs       共享工具（readJson / send / requirePaused / writeNeedsProject / noSession）
 *   hook.cjs       /hook（含 ?sid 早路）
 *   state.cjs      /awf/state · metrics · diagnostics · /context-ready · /run/state/*
 *   decisions.cjs  /awf/decisions*（列表 / resolve / override）
 *   planning.cjs   /awf/dynamic-planning/proposals + /run/dynamic-planning/*
 *   session.cjs    /status · /choice · /ask · /send · /cmd · /intervene · /stop · /respond
 *   run.cjs        /run/submit · /run/status · /run/events · /oneshot
 *   本文件          基础设施：?p 入口规则 · /shutdown · 前端页面 · 静态托管 · 404 兜底 · WebSocket 升级
 *
 * 约定：所有响应都是 JSON（除前端页面与静态资源）；错误统一形如 `{ ok:false, error }`。
 */

const path = require('node:path');
const fs = require('node:fs');
const { createStaticHost } = require('../static.cjs');
const { encodeTextFrame, upgrade: wsUpgrade } = require('../ws.cjs');
const { send, writeNeedsProject } = require('./util.cjs');
const hook = require('./hook.cjs');
const state = require('./state.cjs');
const decisions = require('./decisions.cjs');
const planning = require('./planning.cjs');
const session = require('./session.cjs');
const run = require('./run.cjs');

/**
 * 建 api：把 registry 与 stopServer 作为依赖注入，返回 handler 集合。
 * 闭包内不持有任何项目运行态 —— 一切按请求现取 runtime（`registry.resolveRuntime`），
 * 这是「一个 api 实例服务多项目」的前提。
 * @param {object} deps
 * @param {object} deps.registry         项目注册表（resolveRuntime / list / all / bootRoot）
 * @param {Function} deps.stopServer     优雅关闭（/shutdown 用）
 */
function createApi({ registry, stopServer }) {
  // ── 静态托管 ──
  // web 构建产物目录（默认 server/public，可经 CC_WEB_PUBLIC 覆盖）。webIndexHtml() 每次实时读盘，
  // 故产物更新无需重启；缺产物时前端页面路由会明确告警并回 503，而不是给白屏。
  const WEB_PUBLIC_DEFAULT = path.join(__dirname, '..', 'public');
  const webPublicRoot = () => process.env.CC_WEB_PUBLIC || WEB_PUBLIC_DEFAULT;
  const webIndexHtml = () => {
    try { return fs.readFileSync(path.join(webPublicRoot(), 'index.html')); } catch { return null; }
  };
  // 前端「页面」路径集合：这些都是 SPA 的一个入口，统一回 index.html（由前端路由接管）
  const PAGE_PATHS = new Set([
    '/', '/dashboard', '/dashboard.html', '/diagnostics', '/diagnostics.html', '/decisions', '/decisions.html',
  ]);
  /** 惰性构造静态托管实例（产物缺失则返回 null，由调用方回 503） */
  function webHostInstance() {
    if (!webIndexHtml()) return null;
    return createStaticHost({ root: webPublicRoot(), aliases: { '/': 'index.html' }, spa: 'index.html' });
  }

  // 注入给各域：只含「与请求无关」的进程级依赖（各域按需取用，如 session 取 registry 列项目）
  const deps = { registry, stopServer };

  /** 顶层 handler：解析 URL + 触发活动刷新，再进 handleInner */
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    touch(); // 每个请求都算「有活动」，供空闲回收计时
    return handleInner(req, res, url);
  }

  /** 供 bootstrap 注入「活动刷新」（空闲回收计时） */
  let touch = () => {};
  function setTouch(fn) { touch = fn; }

  async function handleInner(req, res, url) {
    const pathname = url.pathname;

    // 写类端点缺 ?p → 400，绝不兜底到 boot
    // （事故根因：无 ?p 时被兜底到 boot 项目，手工 curl 的写落进了在跑的 run）
    if (writeNeedsProject(req.method, pathname) && !url.searchParams.get('p')) {
      console.warn(`[hook] 拒绝写请求 ${req.method} ${pathname}：缺 ?p（来源 ${req.socket?.remoteAddress || '?'}）。`
        + '若这是 /hook，说明 hook 网关没拿到 CC_PROJECT（bootstrap 注入缺失）');
      return send(res, 400, {
        ok: false,
        error: `写类端点缺 ?p：拒绝兜底到 boot 项目（${registry.bootRoot}）。请显式带 ?p=<projectRoot>；`
          + 'hook 网关 / CLI / MCP 会自动带上。',
        endpoint: pathname,
      });
    }

    // /shutdown 不读任何项目 state，先处理（它也是唯一豁免 ?p 的写端点）
    if (req.method === 'POST' && pathname === '/shutdown') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, shutting: true })); // 先回响应再关，避免客户端等超时
      setTimeout(() => { stopServer().then(() => { if (require.main === module) process.exit(0); }); }, 60);
      return;
    }

    // 到这里才解析项目 runtime：后续所有路由都在某个项目的 runtime 上操作
    const rt = registry.resolveRuntime({ p: url.searchParams.get('p') });

    // ── 前端页面：只由 web 构建产物承载；缺产物明确告警 ──
    if (req.method === 'GET' && PAGE_PATHS.has(pathname)) {
      const idx = webIndexHtml();
      if (idx) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(idx);
      }
      const expected = path.join(webPublicRoot(), 'index.html');
      console.warn(`[web] 前端产物缺失：${expected} —— 请运行 npm run build（会构建 web/ → server/public）`);
      return send(res, 503, { ok: false, error: '前端产物缺失：请运行 npm run build', expected });
    }

    // ── 各域依次分派：第一个返回 true（已响应）的胜出 ──
    // 各域路由互不重叠，顺序对行为无影响；按域归位便于阅读与维护。
    if (await hook.handle(req, res, url, rt, deps)) return;
    if (await state.handle(req, res, url, rt, deps)) return;
    if (await decisions.handle(req, res, url, rt, deps)) return;
    if (await planning.handle(req, res, url, rt, deps)) return;
    if (await session.handle(req, res, url, rt, deps)) return;
    if (await run.handle(req, res, url, rt, deps)) return;

    // ── 静态托管 ──（所有前面未命中的 GET 走这里；命中即返回，未命中才 404）
    if (req.method === 'GET') {
      const host = webHostInstance();
      if (host && host.serve(req, res, pathname)) return;
    }

    return send(res, 404, { ok: false, error: 'not found' });
  }

  /**
   * WebSocket 升级：/run/events 实时事件推送。
   * 非 /run/events 的升级请求直接断开（本 server 只此一个 WS 端点）。
   * 就绪后订阅 run host 事件，把每个事件编码成文本帧写出；订阅的退订函数挂在 onClose/onError 上。
   */
  function handleUpgrade(req, socket) {
    let pathname = '/';
    try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch { /* 保持默认 */ }
    if (pathname !== '/run/events') {
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }
    // 解析目标项目 runtime；解析失败则退到 boot（WS 也不该静默丢连接，退到 boot 至少有事件流）
    const rt = (() => {
      try { return registry.resolveRuntime({ p: new URL(req.url, 'http://localhost').searchParams.get('p') }); } catch { return registry.runtimeFor(registry.bootRoot); }
    })();
    rt.ensureRunHost()
      .then(() => {
        if (!rt.runHost) { try { socket.destroy(); } catch { /* ignore */ } return; } // 宿主装不起来 → 断开
        const unsub = rt.runHost.subscribe((event) => {
          try {
            if (socket.writable) socket.write(encodeTextFrame(JSON.stringify(event))); // 每个事件一行 JSON
          } catch { /* ignore */ }
        });
        wsUpgrade(req, socket, { onClose: unsub, onError: unsub }); // 连接关/错都退订，防订阅泄漏
      })
      .catch(() => { try { socket.destroy(); } catch { /* ignore */ } });
  }

  return { handle, handleUpgrade, setTouch, webPublicRoot };
}

module.exports = { createApi };
