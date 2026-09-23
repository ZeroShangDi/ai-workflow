import { useAction } from '@/shared/hooks/useAction.js';
import { SplitPane } from '@/shared/components/ui/index.js';
import { useTasksPage } from './hooks/useTasksPage.js';
import TaskList from './components/List/index.jsx';
import TaskDetail from './components/Detail/index.jsx';
// 右侧区块的「运行概览」与 Run 页是同一块视图（进度 + 任务矩阵 + 执行任务），
// 组件住在 shared/components/business/Overview（页面之间不许互相 import）。
import Overview from '@/shared/components/business/Overview/index.jsx';
export default function TasksPage({ data, client, refresh, run }) {
  const operation = useAction(client, refresh);
  const page = useTasksPage(data);
  // 操作结果提示挂在列表下方（TaskList 的 .task-status），不随右侧区块切换而消失
  return (
    <SplitPane
      primary={<TaskList {...page} {...operation} />}
      detail={
        page.panel === 'overview' ? (
          <Overview
            run={run}
            done={page.done}
            tasks={page.tasks}
            active={page.active}
            data={data}
          />
        ) : (
          // key 跟着任务走：换任务时详情整个重挂，页签与弹窗回到初始态，
          // 不会把上一条任务的阅读现场带过来。
          <TaskDetail
            key={page.task?.id}
            task={page.task}
            tasks={page.tasks}
            wbs={page.wbs}
            {...operation}
          />
        )
      }
    />
  );
}
