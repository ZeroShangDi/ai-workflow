import { useAction } from '../../shared/hooks/useAction.js';
import { SplitPane } from '../../shared/components/ui/index.js';
import { useTasksPage } from './hooks/useTasksPage.js';
import TaskList from './components/List/index.jsx';
import TaskDetail from './components/Detail/index.jsx';
export default function TasksPage({
  data, client, refresh
}) {
  const operation = useAction(client, refresh);
  const page = useTasksPage(data);
  return <SplitPane
    primary={<TaskList {...page} {...operation} />}
    detail={<><TaskDetail task={page.task} {...operation} /><p role="status">{operation.message}</p></>}
  />;
}
