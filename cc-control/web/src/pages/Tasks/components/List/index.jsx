import { Button, Input, Select, EmptyState as Empty } from '../../../../shared/components/ui/index.js';
import Icon from '../../../../shared/components/ui/Icon/index.jsx';
import Badge from '../../../../shared/components/business/StatusBadge/index.jsx';
import { API } from '../../../../shared/api/index.js';
import { label, TASK_STATUSES } from '../../../../shared/lib/format.js';
import { TASK_SOURCES, sourceOf, sourceShort, sourceLabel } from '../../model.js';
export default function TaskList({
  tasks,
  done,
  planSummary,
  filter,
  setFilter,
  sourceFilter,
  setSourceFilter,
  search,
  setSearch,
  visible,
  selected,
  panel,
  selectTask,
  togglePanel,
  action,
  busy,
  message
}) {
  // 完整枚举，不按数据裁剪 —— 这是「分类法选择器」而不是「可用值选择器」：
  // 没有动态任务时也要看得见「动态规划 (0)」，否则会以为是前端坏了。
  // 计数按全部任务算（不受另一个筛选影响），0 也照实显示。
  const count = keyOf => tasks.reduce((acc, t) => {
    const key = keyOf(t);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const statusCounts = count(t => t.status);
  const sourceCounts = count(sourceOf);
  // 已知值按固定顺序；server 新加的值追加在末尾（不静默吞掉）。
  const statusOptions = [...TASK_STATUSES, ...Object.keys(statusCounts).filter(s => !TASK_STATUSES.includes(s))];
  const sourceOptions = [...TASK_SOURCES, ...Object.keys(sourceCounts).filter(s => !TASK_SOURCES.includes(s))];
  // 需求摘要只取标题段（`plan.summary` 一般写成 `<需求标题>—— <细节…>`）；
  // 太长由 CSS 截断，全文放 title，不在这里猜长度。
  const requirement = planSummary.split(/——|；|。/)[0].trim();
  return (<><header className="pane-header">
      <h1 className="pane-title">任务{!!requirement && <span className="pane-summary" title={planSummary}>· {requirement}</span>}<span className="pane-progress">{done}/{tasks.length}</span></h1>
      <div className="pane-tools">
        <Input aria-label="搜索任务" placeholder="搜索任务…" value={search} onChange={e => setSearch(e.target.value)} />
        <Select aria-label="任务状态" value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="all">全部状态 ({tasks.length})</option>
          {statusOptions.map(s => <option key={s} value={s}>{label(s)} ({statusCounts[s] || 0})</option>)}
        </Select>
        <Select aria-label="任务来源" value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}>
          <option value="all">全部来源 ({tasks.length})</option>
          {sourceOptions.map(s => <option key={s} value={s}>{sourceShort(s)} ({sourceCounts[s] || 0})</option>)}
        </Select>
        <span className="pane-divider" aria-hidden="true" />
        <Button className="pane-toggle" aria-label={panel === 'overview' ? '切换到任务详情' : '切换到运行概览'} aria-pressed={panel === 'overview'} onClick={togglePanel}><Icon name="overview"/></Button>
      </div>
    </header><div className="record-list task-list">{visible.map(t => {
      const title = t.title || t.name || t.id;
      const blocked = t.status === 'blocked';
      const retryable = ['blocked', 'error'].includes(t.status);
      const source = sourceOf(t);
      return (<div key={t.id} role="button" tabIndex={0} className={`record-row ${selected === t.id ? 'selected' : ''}`} onClick={() => selectTask(t.id)} onKeyDown={e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        selectTask(t.id);
      }}>
        <span className={`record-id status-${t.status}${source === 'plan' ? '' : ' record-id-derived'}`} title={source === 'plan' ? undefined : sourceLabel(source)}>{t.id}</span>
        <span className="record-title" title={title}>{title}</span>
        <Badge value={t.status} />
        {retryable && <span className="record-actions"><Button disabled={busy} onClick={e => {
          e.stopPropagation();
          action(API.taskAction(t.id, blocked ? 'unblock' : 'retry'), {});
        }}>{blocked ? '解除阻塞' : '重试'}</Button></span>}
      </div>);
    })}{!visible.length && <Empty>{tasks.length ? '没有匹配的任务' : '暂无任务'}</Empty>}</div>{!!message && <p className="task-status" role="status">{message}</p>}</>);
}
