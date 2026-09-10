// web/src/views/WbsTree.jsx — WBS-Tree 视图（WBS 可交付空间树 + 任务状态标注）。
// T1-090：替代 open tree CLI 渲染；经 server api GET /awf/state（{ wbs, tasks }）驱动，轮询 + WS 刷新。
import { useEffect, useMemo, useState } from 'react';
import { createApiClient } from '../api/client.js';
import { buildWbsTree } from './wbs-tree-model.js';

const GLYPH = { done: '✓', active: '●', blocked: '✕' };

function NodeRow({ node, depth }) {
  const status = node.task?.status || (node.children.length ? 'group' : 'open');
  const glyph = node.task ? (GLYPH[status] || '○') : node.children.length ? '▾' : '·';
  return (
    <>
      <li className={`node ${status}`} style={{ paddingLeft: `${8 + depth * 18}px` }}>
        <span className={`glyph ${status}`}>{glyph}</span>
        <span className="mono">[{node.id}]</span>
        <span className="name">{node.name}</span>
        {node.task && <span className={`chip ${status}`}>{node.task.status}</span>}
      </li>
      {node.children.length > 0 &&
        node.children.map((c) => <NodeRow key={c.id} node={c} depth={depth + 1} />)}
    </>
  );
}

export default function WbsTree({ sid, project } = {}) {
  const client = useMemo(() => createApiClient({ project: project || undefined, sid: sid || undefined }), [sid, project]);
  const [model, setModel] = useState({ roots: [], stats: { total: 0, withTask: 0, byStatus: {} } });

  async function refresh() {
    const st = await client.get('/awf/state').catch(() => null);
    if (st && Array.isArray(st.wbs)) setModel(buildWbsTree({ wbs: st.wbs, tasks: st.tasks || [] }));
  }

  useEffect(() => {
    refresh();
    // T1-091 事件订阅：task/run 推送即刷新（WBS 节点任务状态随事件更新）；心跳兜底
    const timer = setInterval(refresh, 10000);
    const ws = client.stream('/run/events');
    ws.onmessage = (e) => {
      try { if (JSON.parse(e.data)?.type) refresh(); } catch { /* ignore */ }
    };
    return () => { clearInterval(timer); try { ws.close(); } catch { /* ignore */ } };
  }, [client]);

  const { stats } = model;
  const chips = ['done', 'active', 'blocked', 'pending'].filter((k) => stats.byStatus[k]);

  return (
    <main className="wbs-tree">
      <header>
        <h1>WBS Tree</h1>
        <span>{stats.total} 项 · {stats.withTask} 个任务</span>
        {chips.map((k) => (
          <span key={k} className={`chip ${k}`}>{k} {stats.byStatus[k]}</span>
        ))}
      </header>
      {model.roots.length === 0 ? (
        <p className="empty">尚未规划（无 WBS 数据）。请先执行 awf plan。</p>
      ) : (
        <ul className="tree">
          {model.roots.map((r) => <NodeRow key={`${r.id || 'root'}-${r.name}`} node={r} depth={0} />)}
        </ul>
      )}
    </main>
  );
}
