// web/src/App.jsx — 前端壳：项目 / 视图 / run 三层寻址。
// URL：?p=<projectRoot>（项目作用域；缺省 = server boot 项目）+ ?view=<视图> + ?sid=<runId>（聚焦某 run）。
// 头部渲染：项目 chip（/status 不带 p 才返回全量项目列表；仅多项目时显示）+ 四视图导航 +
// 本项目 /run/status 的 run chip。body 以 key 全量重挂载，子视图用自己作用域的 client。
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

/** 项目根 → 显示名（末段目录名） */
function projectName(root) {
  const s = String(root || '').replace(/[\\/]+$/, '');
  return s.replace(/^.*[\\/]/, '') || s || '(boot)';
}

function parseQuery() {
  const p = new URLSearchParams(window.location.search);
  const rawView = p.get('view') || 'dashboard';
  const view = VIEWS.some((v) => v.key === rawView) ? rawView : 'dashboard';
  return { view, sid: p.get('sid'), project: p.get('p') };
}

function toQuery(view, sid, project) {
  const p = new URLSearchParams();
  p.set('view', view);
  if (project) p.set('p', project);
  if (sid) p.set('sid', sid);
  return `?${p.toString()}`;
}

export default function App() {
  const initial = useMemo(parseQuery, []); // 仅首次从 url 读入
  const [view, setView] = useState(initial.view);
  const [sid, setSid] = useState(initial.sid);
  const [project, setProject] = useState(initial.project);
  const [projects, setProjects] = useState([]);
  const [shell, setShell] = useState(toRunShellModel());

  // 视图/项目/sid 与 url 同步（replaceState，不触发整页刷新）
  useEffect(() => {
    window.history.replaceState(null, '', toQuery(view, sid, project));
  }, [view, sid, project]);

  // 项目列表：必须不带 p 请求（带 p 时 server 只回本项目，拿不到全量）
  const rootClient = useMemo(() => createApiClient(), []);
  useEffect(() => {
    let alive = true;
    async function refreshProjects() {
      const s = await rootClient.get('/status').catch(() => null);
      if (alive && Array.isArray(s?.projects)) setProjects(s.projects);
    }
    refreshProjects();
    const timer = setInterval(refreshProjects, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [rootClient]);

  // 本项目作用域的 run 列表：宿主 /run/status 轮询 + run 事件即时刷新
  const listClient = useMemo(() => createApiClient({ project: project || undefined }), [project]);
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
  function selectProject(root) { setProject(root); setSid(null); } // run 归属项目，切项目即清 run 聚焦

  // 无 ?p 时后端回落 boot 项目（registry 里第一个注册的项目），列表首位即它
  const currentProject = project || projects[0]?.projectRoot || null;

  return (
    <div className="app-shell">
      <header className="shell-header">
        <h1>AWF</h1>
        {projects.length > 1 && (
          <div className="project-list">
            {projects.map((pr) => (
              <button
                key={pr.projectRoot}
                className={`chip ${pr.projectRoot === currentProject ? 'active' : ''}`}
                title={pr.projectRoot}
                onClick={() => selectProject(pr.projectRoot)}
              >
                {projectName(pr.projectRoot)}
              </button>
            ))}
          </div>
        )}
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
      <div className="shell-body" key={`${project || 'boot'}:${view}:${sid || 'root'}`}>
        {view === 'decisions' ? <Decisions sid={sid} project={project} />
          : view === 'diagnostics' ? <Diagnostics sid={sid} project={project} />
            : view === 'wbs-tree' ? <WbsTree sid={sid} project={project} />
              : <Dashboard sid={sid} project={project} />}
      </div>
    </div>
  );
}
