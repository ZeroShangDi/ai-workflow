import { useCallback, useEffect, useMemo, useState } from 'react';
import { API } from '@/shared/api/index.js';
import { createApiClient } from '@/shared/lib/http.js';
import '../work-management.css';
import WorkClaimRecovery from '../WorkClaimRecovery.jsx';

const columns = [
  ['draft', '草稿'], ['todo', '待办'], ['in_progress', '执行中'],
  ['pending_acceptance', '待验收'], ['done', '已完成'], ['failed', '失败'], ['cancelled', '已取消'],
];

export default function Requirements({ project, setProject, setView }) {
  const client = useMemo(() => createApiClient({ project }), [project]);
  const [items, setItems] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragged, setDragged] = useState(null);
  const [config, setConfig] = useState(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [configDraft, setConfigDraft] = useState(null);
  const [branches, setBranches] = useState([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState(() => columns.slice(0, 4).map(([status]) => status));
  const [review, setReview] = useState(null);
  const refresh = useCallback(async () => {
    if (!project) return;
    const rows = [];
    let cursor = null;
    do {
      const result = await client.get(`${API.requirements}?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (!result.ok) throw new Error(result.error || '读取需求失败');
      rows.push(...(result.data?.items || []));
      cursor = result.data?.nextCursor;
    } while (cursor);
    setItems(rows.filter(row => row.workKind !== 'bugfix'));
  }, [client, project]);
  useEffect(() => {
    const update = () => refresh().catch(e => setError(e.message));
    update();
    const timer = setInterval(update, 10000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!project) return;
    setConfigLoaded(false);
    client.get(API.workConfig).then(result => { if (result.ok) setConfig(result.data); else setError(result.error || '读取 Git 配置失败'); })
      .catch(e => setError(e.message)).finally(() => setConfigLoaded(true));
  }, [client, project]);

  async function openConfig() {
    setConfigDraft(config || { git: { repositoryRoot: '', targetBranch: '' }, automation: { maxConcurrentTotal: 1 } });
    setBranches([]); setConfigOpen(true); setError('');
  }

  async function chooseRepository() {
    setBusy(true); setError('');
    try {
      const selection = await client.post(API.selectProjectFolder, {}, { timeoutMs: 130000 });
      if (!selection.ok) throw new Error(selection.error || '无法选择目录');
      if (selection.cancelled || !selection.path) return;
      const result = await client.get(API.workConfigBranches(selection.path));
      if (!result.ok) throw new Error(result.error || '无法读取 Git 分支');
      setBranches(result.branches || []);
      setConfigDraft(old => ({ ...old, git: { ...old.git, repositoryRoot: selection.path, targetBranch: '' } }));
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function saveConfig(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await client.post(API.workConfig, configDraft);
      if (!result.ok) throw new Error(result.error || '保存失败');
      setConfig(result.data); setConfigOpen(false);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function create(event) {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true); setError('');
    try {
      const result = await client.post(API.createRequirement, { draft: true, requestText: text });
      if (!result.ok) throw new Error(result.error || '创建失败');
      setText(''); setCreateOpen(false); await refresh();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function act(row, action, extra = {}) {
    setBusy(true); setError('');
    try {
      if (action === 'run') {
        const prepared = await client.post(API.prepareRequirementWorktree(row.id), { owner: 'manual' });
        if (!prepared.ok) throw new Error(prepared.error || '创建独立工作区失败');
        const scoped = createApiClient({ project: prepared.data.projectPath });
        const started = await scoped.post(API.submitRun, { requirementId: row.id });
        if (!started.ok) throw new Error(`${started.error || 'Run 启动失败'}。工作区已保留：${prepared.data.projectPath}`);
        setProject(prepared.data.projectPath, 'run');
        setView('run', { requirementId: row.id });
        return true;
      }
      const endpoint = action === 'plan' ? API.preparePlan : action === 'approve' ? API.approvePlan : API.requirementAction(row.id, action);
      const body = action === 'plan' ? { requirementId: row.id, launch: true }
        : action === 'approve' ? { requirementId: row.id, version: row.revision }
          : { expectedRevision: row.revision, ...extra };
      const result = await client.post(endpoint, body, { timeoutMs: action === 'plan' ? 90000 : 15000 });
      if (!result.ok) throw new Error(result.error || '操作失败');
      await refresh();
      return true;
    } catch (e) { setError(e.message); return false; } finally { setBusy(false); }
  }

  async function openReview(row) {
    setError('');
    try {
      const result = await client.get(API.requirementReview(row.id));
      if (!result.ok) throw new Error(result.error || '读取验收材料失败');
      setReview({ row, data: result.data });
    } catch (e) { setError(e.message); }
  }
  async function acceptReviewed() {
    if (!review?.data.merged) return;
    if (await act(items.find(item => item.id === review.row.id) || review.row, 'accept', { actor: 'human', branchName: review.data.branchName, headSha: review.data.headSha, targetHeadSha: review.data.targetHeadSha })) setReview(null);
  }

  function drop(target) {
    const row = items.find(item => item.id === dragged);
    setDragged(null);
    if (!row) return;
    if (row.lifecycleStatus === 'draft' && target === 'todo') return act(row, 'approve');
    if (row.lifecycleStatus === 'todo' && target === 'in_progress') return act(row, 'run');
    if (row.lifecycleStatus === 'pending_acceptance' && target === 'done') return openReview(row);
  }

  const configured = !!(config?.git?.repositoryRoot && config?.git?.targetBranch);
  return <section className="work-page work-requirements-page">
    <header className="work-toolbar">
      <div className="work-toolbar-actions">
        {configLoaded && !configured && <button type="button" className="work-button" onClick={openConfig}>Git 配置</button>}
        <button type="button" className="work-button work-button-primary" disabled={!configured || !configLoaded} title={!configured ? '请先完成 Git 配置' : undefined} onClick={() => setCreateOpen(true)}>创建需求</button>
        <div className="work-column-picker"><button type="button" className="work-icon-button" aria-label="选择显示的状态列" aria-expanded={columnsOpen} title="选择显示的状态列" onClick={() => setColumnsOpen(open => !open)}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/></svg></button>{columnsOpen && <div className="work-column-menu" role="group" aria-label="显示的状态列">{columns.map(([status, label]) => <label key={status}><input type="checkbox" checked={visibleColumns.includes(status)} onChange={() => setVisibleColumns(current => current.includes(status) ? current.length > 1 ? current.filter(value => value !== status) : current : [...current, status])} /><span>{label}</span></label>)}</div>}</div>
      </div>
    </header>
    {error && <p className="work-error" role="alert">{error}</p>}
    <div className="work-board" style={{ '--visible-columns': visibleColumns.length }} aria-label="需求看板">{columns.filter(([status]) => visibleColumns.includes(status)).map(([status, label]) => <section key={status} className="work-column" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); drop(status); }}>
      <h2>{label}</h2>
      <div className="work-column-cards">{items.filter(item => item.lifecycleStatus === status).sort((a,b) => a.boardPosition - b.boardPosition).map(row => <article key={row.id} className="work-card" draggable={['draft', 'todo', 'pending_acceptance'].includes(status)} onDragStart={() => setDragged(row.id)} onDragEnd={() => setDragged(null)}>
        {!!row.allowAiWork && <div className="work-card-top"><span className="work-card-ai">可闲时处理</span></div>}
        <h3>{row.title}</h3>
        <div className="work-card-footer"><button type="button" onClick={() => setView('run', { requirementId: row.id })}>查看详情 <span aria-hidden="true">↗</span></button><details className="work-card-menu"><summary aria-label="更多操作" title="更多操作">···</summary><div className="work-card-actions">
          {['draft', 'todo'].includes(status) && <button disabled={busy} onClick={() => act(row, 'edit', { allowAiWork: !row.allowAiWork })}>{row.allowAiWork ? '取消闲时授权' : '允许闲时处理'}</button>}
          {status === 'draft' && <><button disabled={busy} onClick={() => act(row, 'plan')}>开始 Plan</button><button disabled={busy || row.status !== 'planned'} title={row.status !== 'planned' ? '请先完成 Plan' : undefined} onClick={() => act(row, 'approve')}>确认 Plan</button></>}
          {['draft', 'todo', 'failed'].includes(status) && <button disabled={busy} onClick={() => act(row, 'cancel')}>取消</button>}
          {status === 'todo' && <button disabled={busy} onClick={() => act(row, 'run')}>立即执行</button>}
          {status === 'in_progress' && <button disabled={busy} onClick={() => act(row, 'run')}>继续执行</button>}
          {status === 'pending_acceptance' && <><button disabled={busy} onClick={() => openReview(row)}>审查并验收</button><button disabled={busy} onClick={() => act(row, 'reject')}>退回</button></>}
          {status === 'failed' && <button disabled={busy} onClick={() => act(row, 'retry')}>重新待办</button>}
        </div></details></div>
      </article>)}</div>
    </section>)}</div>
    <div className="work-claims-floating"><WorkClaimRecovery project={project} /></div>
    {createOpen && <div className="work-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setCreateOpen(false); }}><form className="work-review work-small-dialog" role="dialog" aria-modal="true" aria-label="创建需求" onSubmit={create}>
      <header><h2>创建需求</h2><button type="button" onClick={() => setCreateOpen(false)} aria-label="关闭">×</button></header>
      <p>先记录想法，完成 Plan 后可进入待办。</p>
      <label htmlFor="requirement-draft">需求内容</label><textarea id="requirement-draft" autoFocus value={text} onChange={event => setText(event.target.value)} placeholder="描述你想完成的事…" />
      <div className="work-dialog-actions"><button type="button" onClick={() => setCreateOpen(false)}>取消</button><button className="work-button-primary" disabled={busy || !text.trim()}>保存草稿</button></div>
    </form></div>}
    {configOpen && <div className="work-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setConfigOpen(false); }}><form className="work-review work-small-dialog" role="dialog" aria-modal="true" aria-label="Git 配置" onSubmit={saveConfig}>
      <header><h2>Git 配置</h2><button type="button" onClick={() => setConfigOpen(false)} aria-label="关闭">×</button></header>
      <p>选择项目所在的 Git 仓库，以及人工验收后合入的目标分支。</p>
      <label>仓库根目录</label><button className="work-directory-picker" type="button" disabled={busy} onClick={chooseRepository}>{configDraft?.git?.repositoryRoot || '选择 Git 仓库目录…'}</button>
      <label htmlFor="work-target-branch">合入目标分支</label><select id="work-target-branch" value={configDraft?.git?.targetBranch || ''} disabled={!branches.length || busy} onChange={event => setConfigDraft(old => ({ ...old, git: { ...old.git, targetBranch: event.target.value } }))}><option value="">选择本地分支…</option>{branches.map(branch => <option key={branch} value={branch}>{branch}</option>)}</select>
      {error && <p className="work-error" role="alert">{error}</p>}
      <div className="work-dialog-actions"><button type="button" onClick={() => setConfigOpen(false)}>取消</button><button className="work-button-primary" disabled={busy || !configDraft?.git?.repositoryRoot || !configDraft?.git?.targetBranch}>保存配置</button></div>
    </form></div>}
    {review && <div className="work-modal-backdrop"><section className="work-review" role="dialog" aria-modal="true" aria-label="人工验收需求">
      <header><h2>验收：{review.row.title}</h2><button onClick={() => setReview(null)} aria-label="关闭">×</button></header>
      <p>工作分支：{review.data.branchName} · 合入目标：{review.data.targetBranch}</p>
      <p>待验收提交：<code>{review.data.headSha}</code></p>
      <p><strong>{review.data.merged ? '已合入目标分支' : '尚未合入目标分支'}</strong>。请检查代码差异、任务结果，并在 Git 中完成合并后刷新。</p>
      <div className="work-review-tasks">{review.data.tasks.map(task => <span key={task.id}>{task.status === 'done' ? '✓' : '○'} {task.title}</span>)}</div>
      <pre>{review.data.diff || review.data.summary || '无代码差异'}</pre>
      {review.data.truncated && <p>差异过长，已截取前 300000 字符；请在 Git 中查看完整差异。</p>}
      <div className="work-card-actions"><button onClick={() => openReview(review.row)}>刷新合并状态</button><button disabled={!review.data.merged || busy || review.data.tasks.some(task => task.status !== 'done')} onClick={acceptReviewed}>确认验收</button></div>
    </section></div>}
  </section>;
}
