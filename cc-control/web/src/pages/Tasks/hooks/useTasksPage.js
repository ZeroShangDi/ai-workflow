import { useState } from 'react';
import { display } from '../../../shared/lib/format.js';
export function useTasksPage(data) {
  const tasks = data.state?.tasks || [];
  const [filter, setFilter] = useState('all'),
    [search, setSearch] = useState(''),
    [selected, setSelected] = useState(null);
  const visible = tasks.filter(t => (filter === 'all' || t.status === filter) && display(t).toLowerCase().includes(search.toLowerCase()));
  const task = visible.find(t => t.id === selected) || visible[0];
  return {
    tasks,
    done: tasks.filter(t => t.status === 'done').length,
    filter,
    setFilter,
    search,
    setSearch,
    visible,
    task,
    setSelected
  };
}
