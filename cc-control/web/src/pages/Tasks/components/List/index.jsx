import { Button, Input, Select, EmptyState as Empty } from '../../../../shared/components/ui/index.js';
import Badge from '../../../../shared/components/business/StatusBadge/index.jsx';
import { API } from '../../../../shared/api/index.js';
import { label, TASK_STATUSES } from '../../../../shared/lib/format.js';
import { TASK_SOURCES, sourceOf, sourceShort, sourceLabel } from '../../model.js';
export default function TaskList({
  tasks,
  done,
  filter,
  setFilter,
  sourceFilter,
  setSourceFilter,
  search,
  setSearch,
  visible,
  task,
  setSelected,
  action,
  busy
}) {
  // 已知值按固定顺序，server 新加的追加在后面（不静默吞掉）。
  const presentStatuses = new Set(tasks.map(t => t.status));
  const statusOptions = [...TASK_STATUSES.filter(s => presentStatuses.has(s)), ...[...presentStatuses].filter(s => !TASK_STATUSES.includes(s))];
  const presentSources = new Set(tasks.map(sourceOf));
  // 只有一种来源时这个筛选没有意义，直接不显示 —— 避免过渡期多一个空控件。
  const sourceOptions = presentSources.size > 1 ? [...TASK_SOURCES.filter(s => presentSources.has(s)), ...[...presentSources].filter(s => !TASK_SOURCES.includes(s))] : [];
  return (<><header className="pane-header">
      <h1 className="pane-title">任务<span className="pane-progress">{done}/{tasks.length}</span></h1>
      <div className="pane-tools">
        <Input aria-label="搜索任务" placeholder="搜索任务…" value={search} onChange={e => setSearch(e.target.value)} />
        <Select aria-label="任务状态" value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="all">全部状态</option>
          {statusOptions.map(s => <option key={s} value={s}>{label(s)}</option>)}
        </Select>
        {!!sourceOptions.length && <Select aria-label="任务来源" value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}>
          <option value="all">全部来源</option>
          {sourceOptions.map(s => <option key={s} value={s}>{sourceShort(s)}</option>)}
        </Select>}
      </div>
    </header><div className="record-list task-list">{visible.map(t => {
      const title = t.title || t.name || t.id;
      const blocked = t.status === 'blocked';
      const retryable = ['blocked', 'error'].includes(t.status);
      const source = sourceOf(t);
      return (<div key={t.id} role="button" tabIndex={0} className={`record-row ${task?.id === t.id ? 'selected' : ''}`} onClick={() => setSelected(t.id)} onKeyDown={e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        setSelected(t.id);
      }}>
        <span className={`record-id status-${t.status}${source === 'plan' ? '' : ' record-id-derived'}`} title={source === 'plan' ? undefined : sourceLabel(source)}>{t.id}</span>
        <span className="record-title" title={title}>{title}</span>
        <Badge value={t.status} />
        {retryable && <span className="record-actions"><Button disabled={busy} onClick={e => {
          e.stopPropagation();
          action(API.taskAction(t.id, blocked ? 'unblock' : 'retry'), {});
        }}>{blocked ? '解除阻塞' : '重试'}</Button></span>}
      </div>);
    })}{!visible.length && <Empty>{tasks.length ? '没有匹配的任务' : '暂无任务'}</Empty>}</div></>);
}
