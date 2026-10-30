// DSH browser module format; React is supplied by the host module loader.
window.__ModuleLoader__.load({
  id: 'awf-dsh-plugin',
  factory: (require) => {
    const { createElement, useEffect, useRef, useState } = require('react');
    const frontendUrl = 'http://127.0.0.1:8787/';

    function HiddenComposer() {
      return createElement('div', { 'data-conversation-composer-overlay': '', hidden: true });
    }

    function AwfView({ sessionId, useSessions, useWorkspaces, clientContext }) {
      const frame = useRef(null);
      const [theme, setTheme] = useState(() => clientContext.theme.getTheme().active.colorScheme);
      const session = useSessions(state => state.byId[sessionId]);
      const workspaces = useWorkspaces(state => state.items);
      const workspace = workspaces.find(item => item.sessionIds.includes(sessionId))
        || workspaces.find(item => item.path === session?.cwd);
      const pid = workspace?.workspaceId || '';
      const projectRoot = session?.cwd || workspace?.path || '';
      const url = new URL(frontendUrl);
      url.search = new URLSearchParams({ mode: 'dsh', pid, sid: sessionId }).toString();
      useEffect(() => clientContext.on('theme/change', snapshot => {
        setTheme(snapshot.active.colorScheme);
      }), [clientContext]);
      // conversation.view only mounts the active tab. Registering this temporary
      // takeover therefore removes DSH's resident composer exactly while AWF is
      // visible; switching back to Chat/Trajectory disposes it and restores input.
      useEffect(() => clientContext.slots.register({
        name: 'conversation.composer',
        priority: 100,
        select: owner => owner.sessionId === sessionId ? true : null,
      }, HiddenComposer), [clientContext, sessionId]);
      useEffect(() => {
        if (!pid || !projectRoot) return;
        const message = { type: 'awf:context', mode: 'dsh', pid, sid: sessionId, projectRoot, theme };
        const send = () => frame.current?.contentWindow?.postMessage(message, url.origin);
        const receive = event => {
          if (event.source !== frame.current?.contentWindow || event.origin !== url.origin) return;
          if (event.data?.type === 'awf:ready' && event.data.mode === 'dsh'
            && event.data.pid === pid && event.data.sid === sessionId) send();
        };
        window.addEventListener('message', receive);
        send();
        return () => window.removeEventListener('message', receive);
      }, [pid, sessionId, projectRoot, theme]);
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
          minWidth: 0,
          minHeight: 0,
          flex: '1 1 0',
          border: 0,
          background: 'transparent',
        },
      });
    }

    return {
      inject: ['slots', 'theme'],
      apply(ctx) {
        // Slot registrations are scoped to the plugin and removed on unload.
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'awf',
          order: 20, // Native chat = 0, trajectory = 10.
          label: 'AWF',
        }, props => createElement(AwfView, { ...props, clientContext: ctx })));
      },
    };
  },
});
