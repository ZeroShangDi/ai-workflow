import { label } from '../../../shared/lib/format.js';
export default function Statusbar({
  run,
  data,
  errors
}) {
  return (<footer className="statusbar">
    <span>{run ? `${run.runId} · ${label(run.status)}` : '暂无 Run'}</span>
    <span>{label(data.state?.mode)}</span>
    <span className="status-end">{data.status?.activeAgents != null && `${data.status.activeAgents} agents`}</span>
    <span>{errors.status ? '连接异常' : data.status ? '已连接' : '连接中'}</span>
  </footer>);
}
