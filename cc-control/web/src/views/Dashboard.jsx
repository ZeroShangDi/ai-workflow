// web/src/views/Dashboard.jsx — Dashboard 视图（run 总览/任务/阶段/指标/send·respond·stop/启停）。
// T1-087：经 server api（client.get/post）+ WS（client.stream）驱动，纯展示组件。
import { useEffect, useMemo, useState } from 'react';
import { createApiClient } from '../api/client.js';
import { toDashboardModel, phaseLabel } from './dashboard-model.js';

export default function Dashboard({ sid, project } = {}) {
  const client = useMemo(() => createApiClient({ project: project || undefined, sid: sid || undefined }), [sid, project]);
  const [model, setModel] = useState(toDashboardModel());
  const [input, setInput] = useState('');

  async function refresh() {
    const [runStatus, status, metrics] = await Promise.all([
      client.get('/run/status').catch(() => null),
      client.get('/status').catch(() => null),
      client.get('/awf/metrics').catch(() => null),
    ]);
    setModel(toDashboardModel({ runStatus, status, metrics }));
  }

  useEffect(() => {
    refresh();
    // T1-091 事件订阅：run/task 事件推送即刷新（任务结束/决策挂起/启停秒级呈现）；
    // 心跳仅作断线/降级兜底，不再是刷新主通道。
    const timer = setInterval(refresh, 10000);
    const ws = client.stream('/run/events');
    ws.onopen = () => {};
    ws.onmessage = () => { refresh(); };
    return () => { clearInterval(timer); try { ws.close(); } catch { /* ignore */ } };
  }, [client]);

  const phase = phaseLabel(model.currentState || model.currentStage || '');
  const metricEntries = useMemo(() => Object.entries(model.metrics || {}).slice(0, 8), [model.metrics]);

  async function sendNow() {
    if (!input.trim()) return;
    await client.post('/send', { text: input });
    setInput('');
  }
  async function respond(value) {
    await client.post('/respond', { value: String(value) });
  }
  async function stopRun() {
    await client.post('/stop', {});
  }
  async function toggleMode() {
    if (model.mode === 'run' || model.runStatus === 'running') await client.post('/run/state/mode', { mode: 'idle' });
    else await client.post('/run/state/mode', { mode: 'run' });
    refresh();
  }

  return (
    <main className="dashboard">
      <header>
        <h1>AWF Run</h1>
        <span>{model.projectRoot || '—'}</span>
        <span className={model.runStatus}>{model.runStatus}</span>
        <span className="phase">{phase}</span>
        <span className="progress">Task {model.progress}</span>
        <button onClick={toggleMode}>{model.runStatus === 'running' ? '暂停' : '启动'}</button>
      </header>

      <section className="metrics">
        {metricEntries.map(([k, v]) => (
          <div key={k} className="metric"><b>{k}</b><span>{String(v)}</span></div>
        ))}
      </section>

      <section className="runs">
        <h3>Runs</h3>
        {model.runs.map((r) => (
          <div key={r.runId} className="run-row">
            <b>{r.runId}</b> {r.status} {r.counts ? `${r.counts.done}/${r.counts.total}` : ''} {r.currentTaskTitle || ''}
          </div>
        ))}
      </section>

      {model.decisionPending && (
        <section className="decision">
          <b>{model.decisionPending.question}</b>
          {(model.decisionPending.options || []).map((o, i) => (
            <button key={i} onClick={() => respond(i + 1)}>{o}</button>
          ))}
        </section>
      )}

      <footer>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="输入消息 ↵" onKeyDown={(e) => e.key === 'Enter' && sendNow()} />
        <button onClick={sendNow}>发送</button>
        <button onClick={stopRun} className="stop">停止</button>
      </footer>
    </main>
  );
}
