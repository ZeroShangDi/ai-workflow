// Draft v1 protocol. Every mutation is consumed through HTTP, never through UI fixture access.
export function lifecycle({ project, path, method, body, emit, response, fail }) {
  const p = project;
  const log = (type, payload) => emit(p, type, payload);
  if (method === 'GET' && path === '/workspace') return response({ ok: true, projectRoot: p.projectRoot, environment: p.environment, requirements: p.requirements, plan: p.plan });
  if (method === 'GET' && path === '/conversation') return response({ ok: true, messages: p.messages, source: 'structured' });
  if (method !== 'POST') return;
  if (path === '/workspace/environment/read') {
    if (p.environment.status === 'reading') return fail('正在读取环境');
    p.environment.status = 'reading'; p.environment.error = null; p.environmentTicks = 0;
    log('environment.reading', {}); return response({ ok: true }, 202);
  }
  if (path === '/requirements') {
    if (p.environment.status !== 'ready') return fail('请先读取项目环境');
    if (!body.text?.trim()) return fail('需求不能为空', 400);
    if (p.plan.status === 'generating' || p.runs.some(r => ['running', 'queued'].includes(r.status))) return fail('请等待当前规划或运行结束');
    const requirement = { id: `REQ-${String(p.requirements.length + 1).padStart(3, '0')}`, text: body.text.trim(), status: 'submitted', at: new Date().toISOString() };
    p.requirements.push(requirement); p.plan = { status: 'empty', version: p.plan.version, summary: requirement.text, tasks: [] };
    p.messages.push({ id: `M-REQ-${requirement.id}`, role: 'user', type: 'text', text: requirement.text, at: requirement.at });
    log('requirement.created', { requirementId: requirement.id }); return response({ ok: true, requirement }, 201);
  }
  if (path === '/plan/generate') {
    if (!p.requirements.length) return fail('请先新增需求');
    if (p.plan.status === 'generating') return fail('规划正在生成');
    if (p.runs.some(r => ['running', 'queued'].includes(r.status))) return fail('运行中不能重新规划');
    p.plan = { status: 'generating', version: p.plan.version + 1, summary: p.requirements.at(-1).text, tasks: [] }; p.planTicks = 0;
    log('plan.generating', { version: p.plan.version }); return response({ ok: true, plan: p.plan }, 202);
  }
  if (path === '/plan/save' || path === '/plan/approve') {
    if (p.plan.status !== 'ready') return fail('当前计划不可编辑或确认');
    if (body.version !== p.plan.version) return fail('计划版本已变化，请刷新后重试');
    if (path === '/plan/save') {
      if (!body.summary?.trim() || !Array.isArray(body.tasks) || !body.tasks.length || body.tasks.some(t => !t.id || !t.title?.trim())) return fail('计划摘要和任务标题不能为空', 400);
      const ids = body.tasks.map(t => t.id);
      if (new Set(ids).size !== ids.length || body.tasks.some(t => (t.deps || []).some(id => !ids.includes(id) || id === t.id))) return fail('任务标识或依赖无效', 400);
      const visiting = new Set(), visited = new Set();
      const visit = id => { if (visiting.has(id)) return false; if (visited.has(id)) return true; visiting.add(id); for (const dep of body.tasks.find(t => t.id === id).deps || []) if (!visit(dep)) return false; visiting.delete(id); visited.add(id); return true; };
      if (!ids.every(visit)) return fail('任务依赖存在环', 400);
      p.plan.summary = body.summary.trim(); p.plan.tasks = body.tasks.map(t => ({ ...t, title: t.title.trim(), status: 'pending' })); p.plan.version++;
    } else {
      p.plan.status = 'approved'; p.state.tasks = JSON.parse(JSON.stringify(p.plan.tasks)); p.state.wbs = [{ id: 'W1-001', title: p.plan.summary }]; p.state.mode = 'idle';
      p.requirements.at(-1).status = 'planned';
    }
    log(path === '/plan/save' ? 'plan.updated' : 'plan.approved', { version: p.plan.version }); return response({ ok: true, plan: p.plan });
  }
  const runAction = path.match(/^\/run\/([^/]+)\/(cancel|retry)$/);
  if (runAction) {
    const run = p.runs.find(r => r.runId === decodeURIComponent(runAction[1]));
    if (!run) return fail('Run 不存在', 404);
    if (runAction[2] === 'cancel') {
      if (!['running', 'queued'].includes(run.status)) return fail('当前运行不能取消');
      run.status = 'cancelled'; run.endedAt = new Date().toISOString(); p.state.mode = 'idle'; p.status.activeAgents = 0;
      p.state.tasks.forEach(t => { if (t.status === 'active') t.status = 'pending'; });
      run.counts = taskCounts(p); p.status.decisionPending = null;
      log('run.cancelled', { runId: run.runId }); return response({ ok: true });
    }
    if (!['failed', 'cancelled'].includes(run.status) || p.runs.some(r => ['running', 'queued'].includes(r.status))) return fail('当前运行不能重试');
    run.counts ||= taskCounts(p);
    p.state.tasks.forEach(t => { if (['failed', 'blocked', 'active'].includes(t.status)) t.status = 'pending'; });
    const next = { runId: `${run.runId}-retry-${p.runs.length}`, status: 'running', mode: run.mode, startedAt: new Date().toISOString() };
    p.runs.push(next); p.state.mode = 'run'; log('run.started', { retryOf: run.runId }); return response({ ok: true, runId: next.runId }, 202);
  }
  const taskAction = path.match(/^\/tasks\/([^/]+)\/(retry|unblock)$/);
  if (taskAction) {
    const task = p.state.tasks.find(t => t.id === decodeURIComponent(taskAction[1]));
    if (!task) return fail('任务不存在', 404);
    if (!['failed', 'blocked'].includes(task.status)) return fail('当前任务无需恢复');
    task.status = 'pending'; log('task.requeued', { taskId: task.id }); return response({ ok: true, task });
  }
  const adopt = path.match(/^\/awf\/decisions\/([^/]+)\/adopt$/);
  if (adopt) {
    const id = decodeURIComponent(adopt[1]), record = p.decisions.find(d => d.decision_id === id && d.event === 'decision_completed');
    if (!record) return fail('决策不存在', 404);
    if (record.status !== 'pending_review' || p.decisions.some(d => d.decision_id === id && d.event === 'decision_overridden')) return fail('当前决策不可采纳');
    record.status = 'reviewed'; log('decision.adopted', { decisionId: id }); return response({ ok: true });
  }
  const proposalAction = path.match(/^\/run\/dynamic-planning\/proposals\/([^/]+)\/(retry|review|alternative)$/);
  if (proposalAction) {
    const proposal = p.proposals.find(x => x.proposalId === decodeURIComponent(proposalAction[1]));
    if (!proposal) return fail('提案不存在', 404);
    if (!body.reviewer?.trim()) return fail('请填写复审人', 400);
    const action = proposalAction[2];
    if (action === 'retry') {
      if (!['conflicted', 'failed'].includes(proposal.status)) return fail('当前提案不能重试');
      proposal.status = 'awaiting_approval'; proposal.retryCount = (proposal.retryCount || 0) + 1;
    } else if (action === 'review') {
      if (proposal.status !== 'applied_review_pending') return fail('当前提案无需复审');
      proposal.status = 'applied';
    } else {
      if (!['awaiting_approval', 'decision_required'].includes(proposal.status)) return fail('当前提案不能替代');
      if (!body.instruction?.trim()) return fail('请输入其他决策', 400);
      // The original rejection and replacement task are one atomic mutation.
      proposal.status = 'rejected'; proposal.alternative = body.instruction.trim();
      p.state.tasks.push({ id: `ALT-${proposal.proposalId}`, title: '执行替代方案', description: proposal.alternative, status: 'pending', deps: [], source: 'dynamic_planning' });
      for (const id of proposal.analysis?.affectedTaskIds || []) { const task = p.state.tasks.find(t => t.id === id); if (task) { if (task.status === 'blocked') task.status = 'pending'; task.deps = [...new Set([...(task.deps || []), `ALT-${proposal.proposalId}`])]; } }
      if (p.state.mode === 'pause' && proposal.decision) p.state.mode = 'run';
      if (proposal.decision) p.decisions.push({ event: 'decision_overridden', decision_id: proposal.decision.decisionId, runStamp: proposal.decision.runStamp, instruction: proposal.alternative });
    }
    proposal.reviewedBy = body.reviewer.trim(); proposal.updatedAt = new Date().toISOString();
    log(`dynamic_planning.${action}`, { proposalId: proposal.proposalId }); return response({ ok: true, proposal });
  }
}
export function taskCounts(p) {
  return Object.fromEntries(['total', 'done', 'active', 'blocked', 'pending', 'failed'].map(key => [key, key === 'total' ? p.state.tasks.length : p.state.tasks.filter(t => t.status === key).length]));
}
export function advanceLifecycle(p, emit) {
  if (p.environment.status === 'reading' && (p.environmentTicks = (p.environmentTicks || 0) + 1) >= 2) {
    p.environment.status = p.environmentFailure ? 'failed' : 'ready';
    p.environment.error = p.environmentFailure ? '目录暂时不可读，请重试。' : null; p.environmentFailure = false;
    emit(p, `environment.${p.environment.status}`, {});
  }
  if (p.plan.status === 'generating' && (p.planTicks = (p.planTicks || 0) + 1) >= 2) {
    p.plan.status = 'ready';
    p.plan.tasks = ['确认范围与验收标准', '实现接口与状态流转', '完善页面和交互', '验证异常与恢复', '执行回归并整理产物'].map((title, i) => ({ id: `REQ${p.requirements.length}-T${i + 1}`, title, description: `${p.plan.summary}：${title}`, status: 'pending', kind: i === 4 ? 'test' : 'feature', deps: i ? [`REQ${p.requirements.length}-T${i}`] : [], acceptance: ['操作有结果反馈', '异常可恢复'], wbsRef: 'W1-001' }));
    p.messages.push({ id: `M-PLAN-${p.plan.version}`, role: 'assistant', type: 'task', title: '计划已生成', text: '已拆分为 5 个有依赖顺序的任务，请在 Plan 页确认后启动。', status: 'done', at: new Date().toISOString() });
    emit(p, 'plan.ready', { version: p.plan.version });
  }
}
