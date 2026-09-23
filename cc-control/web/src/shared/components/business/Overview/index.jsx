import './styles.css';
import RunProgress from './RunProgress.jsx';
import TaskMatrix from './TaskMatrix.jsx';
import ExecutionTasks from './ExecutionTasks.jsx';
export default function RunOverview(props) {
  return (<aside className="detail-pane run-overview">
    <RunProgress {...props} />
    <TaskMatrix tasks={props.tasks} />
    <ExecutionTasks active={props.active} />
  </aside>);
}
