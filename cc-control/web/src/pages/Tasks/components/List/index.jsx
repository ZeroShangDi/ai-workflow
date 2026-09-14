import { Button, Input, Select, EmptyState as Empty } from '../../../../shared/components/ui/index.js';
import Badge from '../../../../shared/components/business/StatusBadge/index.jsx';
import { label } from '../../../../shared/lib/format.js';
export default function TaskList({
  tasks,
  filter,
  setFilter,
  search,
  setSearch,
  visible,
  task,
  setSelected
}) {
  return (<><header className="pane-header">
      <div>
        <h1>任务</h1>
        <small>当前项目 · 全部任务 {tasks.length}</small>
      </div>
    </header><div className="toolbar">
      <Input aria-label="搜索任务" placeholder="搜索任务…" value={search} onChange={e => setSearch(e.target.value)} />
      <Select aria-label="任务状态" value={filter} onChange={e => setFilter(e.target.value)}>
        <option value="all">全部状态</option>
        {[...new Set(tasks.map(t => t.status))].map(s => <option key={s} value={s}>{label(s)}</option>)}
      </Select>
    </div><div className="record-list">{visible.map(t => <Button className={`record-card ${task?.id === t.id ? 'selected' : ''}`} key={t.id} onClick={() => setSelected(t.id)}>
        <div className="card-meta">
          <small>{t.id}</small>
          <Badge value={t.status} />
        </div>
        <h3>{t.title || t.name || t.id}</h3>
        {t.description && <p>{t.description}</p>}
      </Button>)}{!visible.length && <Empty>{tasks.length ? '没有匹配的任务' : '暂无任务'}</Empty>}</div></>);
}
