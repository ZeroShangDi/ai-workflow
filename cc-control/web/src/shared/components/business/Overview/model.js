// Keep the active middle visible while aggregating homogeneous ends.
export function matrixCells(tasks, limit = 16) {
  if (tasks.length <= limit) return tasks.map(task => ({ ...task, count: 1 }));
  let start = 0, end = tasks.length;
  while (start < end && tasks[start].status === 'done') start++;
  while (end > start && tasks[end - 1].status === 'pending') end--;
  const head = start ? [{ id: 'completed-group', status: 'done', title: `${start} 个已完成任务`, count: start }] : [];
  const tail = end < tasks.length ? [{ id: 'pending-group', status: 'pending', title: `${tasks.length - end} 个待执行任务`, count: tasks.length - end }] : [];
  const middle = tasks.slice(start, end).map(task => ({ ...task, count: 1 }));
  const capacity = limit - head.length - tail.length;
  return [...head, ...middle.slice(0, middle.length > capacity ? capacity - 1 : capacity), ...(middle.length > capacity ? [{ id: 'other-group', status: 'mixed', count: middle.length - capacity + 1, title: '其余任务，请在任务页查看' }] : []), ...tail];
}
