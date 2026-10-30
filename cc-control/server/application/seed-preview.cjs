'use strict';

/** Seed a disposable SQLite database with readable Web preview records. */
const path = require('node:path');
const fs = require('node:fs');
const { createPersistenceApplication } = require('./persistence.cjs');

const projectRoot = path.resolve(process.argv[2] || process.cwd());
const databaseFilePath = path.resolve(process.argv[3] || path.join(require('node:os').tmpdir(), 'awf-web-preview.sqlite'));
const app = createPersistenceApplication({
  databaseFilePath,
  environmentFilePath: `${databaseFilePath}.environment.json`,
});
const api = require('../persistence/index.cjs');
function value(result) {
  if (result && Object.hasOwn(result, 'ok') && result.ok === false) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result && result.ok === true && Object.hasOwn(result, 'data') ? result.data : result;
}

try {
  const context = app.ensureProject(projectRoot);
  const requirementId = 'preview-requirement-001';
  const already = value(api.requirements.get(requirementId));
  if (already) throw new Error(`Preview data already exists in ${databaseFilePath}; use a fresh preview database.`);
  const { requirement, planSession } = value(api.requirements.createWithPlan({
    requirement: {
      id: requirementId, projectId: context.project.id,
      title: 'SQLite 持久化接入预览',
      requestText: '将项目、需求、Plan/Run 会话、任务、决策和动态任务接入 SQLite，并在 Web 中展示完整主流程。',
      summary: '验证数据库驱动的项目工作区与 AI 工作流主流程。', status: 'planned',
    },
    plan: { id: 'preview-plan-session-001', title: 'Plan · SQLite 持久化接入', status: 'completed', logDir: '.awf/logs/preview-plan-session-001', originEnvironmentId: context.environment.id },
  }));
  value(api.projects.update(context.project.id, { activeRequirementId: requirement.id }));
  const taskRows = [
    { id: 'preview-task-001', taskKey: 'T1', title: '定义持久化实体关系', kind: 'dev', status: 'done', source: 'plan', prompt: '确认项目、需求、工作流会话与任务的关系。', acceptance: ['ID 关系清晰', '跨设备 checkout 独立于 project'], details: { files: ['server/persistence/设计说明.md'], wbsRef: 'W1' }, position: 1 },
    { id: 'preview-task-002', taskKey: 'T2', title: '项目页展示需求和会话', kind: 'dev', status: 'active', source: 'plan', prompt: '从 Server 读取数据库中的项目、需求和会话摘要。', acceptance: ['需求可查看', 'Plan/Run 会话同属一个需求'], details: { files: ['web/src/pages/Project/index.jsx'], wbsRef: 'W2' }, position: 2 },
    { id: 'preview-task-003', taskKey: 'T3', title: '接入决策与动态任务数据', kind: 'dev', status: 'pending', source: 'plan', prompt: '用数据库记录呈现决策、任务关联和动态提案。', acceptance: ['决策可回溯任务', '动态提案可审阅'], details: { files: ['server/web/api'], wbsRef: 'W2' }, position: 3 },
    { id: 'preview-task-004', taskKey: 'T4', title: '处理设备间路径差异', kind: 'analysis', status: 'blocked', source: 'dynamic_planning', prompt: '确认 project id 在不同设备 checkout 间保持稳定。', acceptance: ['项目 ID 稳定', '本地目录按环境区分'], blockedReason: '等待跨设备项目接力方案确认。', details: { files: [], wbsRef: 'W3' }, position: 4 },
  ];
  for (const row of taskRows) value(api.tasks.create({ ...row, acceptance: JSON.stringify(row.acceptance), requirementId: requirement.id }));
  value(api.tasks.setDependencies('preview-task-002', ['preview-task-001']));
  value(api.tasks.setDependencies('preview-task-003', ['preview-task-002']));
  value(api.tasks.setDependencies('preview-task-004', ['preview-task-003']));
  const runSession = value(api.sessions.create({ id: 'preview-run-session-001', requirementId: requirement.id, kind: 'run', status: 'active', title: 'Run · SQLite 持久化接入', logDir: '.awf/logs/preview-run-session-001', originEnvironmentId: context.environment.id }));
  value(api.sessions.startAttempt(runSession.id, { id: 'preview-run-attempt-001', environmentId: context.environment.id, provider: 'preview' }));
  const decision = value(api.decisions.create({ id: 'preview-decision-001', projectId: context.project.id, requirementId: requirement.id, sessionId: runSession.id, decisionType: 'architecture', status: 'open', question: '是否将运行日志正文放进 SQLite？', result: { answer: '日志正文保留为本地文件，SQLite 保存会话、状态和关联。', reason: '运行输出量大，文件更适合流式追加与查阅。' } }));
  value(api.decisions.linkTask(decision.id, 'preview-task-002', 'informs'));
  value(api.decisions.appendEvent(decision.id, { eventType: 'decision_completed', payload: { answer: decision.result.answer }, actorType: 'ai', environmentId: context.environment.id }));
  const proposal = value(api.proposals.create({ id: 'preview-proposal-001', projectId: context.project.id, requirementId: requirement.id, status: 'pending_review', payload: { reason: '建议把会话筛选放在项目会话列表中，减少在 Plan/Run 页面间切换。', changes: { add: ['按会话类型筛选', '查看会话日志'] } } }));
  value(api.proposals.recordEvent(proposal.id, { eventType: 'proposed', status: 'pending_review', payload: { source: 'dynamic_planning' } }));
  for (const [directory, name, lines] of [
    ['preview-plan-session-001', 'plan-preview.log', ['[09:10:02] 收到需求：SQLite 持久化接入预览。', '[09:10:14] Plan 会话关联 4 个任务。', '[09:10:20] 规划完成。']],
    ['preview-run-session-001', 'run-preview.log', ['[09:21:01] Run 会话已启动。', '[09:21:04] T1 定义持久化实体关系：完成。', '[09:21:12] T2 项目页展示需求和会话：执行中。']],
  ]) {
    const target = path.join(projectRoot, '.awf', 'logs', directory);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, name), `${lines.join('\n')}\n`);
  }
  console.log(JSON.stringify({ databaseFilePath, projectId: context.project.id, requirementId: requirement.id, planSessionId: planSession.id, runSessionId: runSession.id, seededTasks: taskRows.length, decisionId: decision.id, proposalId: proposal.id }, null, 2));
} finally {
  app.close();
}
