// DSH browser module format; React is supplied by the host module loader.
window.__ModuleLoader__.load({
  id: 'awf-dsh-plugin',
  factory: (require) => {
    const { createElement, useEffect, useRef } = require('react');
    const frontendUrl = 'http://127.0.0.1:5174/';

    function AwfView({ sessionId, useSessions, useWorkspaces }) {
      const frame = useRef(null);
      const session = useSessions(state => state.byId[sessionId]);
      const workspaces = useWorkspaces(state => state.items);
      const workspace = workspaces.find(item => item.sessionIds.includes(sessionId))
        || workspaces.find(item => item.path === session?.cwd);
      const pid = workspace?.workspaceId || '';
      const projectRoot = session?.cwd || workspace?.path || '';
      const url = new URL(frontendUrl);
      url.search = new URLSearchParams({ mode: 'dsh', pid, sid: sessionId }).toString();
      useEffect(() => {
        if (!pid || !projectRoot) return;
        const message = { type: 'awf:context', mode: 'dsh', pid, sid: sessionId, projectRoot };
        const send = () => frame.current?.contentWindow?.postMessage(message, url.origin);
        const ready = event => {
          if (event.source !== frame.current?.contentWindow || event.origin !== url.origin) return;
          if (event.data?.type === 'awf:ready' && event.data.mode === 'dsh'
            && event.data.pid === pid && event.data.sid === sessionId) send();
        };
        window.addEventListener('message', ready);
        send();
        return () => window.removeEventListener('message', ready);
      }, [pid, sessionId, projectRoot]);
      if (!pid || !projectRoot) return createElement('div', { role: 'status' }, '等待当前会话的项目上下文…');
      return createElement('iframe', {
        title: 'AWF',
        src: url.toString(),
        key: `${pid}:${sessionId}`,
        ref: frame,
        referrerPolicy: 'origin',
        style: {
          display: 'block',
          width: '100%',
          height: '100%',
          minHeight: 0,
          flex: '1 1 auto',
          border: 0,
          background: '#fff',
        },
      });
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Slot registrations are scoped to the plugin and removed on unload.
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'awf',
          order: 20, // Native chat = 0, trajectory = 10.
          label: 'AWF',
        }, AwfView));
      },
    };
  },
});
