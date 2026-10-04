import { useCallback, useEffect, useMemo, useState } from 'react';
import { API } from '@/shared/api/index.js';
import { createApiClient } from '@/shared/lib/http.js';
import '../work-management.css';
import WorkClaimRecovery from '../WorkClaimRecovery.jsx';
import { previewBugs } from './preview.js';

const labels = { open: '待处理', in_progress: '修复中', pending_acceptance: '待验收', closed: '已关闭', failed: '失败' };
const severityLabels = { critical: '严重', high: '高', medium: '中', low: '低' };
const originLabels = { project_report: '项目登记', run_gate: 'Run 检查', run_observation: 'Run 中发现' };
const closeReasons = ['重复问题', '无法复现', '不予修复', '按设计运行'];
export default function Bugs({ project, requirementId, setProject, setView }) {
  const preview = import.meta.env.DEV && new URLSearchParams(window.location.search).get('workPreview') === '1';
  const client = useMemo(() => createApiClient({ project }), [project]);
  const [items, setItems] = useState([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState('medium');
  const [onlyCurrent, setOnlyCurrent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState(null);
  const [closeTarget, setCloseTarget] = useState(null);
  const [closeReason, setCloseReason] = useState(closeReasons[0]);
  const refresh = useCallback(async () => {
    if (preview) return;
    if (!project) return;
    const result = await client.get(API.bugs);
    if (!result.ok) throw new Error(result.error || '读取 Bug 失败');
    setItems(result.data || []);
  }, [client, preview, project]);
  useEffect(() => {
    if (preview) { setItems(previewBugs); return; }
    const update = () => refresh().catch(e => setError(e.message));
    update();
    const timer = setInterval(update, 10000);
    return () => clearInterval(timer);
  }, [preview, refresh]);

  async function create(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (preview) {
        setItems(old => [{ id: `preview-bug-${Date.now()}`, title: title.trim(), description, severity, origin: 'project_report', lifecycleStatus: 'open', allowAiWork: false, requirementId: null, revision: 1 }, ...old]);
      } else {
        const result = await client.post(API.bugs, { title: title.trim(), description, severity });
        if (!result.ok) throw new Error(result.error || '创建失败');
        await refresh();
      }
      setTitle(''); setDescription(''); setSeverity('medium'); setCreateOpen(false);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function act(row, action, extra = {}) {
    setBusy(true); setError('');
    try {
      if (preview) {
        if (!['edit', 'close', 'reopen'].includes(action)) return false;
        setItems(old => old.map(item => item.id === row.id ? {
          ...item, ...extra,
          ...(action === 'close' ? { lifecycleStatus: 'closed' } : action === 'reopen' ? { lifecycleStatus: 'open' } : {}),
          revision: item.revision + 1,
        } : item));
        return true;
      }
      const result = await client.post(API.bugAction(row.id, action), { expectedRevision: row.revision, ...extra });
      if (!result.ok) throw new Error(result.error || '操作失败');
      await refresh();
      return true;
    } catch (e) { setError(e.message); return false; } finally { setBusy(false); }
  }
  async function start(row) {
    setBusy(true); setError('');
    try {
      const prepared = await client.post(API.prepareBugWorktree(row.id), { owner: 'manual' });
      if (!prepared.ok) throw new Error(prepared.error || '创建工作分支失败');
      const scoped = createApiClient({ project: prepared.data.projectPath });
      const planned = await scoped.post(API.preparePlan, { requirementId: prepared.data.requirementId, launch: true }, { timeoutMs: 90000 });
      if (!planned.ok) throw new Error(`${planned.error || 'Plan 启动失败'}。工作区已保留：${prepared.data.projectPath}`);
      setProject(prepared.data.projectPath, 'run');
      setView('run', { requirementId: prepared.data.requirementId });
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function openReview(row) {
    setError('');
    try {
      const result = await client.get(API.bugReview(row.id));
      if (!result.ok) throw new Error(result.error || '读取验收材料失败');
      setReview({ row, data: result.data });
    } catch (e) { setError(e.message); }
  }
  async function acceptReviewed() {
    if (!review?.data.merged) return;
    if (await act(items.find(item => item.id === review.row.id) || review.row, 'accept', { actor: 'human', branchName: review.data.branchName, headSha: review.data.headSha, targetHeadSha: review.data.targetHeadSha })) setReview(null);
  }
  async function closeBug(event) {
    event.preventDefault();
    if (!closeTarget) return;
    if (await act(closeTarget, 'close', { actor: 'human', reason: closeReason })) setCloseTarget(null);
  }
  const visible = onlyCurrent && requirementId ? items.filter(item => item.requirementId === requirementId) : items;
  return <section className="work-page">
    <header className="work-toolbar"><div className="work-toolbar-actions"><button type="button" className="work-button work-button-primary" onClick={() => setCreateOpen(true)}>创建 Bug</button></div></header>
    {preview && <p className="work-preview-note">示例预览 · 数据只保存在当前页面，刷新即清除</p>}
    {!preview && <WorkClaimRecovery project={project} />}
    {requirementId && <label className="work-filter"><input type="checkbox" checked={onlyCurrent} onChange={event => setOnlyCurrent(event.target.checked)} />仅看当前需求</label>}
    {error && <p className="work-error" role="alert">{error}</p>}
    <div className="bug-list">{visible.map(row => <article key={row.id} className="bug-row">
      <div className="bug-row-heading"><strong>{row.title}</strong><div className="bug-row-badges"><select className={`bug-severity bug-severity-${row.severity}`} aria-label={`调整「${row.title}」的严重程度`} title="调整严重程度" value={row.severity} disabled={busy} onChange={event => act(row, 'edit', { severity: event.target.value })}>{Object.entries(severityLabels).map(([value, label]) => <option key={value} value={value}>严重程度：{label}</option>)}</select><span className={`bug-status bug-status-${row.lifecycleStatus}`}>{labels[row.lifecycleStatus] || row.lifecycleStatus}</span></div></div>
      {row.description && <p className="bug-row-description">{row.description}</p>}
      <div className="bug-row-footer"><div className="bug-row-meta"><span>{row.requirementId ? '需求内 Bug' : '项目级 Bug'}</span><span>来源：{originLabels[row.origin] || row.origin}</span>{!!row.allowAiWork && <span>允许闲时处理</span>}</div><div className="bug-row-actions">
        {!row.requirementId && ['open', 'failed'].includes(row.lifecycleStatus) && <><button className="bug-row-primary" disabled={busy || preview} title={preview ? '示例数据不可执行' : undefined} onClick={() => start(row)}>开始修复</button><button disabled={busy || preview} title={preview ? '示例数据不可执行' : undefined} onClick={() => act(row, 'edit', { allowAiWork: !row.allowAiWork })}>{row.allowAiWork ? '取消闲时处理' : '允许闲时处理'}</button>{row.lifecycleStatus === 'open' && <button disabled={busy} onClick={() => { setCloseReason(closeReasons[0]); setCloseTarget(row); }}>关闭</button>}</>}
        {row.lifecycleStatus === 'pending_acceptance' && <><button className="bug-row-primary" disabled={busy || preview} onClick={() => openReview(row)}>人工审查</button><button disabled={busy || preview} onClick={() => act(row, 'reopen')}>退回</button></>}
        {row.lifecycleStatus === 'closed' && <button disabled={busy} onClick={() => act(row, 'reopen')}>重新打开</button>}
      </div></div>
    </article>)}{!visible.length && <p className="work-empty">暂无 Bug</p>}</div>
    {createOpen && <div className="work-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setCreateOpen(false); }}><form className="work-review work-small-dialog" role="dialog" aria-modal="true" aria-label="创建 Bug" onSubmit={create}>
      <header><h2>创建 Bug</h2><button type="button" onClick={() => setCreateOpen(false)} aria-label="关闭">×</button></header>
      {preview && <p>预览模式下保存只会添加到当前页面。</p>}
      <label htmlFor="bug-title">问题标题</label><input id="bug-title" autoFocus value={title} onChange={event => setTitle(event.target.value)} placeholder="简要描述问题" required />
      <label htmlFor="bug-description">问题描述</label><textarea id="bug-description" value={description} onChange={event => setDescription(event.target.value)} placeholder="复现步骤、实际结果、预期结果" />
      <label htmlFor="bug-severity">严重程度</label><select id="bug-severity" value={severity} onChange={event => setSeverity(event.target.value)}><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="critical">严重</option></select>
      {error && <p className="work-error" role="alert">{error}</p>}
      <div className="work-dialog-actions"><button type="button" onClick={() => setCreateOpen(false)}>取消</button><button className="work-button-primary" disabled={busy || !title.trim()}>{busy ? '创建中…' : '创建 Bug'}</button></div>
    </form></div>}
    {closeTarget && <div className="work-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setCloseTarget(null); }}><form className="work-review work-small-dialog" role="dialog" aria-modal="true" aria-label="关闭 Bug" onSubmit={closeBug}>
      <header><h2>关闭 Bug</h2><button type="button" onClick={() => setCloseTarget(null)} aria-label="关闭">×</button></header>
      <p className="work-dialog-subject">{closeTarget.title}</p>
      <label htmlFor="bug-close-reason">关闭类型</label><select id="bug-close-reason" autoFocus value={closeReason} onChange={event => setCloseReason(event.target.value)}>{closeReasons.map(reason => <option key={reason} value={reason}>{reason}</option>)}</select>
      <p>确认后状态变为“已关闭”；所选类型只记录关闭说明。</p>
      <div className="work-dialog-actions"><button type="button" onClick={() => setCloseTarget(null)}>取消</button><button className="work-button-primary" disabled={busy}>{busy ? '处理中…' : '确认关闭'}</button></div>
    </form></div>}
    {review && <div className="work-modal-backdrop"><section className="work-review" role="dialog" aria-modal="true" aria-label="人工验收 Bug">
      <header><h2>验收 Bug：{review.row.title}</h2><button onClick={() => setReview(null)} aria-label="关闭">×</button></header>
      <p>工作分支：{review.data.branchName} · 合入目标：{review.data.targetBranch}</p>
      <p>待验收提交：<code>{review.data.headSha}</code></p>
      <p><strong>{review.data.merged ? '已合入目标分支' : '尚未合入目标分支'}</strong>。请审查修复差异及复测结果，再确认关闭。</p>
      <pre>{review.data.diff || review.data.summary || '无代码差异'}</pre>
      {review.data.truncated && <p>差异过长，已截取前 300000 字符；请在 Git 中查看完整差异。</p>}
      <div className="work-card-actions"><button onClick={() => openReview(review.row)}>刷新合并状态</button><button disabled={!review.data.merged || busy} onClick={acceptReviewed}>确认验收并关闭</button></div>
    </section></div>}
  </section>;
}
