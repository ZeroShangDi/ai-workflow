// common.js — awf server 托管页共享工具（3 html 公共：esc / format / task 列表 / 多项目作用域）
// T1-086：从 dashboard/decisions/diagnostics 内联脚本中抽取公共实现。
// 多项目收口：单 server 多项目（主键 projectRoot，URL ?p=）——页面按 ?p 定位到本项目，
//   页面内所有同源请求自动附 ?p，并提供项目切换条。缺 p 时回落 server boot 项目（旧行为）。
// 暴露 window.AWF_COMMON（页面脚本按需调用；后续任务可逐步把内联实现替换为共享实现）。
(function () {
  'use strict';

  /** 原生 fetch（绕开作用域包装用：项目列表必须不带 p 才拿得到全量） */
  const rawFetch = typeof window !== 'undefined' && typeof window.fetch === 'function'
    ? window.fetch.bind(window) : null;

  /** HTML 转义（渲染外部文本防注入） */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 时长格式化（ms → "9s"/"1m 05s"/"1h 01m 05s"） */
  function fmtDuration(ms) {
    const seconds = Math.max(0, Math.floor(Number(ms) / 1000 || 0));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
    if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
    return `${s}s`;
  }

  /** 单任务行（HTML 字符串；cls: done/active/blocked） */
  function taskRow(task) {
    const cls = task.status === 'done' ? 'done' : task.status === 'blocked' ? 'blocked' : task.status === 'active' ? 'active' : 'muted';
    const elapsed = task.startedAt ? fmtDuration(Date.now() - new Date(task.startedAt).getTime()) : '';
    return `<div class="${cls}"><span class="mono">[${esc(task.id)}]</span> ${esc(task.title || '')} <span class="muted">${elapsed}</span></div>`;
  }

  /** 渲染任务列表到容器（el.innerHTML） */
  function renderTaskList(el, tasks) {
    if (!el) return;
    el.innerHTML = (tasks || []).map(taskRow).join('') || '<div class="muted">（无任务）</div>';
  }

  window.AWF_COMMON = {
    esc, fmtDuration, taskRow, renderTaskList,
    projectScope, withProject, hrefWith, installProjectScope, mountProjectBar, rawFetch,
  };

  // ── 单 server 多项目：页面作用域（?p） ──

  /** 当前页面作用域的项目根（URL ?p=）；null = server boot 项目 */
  function projectScope() {
    return new URLSearchParams(location.search).get('p');
  }

  /** 相对路径附 ?p=（有既有 query 则 & 追加）；绝对 URL 或已带 p 原样返回 */
  function withProject(path) {
    const p = projectScope();
    const s = String(path);
    if (!p || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
    const [base, q = ''] = s.split('?');
    if (new URLSearchParams(q).has('p')) return s;
    return q ? `${base}?${q}&p=${encodeURIComponent(p)}` : `${base}?p=${encodeURIComponent(p)}`;
  }

  /** 基于当前 URL 生成链接：保留既有参数（含 p），覆盖/删除 params 指定项（值 null → 删除） */
  function hrefWith(params = {}) {
    const q = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(params)) {
      if (v == null) q.delete(k); else q.set(k, v);
    }
    const s = q.toString();
    return s ? `?${s}` : location.pathname;
  }

  /**
   * 页面内所有同源请求自动附 ?p=。
   * 托管页请求点分散（每页 10+ 处），逐个改易漏——漏一个就会读到 boot 项目的状态，
   * 故统一在 fetch 处收口；只处理同源相对路径，绝对 URL 原样透传。
   */
  function installProjectScope() {
    if (!rawFetch || window.__awfScopedFetch) return;
    window.fetch = (input, init) => rawFetch(typeof input === 'string' ? withProject(input) : input, init);
    window.__awfScopedFetch = true;
  }

  /** 项目切换条：/status（不带 p）返回已注册项目列表；多于一个项目才渲染。 */
  async function mountProjectBar() {
    if (!rawFetch || !document.body || document.getElementById('awfProjects')) return;
    let projects = [];
    try {
      const res = await rawFetch('/status'); // 不带 p：拿全量项目列表
      projects = (await res.json()).projects || [];
    } catch { return; }
    if (!Array.isArray(projects) || projects.length <= 1) return; // 单项目：不打扰

    const current = projectScope() || projects[0].projectRoot;
    const nameOf = (root) => String(root).replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '') || root;
    const chips = projects.map((pr) => {
      const label = esc(nameOf(pr.projectRoot));
      const title = esc(pr.projectRoot);
      const state = esc(pr.state || '');
      return pr.projectRoot === current
        ? `<b title="${title}" style="color:#58a6ff">${label}</b><span style="color:#484f58"> ${state}</span>`
        : `<a title="${title}" style="color:#7cc;text-decoration:none" href="${esc(hrefWith({ p: pr.projectRoot }))}">${label}</a>`;
    }).join('<span style="color:#484f58"> · </span>');

    const bar = document.createElement('div');
    bar.id = 'awfProjects';
    bar.style.cssText = 'padding:6px 20px;background:#161822;border-bottom:1px solid #252836;'
      + 'font:12px/1.8 -apple-system,BlinkMacSystemFont,sans-serif;display:flex;gap:8px;align-items:center';
    bar.innerHTML = `<span style="color:#6e7681">项目</span>${chips}`;
    document.body.insertBefore(bar, document.body.firstChild);
  }

  // 脚本在 head 同步加载（先于页面内联脚本）→ 立即装作用域包装；DOM 就绪后再挂项目条
  installProjectScope();
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountProjectBar);
    else mountProjectBar();
  }
})();
