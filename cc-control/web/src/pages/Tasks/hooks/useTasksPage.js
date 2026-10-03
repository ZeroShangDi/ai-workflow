import { useEffect, useState } from 'react';
import { display } from '@/shared/lib/format.js';
import { sourceOf, sortTasks } from '@/pages/Tasks/model.js';
export function useTasksPage(data, { goDecisions = () => {} } = {}) {
  const allTasks = data.workspace?.activeRequirement
    ? (data.workspace.tasks || [])
    : (data.state?.tasks || []);
  // The task page is the complete requirement task list in both Plan and Run.
  // Dynamic proposals have their own review page; hiding plan tasks here made
  // an ordinary Run session look empty whenever it had no derived tasks.
  const tasks = sortTasks(allTasks);
  // 有决策的任务：决策记录的 task_id 直接指向任务（多 agent 下主会话的决策不带 task_id，
  // 那种属于 run 级，不往任务上挂）。
  const decisionTaskIds = new Set(
    (data.decisions?.decisions || []).map(d => d.task_id).filter(Boolean),
  );
  const [filter, setFilter] = useState('all'),
    [sourceFilter, setSourceFilter] = useState('all'),
    [search, setSearch] = useState(''),
    [selected, setSelected] = useState(null),
    // 右侧区块两态：overview = 运行概览（默认，不预选任务），detail = 选中任务的详情
    [panel, setPanel] = useState('overview');
  const visible = tasks.filter(
    t =>
      (filter === 'all' || t.status === filter) &&
      (sourceFilter === 'all' || sourceOf(t) === sourceFilter) &&
      display(t).toLowerCase().includes(search.toLowerCase()),
  );
  // 不兜底到 visible[0]：没点过任务就是没有选中任务，右侧也不显示详情。
  const task = visible.find(t => t.id === selected) || null;
  useEffect(() => {
    if (!selected || panel !== 'detail') return;
    const row = [...document.querySelectorAll('[data-task-id]')].find(node => node.dataset.taskId === selected);
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selected, panel]);
  return {
    tasks,
    // 详情里的「关联依赖 / 关联规划」要按 id 回表查：deps → tasks，wbsRef → wbs
    wbs: data.state?.wbs,
    done: tasks.filter(t => t.status === 'done').length,
    active: tasks.filter(t => t.status === 'active'),
    planSummary: data.workspace?.plan?.summary || data.state?.plan?.summary || '',
    filter,
    setFilter,
    sourceFilter,
    setSourceFilter,
    search,
    setSearch,
    visible,
    task,
    selected,
    // 选中的任务被筛掉时退回概览，免得右侧停在一条不在列表里的任务上
    panel: panel === 'detail' && !task ? 'overview' : panel,
    selectTask: id => {
      setSelected(id);
      setPanel('detail');
    },
    locateTask: id => {
      setFilter('all');
      setSourceFilter('all');
      setSearch('');
      setSelected(id);
      setPanel('detail');
    },
    hasDecision: task => decisionTaskIds.has(task.id),
    openDecisions: taskId => goDecisions(taskId),
    togglePanel: () => setPanel(current => (current === 'overview' ? 'detail' : 'overview')),
  };
}
