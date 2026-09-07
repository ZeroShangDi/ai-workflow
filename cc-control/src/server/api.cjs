'use strict';
/**
 * api.cjs — server API 骨架：路由表 + 分发器（/api/v1 迁移 + 现有端点语义保留）
 *
 * 现有 server.cjs 单 HTTP server 平铺各端点（/status /send /respond /hook /awf/* /intervene 等）。
 * 本模块提供「路由目录 + 分发」接缝，供 W3-003 server 分层时把端点迁到 /api/v1 前缀，
 * 同时保留旧路径别名——语义不变。分发器是纯逻辑：不持有 handler 状态，匹配到即调用
 * handler(routeCtx) 并返回 true；未匹配 false。
 *
 * 用法（未来 server 接线）：
 *   const router = createRouter();
 *   registerRoutes(router, { status: realHandler, send: ..., respond: ..., hook: ... });
 *   if (router.dispatch(method, pathname, ctx)) return; // 已处理
 *   本文件不改写现有 server.cjs（行为不变）。
 */

/** 端点目录：name / method / legacy 路径（现行）/ api 路径（/api/v1 迁移别名）/ 匹配形态 */
const API_CATALOG = [
  { name: 'hook', method: 'POST', legacy: '/hook', api: '/api/v1/hook' },
  { name: 'status', method: 'GET', legacy: '/status', api: '/api/v1/status' },
  { name: 'send', method: 'POST', legacy: '/send', api: '/api/v1/send' },
  { name: 'cmd', method: 'POST', legacy: '/cmd', api: '/api/v1/cmd' },
  { name: 'respond', method: 'POST', legacy: '/respond', api: '/api/v1/respond' },
  { name: 'choice', method: 'POST', legacy: '/choice', api: '/api/v1/choice' },
  { name: 'ask', method: 'POST', legacy: '/ask', api: '/api/v1/ask' },
  { name: 'contextReadyGet', method: 'GET', legacy: '/context-ready', api: '/api/v1/context-ready' },
  { name: 'contextReadyPost', method: 'POST', legacy: '/context-ready', api: '/api/v1/context-ready' },
  { name: 'intervene', method: 'POST', legacy: '/intervene', api: '/api/v1/intervene' },
  { name: 'interveneInterrupt', method: 'POST', legacy: '/intervene/interrupt', api: '/api/v1/intervene/interrupt' },
  { name: 'stop', method: 'POST', legacy: '/stop', api: '/api/v1/stop' },
  { name: 'awfState', method: 'GET', legacy: '/awf/state', api: '/api/v1/awf/state' },
  { name: 'awfMetrics', method: 'GET', legacy: '/awf/metrics', api: '/api/v1/awf/metrics' },
  { name: 'awfDiagnosticsGet', method: 'GET', legacy: '/awf/diagnostics', api: '/api/v1/awf/diagnostics' },
  { name: 'awfDiagnosticsPost', method: 'POST', legacy: '/awf/diagnostics', api: '/api/v1/awf/diagnostics' },
  { name: 'awfDecisions', method: 'GET', legacy: '/awf/decisions', api: '/api/v1/awf/decisions' },
  { name: 'awfDecisionsOverride', method: 'POST', legacyPrefix: '/awf/decisions/', apiPrefix: '/api/v1/awf/decisions/', suffix: '/override' },
  { name: 'index', method: 'GET', legacy: '/', api: '/api/v1/' },
  { name: 'dashboard', method: 'GET', api: '/api/v1/dashboard' },
  { name: 'ui', method: 'GET', legacy: '/ui', api: '/api/v1/ui' },
  { name: 'diagnosticsHtml', method: 'GET', legacy: '/diagnostics', api: '/api/v1/diagnostics' },
  { name: 'decisionsHtml', method: 'GET', legacy: '/decisions.html', api: '/api/v1/decisions.html' },
];

/** 由目录构建路由表：name → { patterns:[legacy/api...], handler } */
function buildRouteTable(catalog = API_CATALOG) {
  const table = new Map(); // key: `${method} ${normalizedPathname}`
  for (const route of catalog) {
    const patterns = [];
    if (route.legacy) patterns.push(route.legacy);
    if (route.api) patterns.push(route.api);
    for (const p of patterns) table.set(`${route.method} ${p}`, route.name);
  }
  return table;
}

/** 归一化 pathname：去 query（url.pathname 已去），去尾部斜杠（根除外） */
function normalizePath(pathname) {
  const p = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return p;
}

/**
 * 创建分发器。handlerMap = { name: (routeCtx) => … }。
 * dispatch(method, pathname, routeCtx) → 命中返回 handler 结果（且 routeCtx.name 注入），否则 undefined。
 * 支持 exact（目录条目）与带 suffix 的 override 前缀路由。
 */
function createRouter(handlerMap = {}) {
  const table = buildRouteTable();

  function matchRoute(method, pathname) {
    const p = normalizePath(pathname);
    const exact = table.get(`${method} ${p}`);
    if (exact) return { name: exact };
    // 前缀 + 固定后缀（/awf/decisions/:id/override）
    if (method === 'POST') {
      for (const route of API_CATALOG) {
        if (!route.legacyPrefix || !route.suffix) continue;
        for (const prefix of [route.legacyPrefix, route.apiPrefix]) {
          if (p.startsWith(prefix) && p.endsWith(route.suffix)) return { name: route.name, params: { id: p.slice(prefix.length, -route.suffix.length) } };
        }
      }
    }
    return null;
  }

  return {
    table,
    /** 命中：调用 handlerMap[name](routeCtx)；未命中返回 undefined */
    dispatch(method, pathname, routeCtx = {}) {
      const m = matchRoute(method, pathname);
      if (!m) return undefined;
      const handler = handlerMap[m.name];
      if (typeof handler !== 'function') return undefined;
      return handler({ ...routeCtx, name: m.name, params: m.params || {} });
    },
    /** 该 handlerMap 是否覆盖全部目录端点（供接线自检） */
    missing() {
      const names = new Set();
      for (const route of API_CATALOG) names.add(route.name);
      for (const r of API_CATALOG) {
        if (!handlerMap[r.name]) names.delete(r.name);
      }
      return [...names];
    },
  };
}

/** 校验 handlerMap 覆盖目录全部端点；缺漏抛错（接线期尽早暴露） */
function assertHandlersComplete(handlerMap, { allow } = {}) {
  const allowSet = new Set(allow || []);
  const missing = [];
  for (const route of API_CATALOG) {
    if (allowSet.has(route.name)) continue;
    if (typeof handlerMap[route.name] !== 'function') missing.push(route.name);
  }
  if (missing.length > 0) throw new Error(`api: 未挂接端点 ${missing.join(', ')}`);
  return handlerMap;
}

module.exports = { API_CATALOG, buildRouteTable, normalizePath, createRouter, assertHandlersComplete };
