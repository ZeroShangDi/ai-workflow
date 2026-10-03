import Badge from '@/shared/components/business/StatusBadge/index.jsx';
import { taskDisplayId } from '@/shared/lib/task.js';
export default function ExecutionTasks({ active }) {
  return (
    <section className="execution-section">
      <div className="summary-heading">
        <h3>执行任务 · {active.length}</h3>
      </div>
      {active.map(t => (
        <div className="record-card execution-card" key={t.id}>
          <div className="card-meta">
            <small>{taskDisplayId(t)}</small>
            <Badge value={t.status} />
          </div>
          <h3>{t.title || t.name || taskDisplayId(t)}</h3>
          {t.description && <p>{t.description}</p>}
        </div>
      ))}
      {!active.length && <p className="muted">当前没有执行中的任务</p>}
    </section>
  );
}
