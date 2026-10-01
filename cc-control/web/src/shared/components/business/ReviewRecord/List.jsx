import SegmentedControl from '@/shared/components/ui/SegmentedControl/index.jsx';
import { Button, EmptyState as Empty } from '@/shared/components/ui/index.js';
import Badge from '@/shared/components/business/StatusBadge/index.jsx';
import { display, label, formatTime } from '@/shared/lib/format.js';
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
  titleOf,
  note,
}) {
  return (
    <>
      <header className="pane-header">
        {/* 标题 + 灰色描述同行（与任务页 .pane-title 一致），不再上下排布 */}
        <h1 className="pane-title">
          {title}
          <span className="pane-summary">
            · 当前项目 · {entries.length} 条{note ? ` · ${note}` : ''}
          </span>
        </h1>
        <SegmentedControl
          disabled={busy}
          label="记录状态"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: '全部' },
            ...[...new Set(entries.map(e => e.status).filter(Boolean))].map(value => ({
              value,
              label: label(value),
            })),
          ]}
        />
      </header>
      <div className="record-list">
        {visible.map(e => (
          <Button
            disabled={busy}
            key={keyOf(e)}
            className={`record-card ${item && keyOf(item) === keyOf(e) ? 'selected' : ''}`}
            onClick={() => {
              setSelected(keyOf(e));
            }}>
            <div className="card-meta">
              <small>{idOf(e)}</small>
              <Badge value={e.status} />
            </div>
            <h3>{display(titleOf(e))}</h3>
            {e.answer && <p className="record-summary">{display(e.answer)}</p>}
            <div className="record-footer">
              <small>{formatTime(e.createdAt || e.created_at || e.at || e.runStamp)}</small>
              <small>查看详情 ›</small>
            </div>
          </Button>
        ))}
        {!visible.length && <Empty>暂无{emptyLabel}</Empty>}
      </div>
    </>
  );
}
