import { useTasksPage } from './hooks/useTasksPage.js';
import TaskList from './components/List/index.jsx';
import TaskDetail from './components/Detail/index.jsx';
export default function TasksPage({
  data
}) {
  const page = useTasksPage(data);
  return (<div className="split-view">
    <section className="primary-pane">
      <TaskList {...page} />
    </section>
    <aside className="detail-pane">
      <TaskDetail task={page.task} />
    </aside>
  </div>);
}
