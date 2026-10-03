import { matrixCells } from './model.js';
import { label } from '@/shared/lib/format.js';
import { taskDisplayId } from '@/shared/lib/task.js';
export default function TaskMatrix({ tasks, onSelectTask }) {
  return (
    <section className="matrix-section">
      <div className="summary-heading">
        <h3>任务矩阵</h3>
        <small>{tasks.length} 个任务</small>
      </div>
      <div className="matrix-content">
        <div className="task-matrix">
          {matrixCells(tasks).map(t => (
            <button
              type="button"
              disabled={!onSelectTask || t.count > 1 || t.status === 'mixed'}
              className={`status-${t.status}`}
              title={`${taskDisplayId(t)} · ${t.title || t.name || ''} · ${label(t.status)}`}
              key={t.id}
              onClick={() => onSelectTask?.(t.id)}>
              {t.count > 1 ? `+${t.count}` : ''}
            </button>
          ))}
        </div>
        <div className="matrix-legend">
          {[
            ['done', '完成'],
            ['active', '执行中'],
            ['blocked', '阻塞'],
            ['pending', '未开始'],
          ].map(([status, text]) => (
            <span key={status}>
              <i className={`status-${status}`} />
              {text}
            </span>
          ))}
        </div>
      </div>
      {!tasks.length && <p className="muted">暂无任务</p>}
    </section>
  );
}
