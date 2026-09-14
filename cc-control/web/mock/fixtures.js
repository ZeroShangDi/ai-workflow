// Fixtures follow the current server payloads, not fields imagined from the design.
const titles = ['读取项目与运行配置', '梳理任务依赖', '统一状态事件', '日志输出接入', '执行状态同步', '错误状态处理', '校验执行参数', '完善运行进度', '任务列表筛选', '决策列表接入', '复审交互验证', '同步上下文快照', '处理运行收尾', '检查响应式布局', '验证断线恢复', '补齐回归验证', '整理执行产物', '验证完整流程', '清理重复展示', '记录本轮结果', '检查任务边界', '校验事件顺序', '复核错误提示', '完成运行总结'];
export function createProject(projectRoot, index, scenario) {
  const at = new Date().toISOString();
  const tasks = titles.map((title, i) => ({ id: `T-${String(i + 1).padStart(2, '0')}`, title,
    status: i < 7 ? 'done' : i < 10 ? 'active' : 'pending', kind: 'feature',
    description: `实现${title}，复用当前接口并验证结果。`, deps: i >= 7 ? ['T-07'] : [],
    acceptance: ['显示真实状态', '失败时提供明确提示'], wbsRef: 'W1-001',
  }));
  const proposal = (id, status, reason) => ({ proposalId: id, status, reason, createdAt: at,
    operations: [{ type: 'insert_task', task: { id: `D-${id}`, title: reason, kind: 'test', description: '验证本次调整结果' }, relation: { type: 'prerequisite_for', targetTaskId: 'T-11' } }],
    analysis: { affectedTaskIds: ['T-11'], decisionReasons: status === 'decision_required' ? ['改变既定任务结构'] : [] },
  });
  const proposals = [proposal('P-001', 'awaiting_approval', '增加日志恢复验证任务'), proposal('P-002', 'decision_required', '调整关键任务的执行顺序'), proposal('P-003', 'applied_review_pending', '补充界面边界检查')];
  proposals[1].decision = { decisionId: 'D-010', runStamp: 'mock-run' };
  const decisions = [
    { event: 'decision_completed', decision_id: 'D-008', status: 'pending_review', runStamp: 'mock-run', created_at: at,
      result: { real_question: '日志是否继续沿用现有输出方式？', answer: '首版保留原始输出，先完成现有 server 与页面的接入。', decisive_factors: ['现有接口已经提供会话抓屏与编排事件', '结构化会话组件暂缓实现'], risks: ['历史日志查询能力尚未提供'], type: 'resolved', finality: 'provisional' } },
    { event: 'decision_completed', decision_id: 'D-007', status: 'reviewed', runStamp: 'mock-run', created_at: at,
      result: { real_question: '运行中允许补充验证任务吗？', answer: '经审批后加入当前任务计划。', decisive_factors: ['保留人工审批边界'], type: 'resolved' } },
    { event: 'decision_requested', decision_id: 'D-010', status: 'awaiting_human', runStamp: 'mock-run', created_at: at,
      subject: { capability: 'dynamic_planning', proposal_id: 'P-002' }, real_question: '是否批准关键任务的顺序调整？' },
  ];
  const runs = [{ runId: `R-0${26 + index}`, status: 'running', mode: 'batch', startedAt: at }];
  const project = { projectRoot, state: { mode: 'run', version: '0.2.0', tasks, wbs: [{ id: 'W1-001', title: '前端首版接入' }], currentState: 'CODE' },
    status: { ok: true, session: true, state: 'ready', projectRoot, decisionPending: null, activeAgents: 3 },
    runs, decisions, proposals, events: [], seq: 0, tick: 0, diagnosis: null,
    snapshot: 'Claude Code · 当前项目会话\n\n正在接入当前 server 的执行状态。\n✓ 读取项目配置与任务依赖\n✓ 已完成前 7 个任务\n→ 正在处理运行进度、任务筛选和决策记录\n\n等待下一次执行更新…',
  };
  if (scenario === 'empty' || index === 1) {
    project.runs = []; project.events = []; project.decisions = []; project.proposals = [];
    project.state.tasks = []; project.state.wbs = []; project.state.mode = 'idle'; project.status.activeAgents = 0; project.snapshot = '';
  }
  if (scenario === 'idle' && index === 0) { project.runs = []; project.state.mode = 'idle'; project.state.tasks.forEach(task => { task.status = 'pending'; }); project.status.activeAgents = 0; project.snapshot = '模拟项目已就绪，可以启动 Run。'; }
  if (scenario === 'waiting' && index === 0) {
    project.status.decisionPending = { kind: 'choice', question: '验证失败后如何继续？', options: ['检查原因后重试', '保留结果并继续'] };
    project.state.mode = 'pause';
  }
  project.environment = { status: 'ready', files: [
    { path: 'package.json', status: 'read', summary: 'React 18 · Vite 5 · npm' },
    { path: '.awf/state.json', status: 'read', summary: '已有任务与 WBS' },
    { path: 'docs/design/cc-work-design-contract.md', status: 'read', summary: '界面交付约定' },
    { path: '.awf/decisions/', status: 'read', summary: '历史决策记录' },
  ], branch: 'main', runtime: 'Node.js 22', warnings: [] };
  project.requirements = [];
  project.plan = { status: 'approved', version: 1, summary: '前端工作空间完整交互', tasks: JSON.parse(JSON.stringify(project.state.tasks)) };
  project.messages = [
    { id: 'M-1', role: 'user', type: 'text', text: '让前端工作空间可以完整演示需求、规划、运行和复审。', at },
    { id: 'M-2', role: 'assistant', type: 'text', text: '已读取项目约定。我会先确认依赖和验收标准，再逐步执行。', at },
    { id: 'M-3', role: 'tool', type: 'tool', title: '读取项目上下文', text: 'package.json · 状态文件 · 设计交付约定', status: 'done', at },
    { id: 'M-4', role: 'assistant', type: 'task', title: '执行计划', text: '环境 → 状态接口 → 页面交互 → 回归验证', status: 'running', at },
  ];
  const early = ['empty', 'directory', 'environment', 'requirement', 'planning', 'plan-ready', 'plan-error'];
  if (early.includes(scenario) || index === 1) {
    project.runs = []; project.decisions = []; project.proposals = []; project.messages = [];
    project.state.tasks = []; project.state.wbs = []; project.state.mode = 'idle'; project.state.currentState = 'PLAN'; project.status.activeAgents = 0;
    project.snapshot = ''; project.plan = { status: 'empty', version: 0, tasks: [], summary: '' };
    project.environment.status = scenario === 'directory' ? 'reading' : scenario === 'empty' || index === 1 ? 'unread' : 'ready';
    if (['requirement', 'planning', 'plan-ready', 'plan-error'].includes(scenario) && index === 0) {
      project.requirements = [{ id: 'REQ-001', text: '完善项目工作空间：支持需求规划、执行进度、决策审批和日志查询。', status: 'submitted', at }];
      project.plan = { status: scenario === 'planning' ? 'generating' : scenario === 'plan-error' ? 'failed' : scenario === 'plan-ready' ? 'ready' : 'empty', version: 1, summary: project.requirements[0].text,
        tasks: scenario === 'plan-ready' ? tasks.slice(0, 6).map(t => ({ ...t, status: 'pending', deps: [] })) : [], error: scenario === 'plan-error' ? '规划过程被中断，可重试。' : null };
    }
  }
  if (scenario === 'waiting-text' && index === 0) { project.status.decisionPending = { kind: 'text', question: '请补充本轮上线的验收条件。' }; project.state.mode = 'pause'; }
  if (['blocked', 'failed', 'completed', 'cancelled'].includes(scenario) && index === 0) {
    project.state.tasks.forEach((task, i) => { task.status = scenario === 'completed' || i < 7 ? 'done' : i === 7 ? (scenario === 'failed' ? 'failed' : scenario === 'blocked' ? 'blocked' : 'pending') : 'pending'; });
    project.state.mode = scenario === 'blocked' ? 'pause' : 'idle'; project.status.activeAgents = 0;
    project.runs[0].status = scenario === 'completed' ? 'done' : scenario === 'blocked' ? 'running' : scenario;
    if (scenario !== 'blocked') project.runs[0].endedAt = at;
  }
  if (index === 0 && !early.includes(scenario)) {
    for (const [id, status, reason] of [['P-004', 'applied', '已应用：补充输入校验'], ['P-005', 'conflicted', '冲突：目标任务已改变'], ['P-006', 'rejected', '已替代：旧的依赖调整'], ['P-007', 'failed', '失败：变更验证未通过']]) project.proposals.push(proposal(id, status, reason));
    project.decisions.push({ event: 'decision_completed', decision_id: 'D-006', status: 'pending_review', runStamp: 'mock-run', result: { real_question: '执行失败是否立即重试？', answer: '保留错误上下文，人工确认后重试。', risks: ['重复执行可能覆盖产物'], type: 'resolved' } });
    project.decisions.push({ event: 'decision_overridden', decision_id: 'D-006', runStamp: 'mock-run', instruction: '先检查上下文，再启动新的运行。', at });
  }
  if (['empty', 'directory'].includes(scenario) || index === 1) {
    project.environment.files = [{ path: 'package.json', status: 'read', summary: '已识别项目入口' }, { path: '.awf/', status: 'missing', summary: '尚无工作流环境，将从新需求开始' }];
  }
  if (scenario === 'queued' && index === 0) { project.runs[0].status = 'queued'; project.state.tasks.forEach(t => { t.status = 'pending'; }); project.status.activeAgents = 0; }
  if (index === 0 && !early.includes(scenario)) {
    for (const proposal of project.proposals.filter(p => ['applied_review_pending', 'applied'].includes(p.status))) {
      const task = proposal.operations[0].task;
      project.state.tasks.push({ ...task, deps: [], status: scenario === 'completed' ? 'done' : 'pending', source: 'dynamic_planning' });
    }
  }
  return project;
}
export const PROJECT_ROOTS = ['/mock/cc-work', '/mock/interface-lab'];
export const SCENARIOS = ['empty', 'directory', 'environment', 'requirement', 'planning', 'plan-ready', 'plan-error', 'idle', 'queued', 'demo', 'waiting', 'waiting-text', 'blocked', 'failed', 'completed', 'cancelled', 'conflict', 'error'];
