import { useCallback, useEffect, useMemo, useState } from 'react';
import { createApiClient } from '../../shared/lib/http.js';
import { API } from '../../shared/api/index.js';
import { usePolling } from '../../shared/hooks/usePolling.js';
import { VIEWS } from '../routes.js';
import { readRoute, routeUrl } from '../router.js';

export function useAppShell() {
  const [route, setRoute] = useState(() => readRoute(window.location));
  const [projects, setProjects] = useState([]), [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const client = useMemo(() => createApiClient(), []);
  const navigate = useCallback((patch, replace = false) => {
    // Reading the URL also handles successive navigation calls in one React batch.
    const next = { ...readRoute(window.location), ...patch };
    const url = routeUrl(next, window.location.href);
    if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
    }
    setRoute(next);
  }, []);
  useEffect(() => {
    const sync = () => { setRoute(readRoute(window.location)); setOpen(false); };
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  usePolling(async signal => {
    try {
      const result = await client.get(API.status, { signal });
      if (signal.aborted) return;
      if (result.ok === false) throw new Error(result.error);
      setProjects(result.projects || (result.projectRoot ? [{ projectRoot: result.projectRoot }] : []));
      if (!readRoute(window.location).project && result.projectRoot) navigate({ project: result.projectRoot }, true);
      setError('');
    } catch (e) { if (!signal.aborted) setError(e.message); }
  }, { interval: 5000 });
  useEffect(() => {
    if (!open) return;
    const close = event => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);
  return { ...route, projects, client, error, open, setOpen, views: VIEWS,
    setView: view => navigate({ view }),
    setRunId: runId => navigate({ runId }),
    setProject: (project, view) => { navigate({ project, runId: '', ...(view ? { view } : {}) }); setOpen(false); },
  };
}
