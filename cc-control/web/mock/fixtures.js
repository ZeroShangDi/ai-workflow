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
  return project;
}
export const PROJECT_ROOTS = ['/mock/cc-work', '/mock/interface-lab'];
export const SCENARIOS = ['demo', 'idle', 'empty', 'waiting', 'conflict', 'error'];
