import './styles.css';
import RunProgress from './RunProgress.jsx';
import TaskMatrix from './TaskMatrix.jsx';
import ExecutionTasks from './ExecutionTasks.jsx';
// 只产出内容，不包 .detail-pane —— 容器由调用方给（Run 页是自己的 aside，
// 任务页是 SplitPane 的 detail 位），否则会嵌套成「面板里的面板」。
export default function RunOverview(props) {
  return (
    <div className="overview-panel">
      <RunProgress {...props} />
      <TaskMatrix tasks={props.tasks} />
      <ExecutionTasks active={props.active} />
    </div>
  );
}
