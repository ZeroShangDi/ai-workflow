import { useMemo, useState } from 'react';
import { API } from '@/shared/api/index.js';
import { createApiClient } from '@/shared/lib/http.js';
import Modal from '@/shared/components/ui/Modal/index.jsx';

const kindName = { plan: 'Plan', run: 'Run' };
const statusName = { created: '待开始', active: '进行中', completed: '已完成', interrupted: '已中断', failed: '失败' };

/** Project-scoped session list and the primary entry point for creating Plan work. */
export default function ProjectSessions({ project, workspace, workspaceError, refreshWorkspace, setView }) {
  const client = useMemo(() => createApiClient({ project }), [project]);
  const [showCreate, setShowCreate] = useState(false);
  const [requestText, setRequestText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const requirements = workspace?.requirements || [];
  const sessions = workspace?.sessions || [];

  async function createPlan(event) {
    event.preventDefault();
    const text = requestText.trim();
    if (!text || busy) return;
    setBusy(true);
    setMessage('');
    try {
      // Server creates the requirement/session and builds the platform Plan prompt.
      const prepared = await client.post(API.preparePlan, {
        requestText: text,
        title: text.slice(0, 64),
        sessionTitle: `Plan · ${text.slice(0, 40)}`,
        launch: true,
      }, { timeoutMs: 130_000 });
      if (prepared?.ok === false) throw new Error(prepared.error || '启动 Plan 会话失败');
      const requirementId = prepared.requirement?.id;
      const sessionId = prepared.workflowSessionId;
      if (!requirementId || !sessionId) throw new Error('Server 返回的 Plan 会话信息不完整');

      if (!prepared.launched) throw new Error('Server 未启动 Plan 对话');
      setRequestText('');
      setShowCreate(false);
      refreshWorkspace?.();
      setView('run', { requirementId, sessionId, runId: '' });
    } catch (reason) {
      setMessage(reason.message || '创建需求失败');
    } finally {
      setBusy(false);
    }
  }

  if (!project) return null;
  return (
    <section className="project-sessions" aria-label="项目会话">
      <div className="project-sessions-head">
        <span>项目会话</span>
        <button type="button" aria-label="新建 Plan 会话" title="新建 Plan 会话" onClick={() => setShowCreate(true)}>＋</button>
      </div>
      {workspaceError && <p role="alert" className="project-sessions-empty">会话加载失败：{workspaceError}</p>}
      {!workspaceError && !workspace && <p role="status" className="project-sessions-empty">正在加载会话…</p>}
      {!workspaceError && workspace && !sessions.length && <p className="project-sessions-empty">暂无会话，点击 ＋ 创建 Plan</p>}
      {requirements.map(requirement => {
        const rows = sessions.filter(session => session.requirementId === requirement.id)
          .sort((left, right) => (left.kind === right.kind ? String(left.createdAt).localeCompare(String(right.createdAt)) : left.kind === 'plan' ? -1 : 1));
        if (!rows.length) return null;
        return (
          <div className="project-session-group" key={requirement.id}>
            <div className="project-session-requirement" title={requirement.title}>{requirement.title || requirement.requestText}</div>
            {rows.map(session => (
              <button
                type="button"
                className={`project-session-item${session.id === new URLSearchParams(window.location.search).get('sessionId') ? ' selected' : ''}`}
                key={session.id}
                title={`${kindName[session.kind] || session.kind} 会话 · ${statusName[session.status] || session.status}`}
                onClick={() => setView('run', {
                  requirementId: requirement.id,
                  sessionId: session.id,
                  runId: '',
                })}>
                <span className={`project-session-kind kind-${session.kind}`}>{kindName[session.kind] || session.kind}</span>
                <span className="project-session-title">会话</span>
                <span className={`project-session-status status-${session.status}`}>{statusName[session.status] || session.status}</span>
              </button>
            ))}
          </div>
        );
      })}
      {message && <p role="alert" className="project-sessions-empty">{message}</p>}
      {showCreate && <Modal title="新建需求 · Plan" width="640px" showClose={false} onClose={() => !busy && setShowCreate(false)}>
        <form onSubmit={createPlan}>
          <label>需求描述<textarea autoFocus aria-label="需求描述" value={requestText} onChange={event => setRequestText(event.target.value)} placeholder="描述目标、边界和验收条件…" /></label>
          <div className="actions"><button type="button" disabled={busy} onClick={() => setShowCreate(false)}>取消</button><button className="primary" disabled={busy || !requestText.trim()}>{busy ? '正在启动…' : '创建需求'}</button></div>
        </form>
      </Modal>}
    </section>
  );
}
