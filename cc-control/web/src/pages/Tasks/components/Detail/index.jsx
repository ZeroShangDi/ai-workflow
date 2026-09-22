import { API } from '../../../../shared/api/index.js';
import { EmptyState as Empty, DetailField as Field } from '../../../../shared/components/ui/index.js';
import Badge from '../../../../shared/components/business/StatusBadge/index.jsx';
import { originOf, originLabel, gateOf } from '../../model.js';
export default function TaskDetail({
  task, action, busy
}) {
  if (!task) return <Empty>选择任务查看详情</Empty>;
  const gate = originOf(task) === 'gate-fix' ? gateOf(task) : null;
  return (<><small>{task.id}</small><h1>{task.title || task.name || task.id}</h1><Badge value={task.status} /><Field title="描述" value={task.description} /><Field title="依赖" value={task.deps || task.dependsOn || task.dependencies} /><Field title="类型" value={task.kind} /><Field title="来源" value={originLabel(originOf(task))} />{gate && <Field title="触发门禁" value={gate} />}<Field title="验收标准" value={task.acceptanceCriteria || task.acceptance} />{['blocked', 'error'].includes(task.status) && <button disabled={busy} onClick={() => action(API.taskAction(task.id, task.status === 'blocked' ? 'unblock' : 'retry'), {})}>{task.status === 'blocked' ? '解除阻塞' : '重试任务'}</button>}<Field title="执行信息" value={task.exec} /></>);
}
