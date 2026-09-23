import { useAction } from '../../shared/hooks/useAction.js';
import { useTasksPage } from './hooks/useTasksPage.js';
import TaskList from './components/List/index.jsx';
import TaskDetail from './components/Detail/index.jsx';
// 右侧区块的「运行概览」与 Run 页是同一块视图（进度 + 任务矩阵 + 执行任务），
// 组件住在 shared/components/business/Overview（页面之间不许互相 import）。
import Overview from '../../shared/components/business/Overview/index.jsx';
export default function TasksPage({
  data, client, refresh, run
}) {
  const operation = useAction(client, refresh);
  const page = useTasksPage(data);
  return (<div className="split-view">
    <section className="primary-pane">
      <TaskList {...page} {...operation} />
    </section>
    {page.panel === 'overview' ? <Overview run={run} done={page.done} tasks={page.tasks} active={page.active} data={data} /> : <aside className="detail-pane">
      <TaskDetail task={page.task} {...operation} />
    </aside>}
  </div>);
}
