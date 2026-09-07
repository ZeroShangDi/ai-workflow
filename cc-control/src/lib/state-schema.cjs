'use strict';
/**
 * state-schema.cjs — .awf/state.json 字段唯一定义（单源）
 *
 * 统一 state.json 的字段、允许值与版本号，供 store 核心、迁移器(T1-014)、
 * 文档/门禁/前端引用；消除各实现散落的枚举字符串与对"有哪些字段"的猜测。
 * 只做声明与轻量结构校验，不做业务语义判断（那些在各操作/迁移器里）。
 */

/** state schema / 工作流版本（写入 state.json 顶层 version；迁移按此判定） */
const STATE_SCHEMA_VERSION = '0.2.0';

/** 顶层运行模式 */
const MODES = ['idle', 'plan', 'run', 'pause'];

/** 工作流阶段（currentState） */
const PHASES = ['IDLE', 'PLAN', 'DESIGN', 'CODE', 'REVIEW', 'TEST', 'FINISH', 'DEBUG'];

/** 任务状态 */
const TASK_STATUSES = ['pending', 'active', 'done', 'blocked'];

/** 任务类型 */
const TASK_KINDS = ['dev', 'debug', 'review', 'test', 'doc', 'commit', 'ui-design', 'ui-code'];

/** 里程碑状态 */
const MILESTONE_STATUSES = ['active', 'done'];

/** 顶层键 */
const ROOT_FIELDS = ['mode', 'currentState', 'version', 'milestones', 'tasks', 'wbs', 'lastUpdated', 'plan'];

/** plan 段键 */
const PLAN_FIELDS = ['summary', 'reqDoc', 'hasUI', 'inScope', 'outOfScope', 'acceptanceCriteria'];

/** 任务段键（含可选 exec） */
const TASK_FIELDS = ['id', 'title', 'kind', 'prompt', 'wbsRef', 'deps', 'status', 'plannedFiles', 'constraints', 'acceptance', 'exec'];

/** 任务执行记录 exec 段键 */
const EXEC_FIELDS = ['result', 'files', 'commits', 'architecture', 'verdict', 'startedAt', 'completedAt', 'blockedReason'];

/** WBS 段键 */
const WBS_FIELDS = ['id', 'name', 'desc', 'acceptance', 'deps'];

/** 里程碑段键 */
const MILESTONE_FIELDS = ['id', 'desc', 'status', 'tasks'];

/** 字段级轻量定义：type / enum（供校验与文档） */
const FIELD_DEFS = {
  mode: { type: 'string', enum: MODES },
  currentState: { type: 'string', enum: PHASES },
  version: { type: 'string' },
  lastUpdated: { type: 'string' },
  'plan.summary': { type: 'string' },
  'plan.reqDoc': { type: 'string' },
  'plan.hasUI': { type: 'boolean' },
  'plan.inScope': { type: 'array' },
  'plan.outOfScope': { type: 'array' },
  'plan.acceptanceCriteria': { type: 'array' },
  'task.id': { type: 'string' },
  'task.kind': { type: 'string', enum: TASK_KINDS },
  'task.status': { type: 'string', enum: TASK_STATUSES },
  'task.deps': { type: 'array' },
  'task.plannedFiles': { type: 'array' },
  'task.constraints': { type: 'array' },
  'task.acceptance': { type: 'string' },
  'wbs.deps': { type: 'array' },
  'milestone.status': { type: 'string', enum: MILESTONE_STATUSES },
  'milestone.tasks': { type: 'array' },
};

function isOneOf(value, allowed) {
  return typeof value === 'string' && allowed.includes(value);
}

/** 各枚举的便捷判定 */
const isValid = {
  mode: (v) => isOneOf(v, MODES),
  phase: (v) => isOneOf(v, PHASES),
  taskStatus: (v) => isOneOf(v, TASK_STATUSES),
  taskKind: (v) => isOneOf(v, TASK_KINDS),
  milestoneStatus: (v) => isOneOf(v, MILESTONE_STATUSES),
};

/**
 * 轻量结构校验：只查声明过的键/枚举，缺键不报错（历史/局部 state 合法）。
 * @param {object} state
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateStateShape(state) {
  const errors = [];
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { ok: false, errors: ['state 应为对象'] };

  if (!isValid.mode(state.mode)) errors.push(`mode 应为 ${MODES.join('|')} 之一`);
  if (!isValid.phase(state.currentState)) errors.push(`currentState 应为 ${PHASES.join('|')} 之一`);
  for (const [i, t] of (state.tasks || []).entries()) {
    if (t?.id === undefined) errors.push(`tasks[${i}].id 缺失`);
    if (!isValid.taskStatus(t?.status)) errors.push(`tasks[${i}].status 应为 ${TASK_STATUSES.join('|')} 之一`);
    if (!isValid.taskKind(t?.kind)) errors.push(`tasks[${i}].kind 应为 ${TASK_KINDS.join('|')} 之一`);
  }
  for (const [i, m] of (state.milestones || []).entries()) {
    if (!isValid.milestoneStatus(m?.status)) errors.push(`milestones[${i}].status 应为 ${MILESTONE_STATUSES.join('|')} 之一`);
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  STATE_SCHEMA_VERSION,
  MODES,
  PHASES,
  TASK_STATUSES,
  TASK_KINDS,
  MILESTONE_STATUSES,
  ROOT_FIELDS,
  PLAN_FIELDS,
  TASK_FIELDS,
  EXEC_FIELDS,
  WBS_FIELDS,
  MILESTONE_FIELDS,
  FIELD_DEFS,
  isValid,
  validateStateShape,
};
