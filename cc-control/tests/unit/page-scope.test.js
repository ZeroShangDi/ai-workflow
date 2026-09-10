import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// 托管页多项目作用域（common.js）：页面按 ?p 定位本项目，且页面内所有同源请求自动附 ?p。
// 直接在一个 stub 浏览器环境里执行真实 common.js，断言行为（而非 grep 源码）。

const COMMON_JS = fs.readFileSync(fileURLToPath(new URL('../../src/server/common.js', import.meta.url)), 'utf8');

/** 在 stub 环境执行 common.js；返回 { AWF_COMMON, window, fetchCalls } */
function loadCommon({ search = '', readyState = 'complete' } = {}) {
  const fetchCalls = [];
  const rawFetch = async (url) => { fetchCalls.push(String(url)); return { json: async () => ({ ok: true }) }; };
  const window = { fetch: rawFetch };
  const document = {
    readyState,
    body: null, // 非 null 会触发 mountProjectBar 的 DOM 操作；项目条单测见下
    getElementById: () => null,
    addEventListener: () => {},
    createElement: () => ({ style: {}, set innerHTML(v) {}, }),
    firstChild: null,
  };
  const ctx = {
    window, document, fetch: rawFetch,
    location: { search, pathname: '/dashboard.html' },
    URLSearchParams, encodeURIComponent, decodeURIComponent, console,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(COMMON_JS, ctx);
  return { AWF_COMMON: window.AWF_COMMON, window, fetchCalls, rawFetch };
}

describe('common.js — 项目作用域（?p）', () => {
  it('projectScope 读 ?p；无 p → null（= server boot 项目）', () => {
    expect(loadCommon({ search: '?p=%2Ftmp%2Fa' }).AWF_COMMON.projectScope()).toBe('/tmp/a');
    expect(loadCommon({ search: '?view=wbs-tree' }).AWF_COMMON.projectScope()).toBe(null);
  });

  it('withProject：附 ?p / 合并既有 query / 已带 p 不重复 / 绝对 URL 不动 / 无 p 原样', () => {
    const c = loadCommon({ search: '?p=%2Ftmp%2Fa' }).AWF_COMMON;
    expect(c.withProject('/run/status')).toBe('/run/status?p=%2Ftmp%2Fa');
    expect(c.withProject('/run/status?runId=default')).toBe('/run/status?runId=default&p=%2Ftmp%2Fa');
    expect(c.withProject('/status?p=%2Ftmp%2Fb')).toBe('/status?p=%2Ftmp%2Fb');
    expect(c.withProject('http://example.com/x')).toBe('http://example.com/x');
    expect(loadCommon({ search: '' }).AWF_COMMON.withProject('/run/status')).toBe('/run/status');
  });

  it('hrefWith：保留当前 p，覆盖/删除指定参数', () => {
    const c = loadCommon({ search: '?p=%2Ftmp%2Fa&view=dashboard' }).AWF_COMMON;
    expect(c.hrefWith({ sid: 'default' })).toBe('?p=%2Ftmp%2Fa&view=dashboard&sid=default');
    expect(c.hrefWith({ sid: null })).toBe('?p=%2Ftmp%2Fa&view=dashboard');
    expect(c.hrefWith({ p: '/tmp/b', sid: null })).toBe('?p=%2Ftmp%2Fb&view=dashboard');
  });

  it('installProjectScope：页面内 fetch 自动附 ?p（跨项目时漏一处就会读到 boot 项目）', async () => {
    const { window, AWF_COMMON } = loadCommon({ search: '?p=%2Ftmp%2Fa' });
    await window.fetch('/awf/state');
    await window.fetch('/run/status?runId=r1');
    await window.fetch('http://example.com/x');
    expect(AWF_COMMON.rawFetch).toBeTruthy();
    expect(window.__awfScopedFetch).toBe(true);
  });

  it('已带 p 的请求不被二次追加（防重复包装）', () => {
    const c = loadCommon({ search: '?p=%2Ftmp%2Fa' }).AWF_COMMON;
    expect(c.withProject(c.withProject('/awf/state'))).toBe('/awf/state?p=%2Ftmp%2Fa');
  });
});

describe('common.js — 项目条（>1 个项目才渲染）', () => {
  let mountCalls;

  /** 带 DOM 的最小环境：记录 insertBefore 的节点 */
  function loadWithDom(projects) {
    mountCalls = [];
    const window = {
      fetch: async (url) => {
        mountCalls.push(String(url));
        return { json: async () => ({ projects }) };
      },
    };
    const body = {
      firstChild: null,
      insertBefore: (el) => { mountCalls.push({ id: el.id, html: el.innerHTML }); },
    };
    const document = {
      readyState: 'complete',
      body,
      getElementById: () => null,
      addEventListener: () => {},
      createElement: () => ({ id: '', style: { cssText: '' }, innerHTML: '' }),
    };
    const ctx = {
      window, document, fetch: window.fetch,
      location: { search: '?p=%2Ftmp%2Fa', pathname: '/' },
      URLSearchParams, encodeURIComponent, decodeURIComponent, console,
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(COMMON_JS, ctx);
    return window;
  }

  beforeEach(() => { mountCalls = []; });

  it('多项目：以不带 p 的 /status 取全量列表并渲染切换链接', async () => {
    loadWithDom([
      { projectRoot: '/tmp/a', state: 'ready' },
      { projectRoot: '/tmp/b', state: 'busy' },
    ]);
    await new Promise((r) => setTimeout(r, 0));
    expect(mountCalls[0]).toBe('/status'); // 关键：不带 p，否则只回本项目
    const bar = mountCalls.find((c) => c && c.id === 'awfProjects');
    expect(bar).toBeTruthy();
    expect(bar.html).toContain('/tmp/b');
    expect(bar.html).toContain('p=%2Ftmp%2Fb');
  });

  it('单项目：不渲染项目条', async () => {
    loadWithDom([{ projectRoot: '/tmp/a', state: 'ready' }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(mountCalls.find((c) => c && c.id === 'awfProjects')).toBeFalsy();
  });
});
