import '@/shared/components/business/workflow.css';

const sessionStatus = { created: '待开始', active: '进行中', completed: '已完成', interrupted: '已中断', failed: '失败' };
const sessionKind = { plan: 'Plan', run: 'Run' };

export default function ProjectPage({ project, data, setView }) {
  const workspace = data.workspace;
  const environment = workspace?.environment;

  if (!project) return <div className="workflow-page"><h1>从一个项目开始</h1><p className="muted">添加工作目录后，这里将展示项目需求与会话。</p></div>;
  return (
    <div className="workflow-page">
      <header>
        <small>{project}</small>
        <h1>项目工作空间</h1>
        <p className="muted">一个项目可以有多个需求；每个需求分别拥有 Plan 与 Run 会话。</p>
        <p className="muted">从左侧项目会话栏创建 Plan 会话并选择已有会话。</p>
      </header>
      <section>
        <div className="workflow-row"><div><h3>项目环境</h3><span role="status">{environment?.status === 'ready' ? '已就绪' : '未登记'}</span></div></div>
        <p>{environment?.runtime || '本地运行环境'} · {environment?.branch ? `分支 ${environment.branch}` : '当前 checkout'}</p>
        {(environment?.files || []).map(file => <div className="workflow-row" key={file.path}><div>{file.path}<p className="muted">{file.summary}</p></div><span>{file.status === 'read' ? '✓ 已读取' : '未发现'}</span></div>)}
      </section>
      <section>
        <h3>需求 · {workspace?.requirements?.length || 0}</h3>
        {workspace?.requirements?.length ? workspace.requirements.map(row => (
          <div className="workflow-row" key={row.id}>
            <div><small>{row.id} · {row.status}</small><p>{row.title || row.text || row.requestText}</p></div>
            <button onClick={() => setView('plan', { requirementId: row.id })}>打开 Plan</button>
          </div>
        )) : <p className="muted">还没有需求。使用“新建需求 · Plan”开始一次规划会话。</p>}
      </section>
      <section>
        <h3>项目会话 · {workspace?.sessions?.length || 0}</h3>
        {workspace?.sessions?.length ? workspace.sessions.map(session => (
          <div className="workflow-row" key={session.id}>
            <div><small>{sessionKind[session.kind] || session.kind} · {sessionStatus[session.status] || session.status}</small><p>{session.title || session.id}</p></div>
            <button onClick={() => setView(session.kind === 'plan' ? 'plan' : 'run', { requirementId: session.requirementId, sessionId: session.id })}>查看</button>
          </div>
        )) : <p className="muted">创建需求后，Plan/Run 会话会显示在这里。</p>}
      </section>
    </div>
  );
}
