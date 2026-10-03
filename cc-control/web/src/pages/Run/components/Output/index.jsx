import { display } from '@/shared/lib/format.js';
import '@/shared/components/business/workflow.css';
export default function RunOutput({ output, setFollow, events, runId, workflowSession, data, requirementId, setView, conversation }) {
  const sessionKind = workflowSession?.kind === 'plan' ? 'Plan' : 'Run';
  const snapshot = data.status?.snapshot;
  return (
    <>
      <header className="pane-header">
        <div className="run-identity">
          <span className="status-dot" />
          <h1>{workflowSession?.title || `${sessionKind} 会话`}</h1>
        </div>
      </header>
      <div
        className="output-area"
        ref={output}
        onScroll={e => {
          const n = e.currentTarget;
          setFollow(n.scrollHeight - n.scrollTop - n.clientHeight < 48);
        }}>
        <pre className="terminal">{conversation || snapshot || (data.status?.session ? '正在读取会话画面…' : '当前项目没有运行中的会话。')}</pre>
        {workflowSession && (
          <div className="session-log-link">
            <button type="button" onClick={() => setView('logs', { requirementId: requirementId || workflowSession.requirementId, sessionId: workflowSession.id })}>查看 {sessionKind} 会话日志</button>
          </div>
        )}
        {!workflowSession && <p className="muted">请从左侧项目会话栏选择一个 Plan 或 Run 会话。</p>}
        {workflowSession?.kind === 'run' && runId && <div className="event-tail">
          {events
            .filter(e => e.runId === runId)
            .slice(-12)
            .map(e => (
              <div key={e.seq}>
                <span className="muted">{e.type}</span> {display(e.payload)}
              </div>
            ))}
        </div>}
      </div>
    </>
  );
}
