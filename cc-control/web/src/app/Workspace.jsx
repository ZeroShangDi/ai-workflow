import { useWorkspace } from './hooks/useWorkspace.js';
import Statusbar from '@/layouts/WorkspaceLayout/components/Statusbar.jsx';
import { Button } from '@/shared/components/ui/index.js';
import { lazy, Suspense } from 'react';
import { ROUTES, getRoute } from './routes.js';
import ErrorBoundary from '@/shared/components/ui/ErrorBoundary.jsx';
const pages = Object.fromEntries(ROUTES.map(route => [route.key, lazy(route.load)]));
export default function Workspace({
  project,
  workspace: sharedWorkspace,
  workspaceError,
  refreshWorkspace,
  view,
  runId,
  task,
  requirementId,
  sessionId,
  setRunId,
  setView,
  setProject,
  connectionError,
}) {
  const workspaceState = useWorkspace(project, view, requirementId, sessionId);
  const data = { ...workspaceState.data, workspace: sharedWorkspace || workspaceState.data.workspace };
  const errors = { ...workspaceState.errors, workspace: workspaceError || workspaceState.errors.workspace };
  const workflowSession = data.workspace?.sessions?.find(session => session.id === sessionId) || null;
  const runs = data.runs?.runs || [];
  const active = runs.find(r => ['running', 'queued'].includes(r.status));
  const run = runId ? runs.find(r => r.runId === runId) : active || runs.at(-1);
  const props = {
    ...workspaceState,
    data,
    errors,
    refreshWorkspace,
    project,
    run,
    runId: run?.runId || runId,
    selectedRunId: runId,
    task,
    requirementId,
    sessionId,
    sessionKind: workflowSession?.kind || null,
    runs,
    setRunId,
    setView,
    setProject,
  };
  const route = getRoute(view);
  const Page = pages[route.key];
  const relevant = ['status', 'runs', 'events', ...route.reads];
  return (
    <>
      <main className={`workspace${view === 'requirements' ? ' workspace-requirements' : ''}`}>
        {project && data.workspace && !(data.workspace.requirements || []).length && !workspaceError && !route.management && (
          <div className="project-empty-state">
            <h1>{data.workspace.project?.name || project.split(/[\\/]/).filter(Boolean).at(-1)}</h1>
            <p>暂无需求</p>
            <small>从左侧项目会话栏创建需求。</small>
          </div>
        )}
        {!project && (
          <div className="connection-notice" role="status">
            {connectionError
              ? '暂未连接到 server，等待连接恢复'
              : '工作空间为空，点击左侧「添加项目」开始。'}
          </div>
        )}
        {relevant
          .filter(k => errors[k])
          .map(k => (
            <div className="error" role="alert" key={k}>
              {k}：{errors[k]}
              <Button onClick={workspaceState.refresh}>重试</Button>
            </div>
          ))}
        {workspaceState.eventNotice && <div role="status">{workspaceState.eventNotice}</div>}
        {(!project || !data.workspace || (data.workspace.requirements || []).length > 0 || workspaceError || route.management) && <ErrorBoundary key={view}>
          <Suspense
            fallback={
              <div className="empty" role="status">
                正在加载页面…
              </div>
            }>
            <Page {...props} route={route} />
          </Suspense>
        </ErrorBoundary>}
      </main>
      <Statusbar project={project} run={run} data={data} errors={errors} />
    </>
  );
}
