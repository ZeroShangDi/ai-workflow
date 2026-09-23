import { useState } from 'react';
import { display } from '@/shared/lib/format.js';
import { sourceOf } from '@/pages/Tasks/model.js';
export function useTasksPage(data) {
  const tasks = data.state?.tasks || [];
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
  return {
    tasks,
    done: tasks.filter(t => t.status === 'done').length,
    active: tasks.filter(t => t.status === 'active'),
    planSummary: data.state?.plan?.summary || '',
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
    togglePanel: () => setPanel(current => (current === 'overview' ? 'detail' : 'overview')),
  };
}
