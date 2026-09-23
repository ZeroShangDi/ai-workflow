import Badge from '@/shared/components/business/StatusBadge/index.jsx';
export default function ExecutionTasks({ active }) {
  return (
    <section className="execution-section">
      <div className="summary-heading">
        <h3>执行任务 · {active.length}</h3>
      </div>
      {active.map(t => (
        <div className="record-card execution-card" key={t.id}>
          <div className="card-meta">
            <small>{t.id}</small>
            <Badge value={t.status} />
          </div>
          <h3>{t.title || t.name || t.id}</h3>
          {t.description && <p>{t.description}</p>}
        </div>
      ))}
      {!active.length && <p className="muted">当前没有执行中的任务</p>}
    </section>
  );
}
