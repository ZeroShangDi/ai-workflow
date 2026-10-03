import { useAction } from '@/shared/hooks/useAction.js';
import { SplitPane } from '@/shared/components/ui/index.js';
import { useTasksPage } from './hooks/useTasksPage.js';
import TaskList from './components/List/index.jsx';
import TaskDetail from './components/Detail/index.jsx';
// 右侧区块的「运行概览」与 Run 页是同一块视图（进度 + 任务矩阵 + 执行任务），
// 组件住在 shared/components/business/Overview（页面之间不许互相 import）。
import Overview from '@/shared/components/business/Overview/index.jsx';
import { API } from '@/shared/api/index.js';
export default function TasksPage({ data, client, refresh, run, setView, sessionKind }) {
  const operation = useAction(client, refresh);
  // 点「有决策」标记 → 决策页并按该任务筛（唯一跨页通道是 URL 参数）
  const page = useTasksPage(data, {
    goDecisions: taskId => setView('decisions', { task: taskId }),
  });
  const requirementId = data.workspace?.activeRequirement?.id;
  const plan = data.workspace?.plan;
  const hasActiveRun = (data.workspace?.sessions || []).some(session =>
    session.requirementId === requirementId && session.kind === 'run' && ['created', 'active'].includes(session.status),
  ) || (data.runs?.runs || []).some(item => ['running', 'queued'].includes(item.status));
  const hasPendingTasks = page.tasks.some(task => task.status === 'pending');
  const primaryAction = sessionKind === 'plan' && plan?.status === 'approved'
    ? {
        label: hasActiveRun ? 'Run 进行中' : hasPendingTasks ? '执行 Run' : '暂无待执行任务',
        disabled: hasActiveRun || !hasPendingTasks,
        run: async () => {
          const result = await operation.action(API.submitRun, { requirementId });
          if (result?.runId) setView('run', { requirementId, sessionId: result.workflowSessionId, runId: result.runId });
        },
      }
      : null;
  // 操作结果提示挂在列表下方（TaskList 的 .task-status），不随右侧区块切换而消失
  return (
    <SplitPane
      primary={<TaskList {...page} {...operation} primaryAction={primaryAction} sessionKind={sessionKind} />}
      detail={
        page.panel === 'overview' ? (
          <Overview
            run={run}
            done={page.done}
            tasks={page.tasks}
            active={page.active}
            data={data}
            onSelectTask={page.locateTask}
          />
        ) : (
          // key 跟着任务走：换任务时详情整个重挂，页签与弹窗回到初始态，
          // 不会把上一条任务的阅读现场带过来。
          <TaskDetail
            key={page.task?.id}
            task={page.task}
            tasks={page.tasks}
            wbs={page.wbs}
            readOnly={sessionKind === 'plan'}
            {...operation}
          />
        )
      }
    />
  );
}
