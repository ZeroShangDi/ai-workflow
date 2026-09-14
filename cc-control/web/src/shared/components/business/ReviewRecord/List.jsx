import SegmentedControl from '../../ui/SegmentedControl/index.jsx';
import { Button, EmptyState as Empty } from '../../ui/index.js';
import Badge from '../StatusBadge/index.jsx';
import { display, label, formatTime } from '../../../lib/format.js';
export default function ReviewRecordList({
  title,
  emptyLabel,
  entries,
  busy,
  filter,
  setFilter,
  visible,
  item,
  keyOf,
  idOf,
  setSelected,
  titleOf
}) {
  return (<><header className="pane-header">
      <div>
        <h1>{title}</h1>
        <small>当前项目 · {entries.length} 条</small>
      </div>
      <SegmentedControl disabled={busy} label="记录状态" value={filter} onChange={setFilter} options={[{ value: 'all', label: '全部' }, ...[...new Set(entries.map(e => e.status).filter(Boolean))].map(value => ({ value, label: label(value) }))]} />
    </header><div className="record-list">{visible.map(e => <Button disabled={busy} key={keyOf(e)} className={`record-card ${item && keyOf(item) === keyOf(e) ? 'selected' : ''}`} onClick={() => {
        setSelected(keyOf(e));
      }}>
        <div className="card-meta">
          <small>{idOf(e)}</small>
          <Badge value={e.status} />
        </div>
        <h3>{display(titleOf(e))}</h3>
        {e.answer && <p className="record-summary">{display(e.answer)}</p>}
        <div className="record-footer"><small>{formatTime(e.createdAt || e.created_at || e.at || e.runStamp)}</small><small>查看详情 ›</small></div>
      </Button>)}{!visible.length && <Empty>暂无{emptyLabel}</Empty>}</div></>);
}
