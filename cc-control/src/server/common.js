// common.js — awf server 托管页共享工具（4 html 公共：esc / format / task 列表）
// T1-086：从 dashboard/ui/decisions/diagnostics 内联脚本中抽取公共实现。
// 暴露 window.AWF_COMMON（页面脚本按需调用；后续任务可逐步把内联实现替换为共享实现）。
(function () {
  'use strict';

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

  window.AWF_COMMON = { esc, fmtDuration, taskRow, renderTaskList };
})();
