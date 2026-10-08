import '@/shared/components/business/workflow.css';
export default function RunOutput({ output, setFollow, workflowSession, data }) {
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
        <pre className="terminal">
          {data.status?.session
            ? snapshot || '正在读取 CC 实时输出…'
            : '当前项目没有运行中的 CC 会话。'}
        </pre>
        {!workflowSession && <p className="muted">请从左侧项目会话栏选择一个 Plan 或 Run 会话。</p>}
      </div>
    </>
  );
}
