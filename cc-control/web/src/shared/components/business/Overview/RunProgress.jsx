import Badge from '../StatusBadge/index.jsx';
export default function RunProgress({
  run,
  done,
  tasks,
  data
}) {
  return (<section className="run-progress">
    <div className="summary-heading">
      <h1>{run ? `Run #${run.runId}` : 'Run 概览'}</h1>
      {run && <Badge value={run.status} />}
    </div>
    <div className="progress-label">
      <small>当前项目任务</small>
      <span>{done} / {tasks.length}</span>
      {tasks.length > 0 && <span>{Math.round(done / tasks.length * 100)}%</span>}
    </div>
    <progress value={done} max={tasks.length || 1} />
    {data.status?.activeAgents != null && <small>{data.status.activeAgents} 个 Agent 正在执行任务</small>}
  </section>);
}
