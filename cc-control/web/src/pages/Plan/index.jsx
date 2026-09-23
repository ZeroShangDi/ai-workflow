import { useState } from 'react';
import { API } from '../../shared/api/index.js';
import { useAction } from '../../shared/hooks/useAction.js';
import '../../shared/components/business/workflow.css';
function Draft({ plan, busy, action }) {
  const [summary, setSummary] = useState(plan.summary),
    [tasks, setTasks] = useState(plan.tasks);
  const dirty = summary !== plan.summary || JSON.stringify(tasks) !== JSON.stringify(plan.tasks);
  return (
    <section>
      <label>
        计划摘要
        <textarea
          aria-label="计划摘要"
          value={summary}
          disabled={plan.status !== 'ready'}
          onChange={e => setSummary(e.target.value)}
        />
      </label>
      {tasks.map((task, index) => (
        <label key={task.id}>
          <small>
            {task.id} · 依赖 {(task.deps || []).join('、') || '无'}
          </small>
          <input
            aria-label={`任务标题 ${index + 1}`}
            value={task.title}
            disabled={plan.status !== 'ready'}
            onChange={e =>
              setTasks(old =>
                old.map(t => (t.id === task.id ? { ...t, title: e.target.value } : t)),
              )
            }
          />
          <p className="muted">{(task.acceptance || []).join(' · ')}</p>
        </label>
      ))}
      {plan.status === 'ready' && (
        <div className="actions">
          <button
            disabled={busy || !dirty || !summary.trim() || tasks.some(t => !t.title.trim())}
            onClick={() => action(API.savePlan, { version: plan.version, summary, tasks })}>
            保存计划
          </button>
          <button
            className="primary"
            disabled={busy || dirty}
            onClick={() => action(API.approvePlan, { version: plan.version })}>
            确认计划
          </button>
          {dirty && <small>请先保存修改</small>}
        </div>
      )}
    </section>
  );
}
export default function PlanPage({ data, client, refresh, project, setRunId, runs }) {
  const { busy, message, action } = useAction(client, refresh);
  const plan = data.workspace?.plan,
    requirements = data.workspace?.requirements || [];
  const statuses = {
    empty: '待生成',
    generating: '生成中',
    ready: '待确认',
    approved: '已确认',
    failed: '生成失败',
  };
  async function start() {
    const runId = `web-${Date.now()}`;
    if (await action(API.submitRun, { runId })) setRunId(runId);
  }
  return (
    <div className="workflow-page">
      <header>
        <small>需求 → 任务 → 验收</small>
        <h1>Plan · {statuses[plan?.status] || '暂无计划'}</h1>
        <p className="muted">检查任务拆分与依赖，确认后交给 Run 执行。</p>
      </header>
      {!requirements.length && plan?.status === 'empty' && (
        <section>先到项目页面添加需求。</section>
      )}
      {plan?.status === 'generating' && (
        <section role="status">正在分析需求与已有环境，生成任务和验收标准…</section>
      )}
      {plan?.status === 'failed' && (
        <section role="alert">{plan.error || '规划失败，请重试。'}</section>
      )}
      {plan && ['ready', 'approved'].includes(plan.status) && (
        <Draft
          key={`${project}:${plan.version}:${plan.status}`}
          plan={plan}
          busy={busy}
          action={action}
        />
      )}
      <div className="actions">
        {requirements.length > 0 && plan?.status !== 'generating' && (
          <button
            disabled={busy || runs.some(r => r.status === 'running')}
            onClick={() => action(API.generatePlan, {})}>
            {plan?.status === 'failed'
              ? '重试生成'
              : plan?.status === 'empty'
                ? '生成计划'
                : '重新生成计划'}
          </button>
        )}
        {plan?.status === 'approved' &&
          !runs.some(r => ['running', 'queued'].includes(r.status)) &&
          data.state?.tasks?.some(t => t.status === 'pending') && (
            <button className="primary" disabled={busy} onClick={start}>
              启动 Run
            </button>
          )}
      </div>
      <p role="status">{message}</p>
    </div>
  );
}
