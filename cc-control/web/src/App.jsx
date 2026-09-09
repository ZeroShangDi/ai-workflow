// web/src/App.jsx — 前端壳：view 路由 + 多 run 列表（T1-092 由 hosted runShell 迁入）。
// 顶层读 ?view&?sid；头部渲染四视图导航 + 宿主 /run/status 的多 run 列表（chip 切换 sid），
// body 以 key={view:sid} 渲染对应视图（切换即重挂载，子视图用自己 sid 的 client）。
import { useEffect, useMemo, useState } from 'react';
import { createApiClient } from './api/client.js';
import { toRunShellModel, runSummary } from './views/run-shell-model.js';
import Dashboard from './views/Dashboard.jsx';
import Decisions from './views/Decisions.jsx';
import Diagnostics from './views/Diagnostics.jsx';
import WbsTree from './views/WbsTree.jsx';

const VIEWS = [
  { key: 'dashboard', label: '总览' },
  { key: 'decisions', label: '决策' },
  { key: 'diagnostics', label: '诊断' },
  { key: 'wbs-tree', label: 'WBS' },
];

function parseQuery() {
  const p = new URLSearchParams(window.location.search);
  const rawView = p.get('view') || 'dashboard';
  const view = VIEWS.some((v) => v.key === rawView) ? rawView : 'dashboard';
  return { view, sid: p.get('sid') };
}

function toQuery(view, sid) {
  const p = new URLSearchParams();
  p.set('view', view);
  if (sid) p.set('sid', sid);
  const s = p.toString();
  return `?${s}`;
}

export default function App() {
  const initial = useMemo(parseQuery, []); // 仅首次从 url 读入
  const [view, setView] = useState(initial.view);
  const [sid, setSid] = useState(initial.sid);
  const [shell, setShell] = useState(toRunShellModel());

  // 视图/sid 与 url 同步（replaceState，不触发整页刷新）
  useEffect(() => {
    window.history.replaceState(null, '', toQuery(view, sid));
  }, [view, sid]);

  // 多 run 列表：宿主 /run/status 轮询 + run 事件即时刷新
  const listClient = useMemo(() => createApiClient(), []);
  useEffect(() => {
    async function refreshRuns() {
      const r = await listClient.get('/run/status').catch(() => null);
      if (r && Array.isArray(r.runs)) setShell(toRunShellModel(r));
    }
    refreshRuns();
    const timer = setInterval(refreshRuns, 3000);
    const ws = listClient.stream('/run/events');
    ws.onmessage = () => { refreshRuns(); };
    return () => { clearInterval(timer); try { ws.close(); } catch { /* ignore */ } };
  }, [listClient]);

  function selectView(v) { setView(v); }
  function selectRun(runId) { setSid((cur) => (cur === runId ? null : runId)); } // 再点当前 run → 回项目根

  return (
    <div className="app-shell">
      <header className="shell-header">
        <h1>AWF</h1>
        <nav className="view-nav">
          {VIEWS.map((v) => (
            <button key={v.key} className={view === v.key ? 'active' : ''} onClick={() => selectView(v.key)}>
              {v.label}
            </button>
          ))}
        </nav>
        <div className="run-list">
          {shell.isEmpty ? (
            <span className="muted">（无 run）</span>
          ) : (
            shell.runs.map((r) => (
              <button
                key={r.runId}
                className={`chip ${r.runId === sid ? 'active' : ''} ${r.status}`}
                title={runSummary(r)}
                onClick={() => selectRun(r.runId)}
              >
                {r.runId} · {r.status}{r.progress !== '0/0' ? ` · ${r.progress}` : ''}
              </button>
            ))
          )}
        </div>
      </header>
      <div className="shell-body" key={`${view}:${sid || 'root'}`}>
        {view === 'decisions' ? <Decisions sid={sid} />
          : view === 'diagnostics' ? <Diagnostics sid={sid} />
            : view === 'wbs-tree' ? <WbsTree sid={sid} />
              : <Dashboard sid={sid} />}
      </div>
    </div>
  );
}
