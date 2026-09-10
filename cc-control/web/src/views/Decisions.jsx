// web/src/views/Decisions.jsx — Decisions 视图（决策列表 / Review / override）。
// T1-088：经 server api（GET /awf/decisions + POST /awf/decisions/:id/override）+ WS decision.record 更新。
import { useEffect, useMemo, useState } from 'react';
import { createApiClient } from '../api/client.js';
import { toDecisionsModel, decisionSummary } from './decisions-model.js';

export default function Decisions({ sid, project } = {}) {
  const client = useMemo(() => createApiClient({ project: project || undefined, sid: sid || undefined }), [sid, project]);
  const [model, setModel] = useState(toDecisionsModel());
  const [instructions, setInstructions] = useState({}); // id → 输入

  async function refresh() {
    const resp = await client.get('/awf/decisions').catch(() => null);
    if (resp) setModel(toDecisionsModel(resp));
  }

  useEffect(() => {
    refresh();
    // T1-091 事件订阅：decision.*（required/record）推送即刷新；心跳仅兜底
    const timer = setInterval(refresh, 10000);
    const ws = client.stream('/run/events');
    ws.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev?.type && ev.type.startsWith('decision.')) refresh();
      } catch { /* ignore */ }
    };
    return () => { clearInterval(timer); try { ws.close(); } catch { /* ignore */ } };
  }, [client]);

  async function doOverride(id) {
    const instruction = (instructions[id] || '').trim();
    if (!instruction) return;
    const r = await client.post(`/awf/decisions/${encodeURIComponent(id)}/override`, { instruction }).catch(() => null);
    if (r && r.ok) { setInstructions((s) => ({ ...s, [id]: '' })); refresh(); }
  }

  return (
    <main className="decisions">
      <header><h1>决策 Review</h1><span>{model.total} 条</span></header>
      <ul>
        {model.decisions.map((d) => (
          <li key={`${d.runStamp || ''}-${d.id || ''}-${d.at || ''}-${d.override}`}>
            <div className={d.override ? 'muted' : ''}>{decisionSummary(d)}</div>
            <div className="muted">{d.runStamp || ''} {d.at || ''} {d.type || ''}</div>
            {d.override && d.instruction ? <div className="muted">override: {d.instruction}</div> : null}
            {d.overridable && (
              <div className="override-row">
                <input
                  value={instructions[d.id] || ''}
                  onChange={(e) => setInstructions((s) => ({ ...s, [d.id]: e.target.value }))}
                  placeholder="override 指令"
                />
                <button onClick={() => doOverride(d.id)}>override</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
