import { useState } from 'react';
import { API } from '../../shared/api/index.js';
import { useAction } from '../../shared/hooks/useAction.js';
import '../../shared/components/business/workflow.css';
export default function ProjectPage({ project, data, client, refresh }) {
  const [text, setText] = useState('');
  const { busy, message, action } = useAction(client, refresh);
  const workspace = data.workspace,
    environment = workspace?.environment;
  const status = environment?.status;
  const labels = { unread: '未读取', reading: '读取中', ready: '已就绪', failed: '读取失败' };
  async function submit(e) {
    e.preventDefault();
    if (await action(API.requirements, { text })) setText('');
  }
  if (!project)
    return (
      <div className="workflow-page">
        <h1>从一个项目开始</h1>
        <p className="muted">添加工作目录后，这里将展示环境检查和需求记录。</p>
      </div>
    );
  return (
    <div className="workflow-page">
      <header>
        <small>{project}</small>
        <h1>项目工作空间</h1>
        <p className="muted">读取环境，补充需求，再进入 Plan 确认执行计划。</p>
      </header>
      <ol className="workflow-steps">
        <li>1 · 加载目录</li>
        <li className={status !== 'ready' ? 'current' : ''}>2 · 读取环境</li>
        <li className={status === 'ready' ? 'current' : ''}>3 · 新增需求</li>
        <li>4 · Plan</li>
        <li>5 · Run</li>
      </ol>
      <section>
        <div className="workflow-row">
          <div>
            <h3>项目环境</h3>
            <span role="status">{labels[status] || '正在加载…'}</span>
          </div>
          <button
            disabled={busy || !environment || status === 'reading'}
            onClick={() => action(API.readEnvironment, {})}>
            {status === 'failed' ? '重试读取' : '读取环境'}
          </button>
        </div>
        {environment?.error && <p role="alert">{environment.error}</p>}
        {status === 'ready' && (
          <>
            <p>
              {environment.runtime} · 分支 {environment.branch}
            </p>
            {environment.files.map(file => (
              <div className="workflow-row" key={file.path}>
                <div>
                  {file.path}
                  <p className="muted">{file.summary}</p>
                </div>
                <span>{file.status === 'read' ? '✓ 已读取' : '未发现'}</span>
              </div>
            ))}
          </>
        )}
      </section>
      <section>
        <h3>新增需求</h3>
        <form onSubmit={submit}>
          <label>
            需求描述
            <textarea
              aria-label="需求描述"
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder="描述你希望实现的功能、边界和验收条件…"
            />
          </label>
          <button className="primary" disabled={busy || !text.trim() || status !== 'ready'}>
            提交需求
          </button>
        </form>
        <p role="status">{message}</p>
      </section>
      <section>
        <h3>需求记录 · {workspace?.requirements?.length || 0}</h3>
        {workspace?.requirements?.length ? (
          workspace.requirements.map(r => (
            <div className="workflow-row" key={r.id}>
              <div>
                <small>
                  {r.id} · {r.status === 'planned' ? '已规划' : '待规划'}
                </small>
                <p>{r.text}</p>
              </div>
            </div>
          ))
        ) : (
          <p className="muted">还没有需求，提交后到 Plan 页面生成计划。</p>
        )}
      </section>
    </div>
  );
}
