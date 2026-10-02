import { useCallback, useMemo, useRef, useState } from 'react';
import { API } from '@/shared/api/index.js';
import { createApiClient } from '@/shared/lib/http.js';
import { mergeEvents } from '@/shared/lib/events.js';
import { usePolling } from '@/shared/hooks/usePolling.js';
import { getRoute } from '@/app/routes.js';

export function useWorkspace(project, view = 'run', requirementId = '', sessionId = '') {
  const client = useMemo(() => createApiClient({ project }), [project]);
  const [data, setData] = useState({}),
    [errors, setErrors] = useState({});
  const [events, setEvents] = useState([]),
    [revision, setRevision] = useState(0);
  const [eventNotice, setEventNotice] = useState('');
  const cursor = useRef(0);
  const refresh = useCallback(() => setRevision(r => r + 1), []);
  usePolling(
    async signal => {
      const route = getRoute(view);
      const paths = { status: route.snapshot ? API.snapshot : API.status, runs: API.runs };
      for (const key of route.reads) {
        // AppShell owns the shared project workspace used by both the sidebar
        // and page content. This hook only polls route-specific page data.
        if (key === 'workspace') continue;
        const endpoint = typeof API[key] === 'function' ? API[key]() : API[key];
        paths[key] = requirementId && ['decisions', 'proposals'].includes(key)
          ? `${endpoint}?requirementId=${encodeURIComponent(requirementId)}`
          : endpoint;
      }
      await Promise.all(
        Object.entries(paths).map(async ([key, path]) => {
          try {
            const response = await client.get(path, { signal });
            if (signal.aborted) return;
            if (response.ok === false) throw new Error(response.error || '读取失败');
            // Persistence-backed endpoints may be returned directly or inside
            // the standard `{ data }` envelope. Normalize the workspace once
            // here so every page consumes the same `data.workspace` shape.
            const normalized = key === 'workspace' && !response.workspace
              ? { ...response, workspace: response.data?.workspace || response.data || null }
              : response;
            setData(old => ({ ...old, [key]: normalized }));
            setErrors(old => ({ ...old, [key]: null }));
          } catch (error) {
            if (!signal.aborted) setErrors(old => ({ ...old, [key]: error.message }));
          }
        }),
      );
    },
    { enabled: !!project, interval: sessionId ? 1500 : 3000, revision: `${project}:${view}:${requirementId}:${sessionId}:${revision}` },
  );
  usePolling(
    async signal => {
      try {
        // Drain several pages after reconnect without overlapping requests.
        for (let page = 0; page < 8; page++) {
          const response = await client.get(API.eventPage(cursor.current), { signal });
          if (signal.aborted) return;
          if (response.ok === false) throw new Error(response.error);
          if (response.tailSeq < cursor.current) {
            cursor.current = 0;
            setEvents([]);
            setEventNotice('运行服务已重启，重新读取当前事件。');
            continue;
          }
          if (response.trimmed > cursor.current) setEventNotice('较早事件已超出服务端保留范围。');
          cursor.current = response.afterSeq;
          setEvents(old => mergeEvents(old, response.events || []));
          setErrors(old => ({ ...old, events: null }));
          if (!response.events?.length || cursor.current >= response.tailSeq) break;
        }
      } catch (error) {
        if (!signal.aborted) setErrors(old => ({ ...old, events: error.message }));
      }
    },
    { enabled: !!project, interval: 1500, revision: project },
  );
  return { client, data, events, errors, eventNotice, refresh };
}
