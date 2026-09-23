import { useWorkspace } from './hooks/useWorkspace.js';
import Statusbar from '../layouts/WorkspaceLayout/components/Statusbar.jsx';
import { Button } from '../shared/components/ui/index.js';
import { lazy, Suspense } from 'react';
import { ROUTES, getRoute } from './routes.js';
import ErrorBoundary from '../shared/components/ui/ErrorBoundary.jsx';
const pages = Object.fromEntries(ROUTES.map(route => [route.key, lazy(route.load)]));
export default function Workspace({ project, view, runId, setRunId, setView, connectionError }) {
  const workspace = useWorkspace(project, view);
  const { data, errors } = workspace;
  const runs = data.runs?.runs || [];
  const active = runs.find(r => ['running', 'queued'].includes(r.status));
  const run = runId ? runs.find(r => r.runId === runId) : active || runs.at(-1);
  const props = {
    ...workspace,
    project,
    run,
    runId: run?.runId || runId,
    selectedRunId: runId,
    runs,
    setRunId,
    setView,
  };
  const route = getRoute(view);
  const Page = pages[route.key];
  const relevant = ['status', 'runs', 'events', ...route.reads];
  return (
    <>
      <main className="workspace">
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
              <Button onClick={workspace.refresh}>重试</Button>
            </div>
          ))}
        {workspace.eventNotice && <div role="status">{workspace.eventNotice}</div>}
        <ErrorBoundary key={view}>
          <Suspense
            fallback={
              <div className="empty" role="status">
                正在加载页面…
              </div>
            }>
            <Page {...props} route={route} />
          </Suspense>
        </ErrorBoundary>
      </main>
      <Statusbar project={project} run={run} data={data} errors={errors} />
    </>
  );
}
