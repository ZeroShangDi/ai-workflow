import { useCallback, useEffect, useMemo, useState } from 'react';
import { createApiClient } from '@/shared/lib/http.js';
import { API } from '@/shared/api/index.js';
import { usePolling } from '@/shared/hooks/usePolling.js';
import { getViews } from '@/app/routes.js';
import { readRoute, routeUrl } from '@/app/router.js';
import { useHostContext, resolveProject } from '@/shared/context.js';

export function useAppShell() {
  const context = useHostContext();
  const { refreshContext } = context;
  const hostBound = context.mode === 'dsh';
  const [route, setRoute] = useState(() => readRoute(window.location));
  const [projects, setProjects] = useState([]),
    [error, setError] = useState('');
  const [workspace, setWorkspace] = useState(null),
    [workspaceError, setWorkspaceError] = useState(''),
    [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [open, setOpen] = useState(false);
  const [projectsRevision, setProjectsRevision] = useState(0);
  const client = useMemo(() => createApiClient(), []);
  const project = resolveProject(context, projects);
  const selectedSession = workspace?.sessions?.find(session => session.id === route.sessionId) || null;
  const sessionKind = selectedSession?.kind || null;
  const workspaceClient = useMemo(() => createApiClient({ project }), [project]);
  const refreshWorkspace = useCallback(() => setWorkspaceRevision(value => value + 1), []);
  const refreshProjects = useCallback(() => setProjectsRevision(value => value + 1), []);
  const navigate = useCallback(
    (patch, replace = false) => {
      // Reading the URL also handles successive navigation calls in one React batch.
      const next = { ...readRoute(window.location), ...patch };
      const url = routeUrl(next, window.location.href);
      if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
        window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
      }
      refreshContext();
      setRoute(readRoute(window.location));
    },
    [refreshContext],
  );
  useEffect(() => {
    const sync = () => {
      setRoute(readRoute(window.location));
      setOpen(false);
    };
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  usePolling(
    async signal => {
      try {
        const [result, projectResult] = await Promise.all([
          client.get(API.status, { signal }), client.get(API.projects, { signal }),
        ]);
        if (signal.aborted) return;
        if (result.ok === false) throw new Error(result.error);
        const projectRows = projectResult.ok === false ? [] : (projectResult.projects || []);
        setProjects(projectRows);
        if (!hostBound && !context.pid && !readRoute(window.location).project && result.projectRoot)
          navigate({ project: result.projectRoot }, true);
        setError('');
      } catch (e) {
        if (!signal.aborted) setError(e.message);
      }
    },
    { interval: 5000, revision: projectsRevision },
  );
  usePolling(
    async signal => {
      try {
        const path = route.requirementId ? API.workspaceFor(route.requirementId) : API.workspace;
        const response = await workspaceClient.get(path, { signal });
        if (signal.aborted) return;
        if (response.ok === false) throw new Error(response.error || '读取项目会话失败');
        setWorkspace(response.workspace || response.data?.workspace || response.data || null);
        setWorkspaceError('');
      } catch (reason) {
        if (!signal.aborted) setWorkspaceError(reason.message || '读取项目会话失败');
      }
    },
    { enabled: !!project, interval: selectedSession && ['created', 'active'].includes(selectedSession.status) ? 1500 : 5000, revision: `${project}:${route.requirementId}:${workspaceRevision}` },
  );
  useEffect(() => {
    if (!open) return;
    const close = event => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);
  const views = useMemo(() => getViews(context.mode, sessionKind), [context.mode, sessionKind]);
  const contextError = !project && (hostBound || context.pid) ? '等待当前项目上下文' : '';
  return {
    ...route,
    project,
    context,
    projects,
    workspace,
    workspaceError,
    sessionKind,
    refreshWorkspace,
    refreshProjects,
    client,
    error: contextError || error,
    open,
    setOpen,
    views,
    // task 默认清空：只在显式传（如任务列表点「有决策」跳决策页并按该任务筛）时带上，
    // 否则切页面会把上一次的筛选带过去。
    setView: (view, params = {}) => navigate({ view, task: '', ...params }),
    setRunId: (runId, sessionId) => navigate({ runId, ...(sessionId ? { sessionId } : {}) }),
    setProject: (project, view) => {
      if (hostBound) return;
      navigate({ project, runId: '', task: '', requirementId: '', sessionId: '', ...(view ? { view } : {}) });
      setOpen(false);
    },
  };
}
