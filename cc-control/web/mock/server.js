import { createProject, PROJECT_ROOTS, SCENARIOS } from './fixtures.js';
const clone = value => JSON.parse(JSON.stringify(value));
const response = (body, status = 200) => ({ status, body: clone(body) });
const fail = (error, status = 409) => response({ ok: false, error }, status);
const now = () => new Date().toISOString();

// Pure, isolated in-memory server. No filesystem access and never forwards requests.
export function createMockServer({ scenario = 'demo' } = {}) {
  scenario = SCENARIOS.includes(scenario) ? scenario : 'demo';
  const projects = new Map(PROJECT_ROOTS.map((root, i) => [root, createProject(root, i, scenario)]));
  const listeners = new Set();
  function emit(project, type, payload = {}, runId = project.runs.at(-1)?.runId) {
    const event = { seq: ++project.seq, runId, type, at: now(), payload };
    project.events.push(event); project.events = project.events.slice(-3000);
    for (const listener of listeners) listener(project.projectRoot, clone(event));
  }
  for (const project of projects.values()) {
    if (!project.runs.length) continue;
    emit(project, 'run.started', { mode: 'batch' });
    for (const task of project.state.tasks.filter(t => t.status === 'done')) emit(project, 'task.done', { taskId: task.id, title: task.title });
    for (const task of project.state.tasks.filter(t => t.status === 'active')) emit(project, 'task.started', { taskId: task.id, title: task.title });
  }
  function counts(project) {
    const tasks = project.state.tasks;
    return { total: tasks.length, done: tasks.filter(t => t.status === 'done').length, active: tasks.filter(t => t.status === 'active').length,
      blocked: tasks.filter(t => t.status === 'blocked').length, pending: tasks.filter(t => t.status === 'pending').length };
  }
  function applyProposal(project, proposal, body) {
    if (!body.reviewer?.trim()) return fail('reviewer must be a non-empty string');
    if (scenario === 'conflict') { proposal.status = 'conflicted'; return null; }
    for (const operation of proposal.operations) {
      if (operation.type === 'insert_task' && !project.state.tasks.some(t => t.id === operation.task.id)) project.state.tasks.push({ ...operation.task, status: 'pending', source: 'dynamic_planning' });
    }
    proposal.status = 'applied'; proposal.approvedBy = body.reviewer; proposal.updatedAt = now();
    emit(project, 'dynamic_planning.applied', { proposalId: proposal.proposalId });
    return null;
  }
  function handle(input, { method = 'GET', body = {} } = {}) {
    const url = new URL(input, 'http://mock.local'), path = url.pathname;
    const projectRoot = url.searchParams.get('p') || PROJECT_ROOTS[0];
    const project = projects.get(projectRoot);
    if (!project) return fail('未知模拟项目', 404);
    if (method !== 'GET' && !url.searchParams.get('p')) return fail('写操作必须指定项目', 400);
    if (scenario === 'error' && path !== '/status') return fail('模拟接口暂时不可用，请切换场景后重试', 503);
    if (method === 'GET') {
      if (path === '/status') return response({ ...project.status, ...(!url.searchParams.get('p') ? { projects: [...projects.values()].map(p => ({ projectRoot: p.projectRoot })) } : {}), ...(url.searchParams.has('snapshot') ? { snapshot: project.snapshot } : {}) });
      if (path === '/awf/state') return response(project.state);
      if (path === '/run/status') {
        const runs = project.runs.map(run => ({ ...run, counts: run.status === 'running' ? counts(project) : run.counts || counts(project) }));
        const id = url.searchParams.get('runId');
        return id ? (runs.some(r => r.runId === id) ? response({ ok: true, run: runs.find(r => r.runId === id) }) : fail('Run 不存在', 404)) : response({ ok: true, runs });
      }
      if (path === '/run/events') {
        const after = Math.max(0, Number(url.searchParams.get('afterSeq')) || 0), limit = Math.max(1, Number(url.searchParams.get('limit')) || 200);
        const id = url.searchParams.get('runId');
        const events = project.events.filter(e => e.seq > after && (!id || e.runId === id)).slice(0, limit);
        return response({ ok: true, events, afterSeq: events.at(-1)?.seq || after, tailSeq: project.seq, trimmed: Math.max(0, (project.events[0]?.seq || 1) - 1) });
      }
      if (path === '/awf/decisions') return response({ ok: true, total: project.decisions.length, decisions: project.decisions });
      if (path === '/awf/dynamic-planning/proposals') {
        const id = url.searchParams.get('proposalId');
        return id ? (project.proposals.some(p => p.proposalId === id) ? response({ ok: true, proposal: project.proposals.find(p => p.proposalId === id) }) : fail('提案不存在', 404)) : response({ ok: true, proposals: project.proposals });
      }
      if (path === '/awf/metrics') return response({ ok: true, metrics: { agentMode: 'multi', activeAgents: project.status.activeAgents, elapsedMs: project.tick * 4000,
        tokens: { total: 45200, input: 31200, output: 14000, coverage: 'partial' }, context: { usedPercentage: 42, totalInputTokens: 84000, contextWindowSize: 200000 } } });
      if (path === '/awf/diagnostics') return response({ ok: true, diagnosis: project.diagnosis });
    }
    if (method === 'POST') {
      if (path === '/run/state/mode') {
        if (!['run', 'pause', 'idle'].includes(body.mode)) return fail('无效工作流模式', 400);
        project.state.mode = body.mode; emit(project, 'run.phase', { mode: body.mode });
        return response({ ok: true, mode: body.mode });
      }
      if (path === '/run/submit') {
        if (project.runs.some(r => ['running','queued'].includes(r.status))) return fail('当前已有正在执行的 Run');
        const run = { runId: body.runId || 'default', status: 'running', mode: body.mode || 'batch', startedAt: now() };
        project.runs = project.runs.filter(r => r.runId !== run.runId); project.runs.push(run); project.state.mode = 'run';
        emit(project, 'run.submitted', { mode: run.mode }); return response({ ok: true, runId: run.runId, mode: run.mode }, 202);
      }
      if (path === '/send' || path === '/respond') {
        const text = path === '/send' ? body.text : body.value;
        if (typeof text !== 'string' || !text.trim()) return fail('请输入非空内容', 400);
        if (path === '/send' && project.status.state === 'busy') return fail('会话繁忙，请稍后重试');
        if (path === '/respond' && !project.status.decisionPending) return fail('当前没有待回复的问题');
        project.snapshot += `\n\n你：${text}\ncc-work：已收到，正在处理。`;
        project.status.state = 'busy'; project.status.decisionPending = null;
        project.replyPending = true;
        return response({ ok: true, sent: text });
      }
      if (path === '/stop') {
        project.status.state = 'ready'; project.status.decisionPending = null; project.replyPending = false;
        project.snapshot += '\n当前响应已打断。';
        return response({ ok: true });
      }
      if (path === '/awf/diagnostics') { project.diagnosis = { status: 'running' }; return response({ ok: true }, 202); }
      const override = path.match(/^\/awf\/decisions\/([^/]+)\/override$/);
      if (override) {
        const id = decodeURIComponent(override[1]);
        if (!body.instruction?.trim()) return fail('override 需要非空 instruction', 400);
        const record = project.decisions.find(d => d.decision_id === id && d.event === 'decision_completed');
        if (!record) return fail('决策记录不存在', 404);
        project.decisions.push({ event: 'decision_overridden', decision_id: id, runStamp: record.runStamp, instruction: body.instruction, at: now() });
        const taskId = `REVIEW-${project.state.tasks.length + 1}`;
        project.state.tasks.push({ id: taskId, title: '按替代决策复核', description: body.instruction, status: 'pending', kind: 'review' });
        emit(project, 'decision.record', { decisionId: id }); return response({ ok: true, decision_id: id, reviewTaskId: taskId });
      }
      const approval = path.match(/^\/run\/dynamic-planning\/proposals\/([^/]+)\/approve$/);
      const resolution = path.match(/^\/awf\/decisions\/([^/]+)\/resolve$/);
      if (approval || resolution) {
        const id = decodeURIComponent((approval || resolution)[1]);
        const proposal = project.proposals.find(p => approval ? p.proposalId === id : p.decision?.decisionId === id);
        if (!proposal) return fail('提案不存在', 404);
        if (approval && proposal.status !== 'awaiting_approval' || resolution && proposal.status !== 'decision_required') return fail('当前提案状态不可审批');
        if (resolution && body.outcome !== 'approve') return fail('此模拟入口仅支持当前 UI 的 approve 操作', 400);
        const error = applyProposal(project, proposal, body); if (error) return error;
        if (resolution) project.decisions.push({ event: 'decision_completed', decision_id: id, runStamp: 'mock-run', status: 'reviewed', subject: { capability: 'dynamic_planning', proposal_id: proposal.proposalId }, result: { answer: proposal.status === 'conflicted' ? '审批已记录，但变更冲突' : '批准并应用提案', type: 'resolved' } });
        return response({ ok: true, proposal });
      }
    }
    return fail(`未定义模拟接口：${method} ${path}`, 404);
  }
  function advance() {
    for (const project of projects.values()) {
      project.tick++;
      if (project.replyPending) { project.status.state = 'ready'; project.replyPending = false; project.snapshot += '\n✓ 本次回复已处理。'; }
      if (project.diagnosis?.status === 'running') project.diagnosis = { status: 'complete', diagnosis: { severity: 'healthy', summary: '模拟运行状态正常', findings: [], dataGaps: ['此结果为模拟数据'] } };
      const run = project.runs.find(r => r.status === 'running');
      if (!run || project.state.mode !== 'run' || scenario === 'error') continue;
      // Events update every tick, tasks progress every third tick so interactions remain reviewable.
      emit(project, 'run.phase', { phase: 'CODE', completed: counts(project).done });
      if (project.tick % 3 === 0) {
        const active = project.state.tasks.find(t => t.status === 'active');
        if (active) { active.status = 'done'; emit(project, 'task.done', { taskId: active.id, title: active.title }); project.snapshot += `\n✓ ${active.id} ${active.title}`; }
        const pending = project.state.tasks.find(t => t.status === 'pending');
        if (pending) { pending.status = 'active'; emit(project, 'task.started', { taskId: pending.id, title: pending.title }); }
        const summary = counts(project);
        project.status.activeAgents = summary.active;
        if (!summary.pending && !summary.active) { run.status = 'done'; run.counts = summary; run.endedAt = now(); project.state.mode = 'idle'; emit(project, 'run.stopped', { status: 'done' }); }
      }
      project.snapshot = project.snapshot.slice(-12000);
    }
  }
  return { handle, advance, scenario, subscribe: callback => { listeners.add(callback); return () => listeners.delete(callback); } };
}
