import { useCallback, useEffect, useState } from 'react';

// Platform context only; page configuration and layout belong to their own modules.
export function readHostContext(location) {
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') || 'cc';
  return {
    mode,
    pid: params.get('pid') || '',
    sid: params.get('sid') || '',
    projectRoot: mode === 'dsh' ? null : params.get('p'),
  };
}
export function acceptHostMessage(event, { parent, origin, context }) {
  const value = event.data;
  if (event.source !== parent || event.origin !== origin || value?.type !== 'awf:context') return null;
  if (value.mode !== context.mode || value.pid !== context.pid || value.sid !== context.sid) return null;
  if (typeof value.projectRoot !== 'string' || !value.projectRoot) return null;
  return { ...context, projectRoot: value.projectRoot };
}
export function resolveProject(context, projects = []) {
  if (context.projectRoot) return context.projectRoot;
  if (context.mode === 'dsh') return null;
  return projects.find(p => (p.projectId || p.id || p.projectRoot) === context.pid)?.projectRoot || null;
}

export function useHostContext() {
  const [context, setContext] = useState(() => readHostContext(window.location));
  const refreshContext = useCallback(() => {
    setContext(previous => {
      const next = readHostContext(window.location);
      const sameIdentity = next.mode === previous.mode && next.pid === previous.pid && next.sid === previous.sid;
      return next.mode === 'dsh' && sameIdentity ? previous : next;
    });
  }, []);
  useEffect(() => {
    window.addEventListener('popstate', refreshContext);
    return () => window.removeEventListener('popstate', refreshContext);
  }, [refreshContext]);
  const { mode, pid, sid } = context;
  useEffect(() => {
    if (mode !== 'dsh' || window.parent === window) return;
    let origin;
    try { origin = new URL(document.referrer).origin; } catch { return; }
    const identity = { mode, pid, sid, projectRoot: null };
    const receive = event => {
      const next = acceptHostMessage(event, { parent: window.parent, origin, context: identity });
      if (next) setContext(previous => previous.projectRoot === next.projectRoot ? previous : next);
    };
    window.addEventListener('message', receive);
    window.parent.postMessage({ type: 'awf:ready', mode, pid, sid }, origin);
    return () => window.removeEventListener('message', receive);
  }, [mode, pid, sid]);
  return { ...context, refreshContext };
}
