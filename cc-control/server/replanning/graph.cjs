'use strict';

/** task-graph.cjs — 任务依赖图校验与安全变更（纯函数/纯内存，不做 I/O） */

class TaskGraphError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TaskGraphError';
    this.code = code;
    this.details = details;
  }
}

function graphError(code, message, details) {
  return new TaskGraphError(code, message, details);
}

/**
 * 返回图错误；空数组表示合法。
 * 约束：任务 id 唯一、依赖存在、无重复/自依赖、无环。
 */
function taskGraphErrors(tasks) {
  if (!Array.isArray(tasks)) return [{ code: 'TASKS_NOT_ARRAY', message: 'state.tasks must be an array' }];
  const errors = [];
  const byId = new Map();

  for (const [index, task] of tasks.entries()) {
    const id = task?.id;
    if (typeof id !== 'string' || id.length === 0) {
      errors.push({ code: 'TASK_ID_INVALID', message: `task at index ${index} has no valid id`, index });
      continue;
    }
    if (byId.has(id)) errors.push({ code: 'TASK_ID_DUPLICATE', message: `duplicate task id: ${id}`, taskId: id });
    else byId.set(id, task);
  }

  for (const [id, task] of byId) {
    const deps = task.deps == null ? [] : task.deps;
    if (!Array.isArray(deps)) {
      errors.push({ code: 'TASK_DEPS_NOT_ARRAY', message: `task ${id} deps must be an array`, taskId: id });
      continue;
    }
    const seen = new Set();
    for (const depId of deps) {
      if (seen.has(depId)) errors.push({ code: 'TASK_DEP_DUPLICATE', message: `task ${id} has duplicate dependency ${depId}`, taskId: id, depId });
      seen.add(depId);
      if (depId === id) errors.push({ code: 'TASK_SELF_DEP', message: `task ${id} cannot depend on itself`, taskId: id });
      else if (!byId.has(depId)) errors.push({ code: 'TASK_DEP_MISSING', message: `task ${id} depends on missing task ${depId}`, taskId: id, depId });
    }
  }

  // 仅在引用完整时做 DFS；缺失边已单独报错。
  const visiting = new Set();
  const visited = new Set();
  function visit(id, path) {
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      const cycle = [...path.slice(start), id];
      errors.push({ code: 'TASK_DEP_CYCLE', message: `task dependency cycle: ${cycle.join(' -> ')}`, cycle });
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const task = byId.get(id);
    for (const depId of Array.isArray(task?.deps) ? task.deps : []) {
      if (byId.has(depId)) visit(depId, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id, []);

  // 同一个环可能由多入口命中，按 message 去重。
  return errors.filter((error, index) => errors.findIndex((item) => item.message === error.message) === index);
}

function assertTaskGraph(tasks) {
  const errors = taskGraphErrors(tasks);
  if (errors.length) {
    throw graphError('TASK_GRAPH_INVALID', errors.map((item) => item.message).join('; '), { errors });
  }
  return true;
}

function taskById(tasks, id) {
  return tasks.find((task) => task?.id === id);
}

/** 派发/完成边界：目标存在、整图合法，且所有前置任务均已 done。 */
function assertTaskDependenciesDone(tasks, taskId) {
  assertTaskGraph(tasks);
  const task = taskById(tasks, taskId);
  if (!task) throw graphError('TASK_TARGET_MISSING', `task ${taskId} not found`, { taskId });
  const incomplete = (task.deps || []).filter((depId) => taskById(tasks, depId)?.status !== 'done');
  if (incomplete.length) {
    throw graphError(
      'TASK_DEPS_INCOMPLETE',
      `task ${taskId} has incomplete dependencies: ${incomplete.join(', ')}`,
      { taskId, incomplete },
    );
  }
  return true;
}

/**
 * 原子内存变更：创建 prerequisite、插入 target 之前，并把 target 依赖连到 prerequisite。
 * 调用方只有在本函数成功返回后才会拿到新 tasks；失败不修改 state。
 */
function insertPrerequisiteTask(state, { targetId, task, allowedTargetStatuses = ['pending'] } = {}) {
  const tasks = state?.tasks;
  assertTaskGraph(tasks);
  if (!task || typeof task.id !== 'string' || task.id.length === 0) {
    throw graphError('TASK_ID_INVALID', 'prerequisite task requires a non-empty id');
  }
  if (taskById(tasks, task.id)) throw graphError('TASK_ID_DUPLICATE', `task ${task.id} already exists`, { taskId: task.id });
  const targetIndex = tasks.findIndex((item) => item?.id === targetId);
  if (targetIndex < 0) throw graphError('TASK_TARGET_MISSING', `target task ${targetId} not found`, { targetId });
  const currentTarget = tasks[targetIndex];
  if (!allowedTargetStatuses.includes(currentTarget.status)) {
    throw graphError(
      'TASK_TARGET_STATUS',
      `cannot insert prerequisite for ${targetId} while status=${currentTarget.status}; allowed=${allowedTargetStatuses.join('|')}`,
      { targetId, status: currentTarget.status },
    );
  }

  const prerequisite = { ...task, deps: [...(task.deps || [])], status: task.status || 'pending' };
  const target = {
    ...currentTarget,
    exec: currentTarget.exec ? { ...currentTarget.exec } : currentTarget.exec,
    deps: [...new Set([...(currentTarget.deps || []), prerequisite.id])],
  };
  const nextTasks = [...tasks];
  nextTasks.splice(targetIndex, 1, prerequisite, target);
  assertTaskGraph(nextTasks);
  state.tasks = nextTasks;
  return { task: prerequisite, target };
}

/** 安全替换依赖；active 任务不得新增未完成依赖。失败不修改 state。 */
function replaceTaskDependencies(state, taskId, deps) {
  const tasks = state?.tasks;
  assertTaskGraph(tasks);
  if (!Array.isArray(deps)) throw graphError('TASK_DEPS_NOT_ARRAY', `task ${taskId} deps must be an array`);
  const index = tasks.findIndex((task) => task?.id === taskId);
  if (index < 0) throw graphError('TASK_TARGET_MISSING', `task ${taskId} not found`, { taskId });
  const current = tasks[index];
  const oldDeps = new Set(current.deps || []);
  const added = deps.filter((depId) => !oldDeps.has(depId));
  if (current.status === 'active') {
    const incomplete = added.filter((depId) => taskById(tasks, depId)?.status !== 'done');
    if (incomplete.length) {
      throw graphError(
        'ACTIVE_TASK_PREREQUISITE',
        `cannot add incomplete dependencies to active task ${taskId}: ${incomplete.join(', ')}`,
        { taskId, incomplete },
      );
    }
  }
  const nextTasks = [...tasks];
  nextTasks[index] = { ...current, deps: [...deps] };
  assertTaskGraph(nextTasks);
  state.tasks = nextTasks;
  return nextTasks[index];
}

/** 有依赖者时拒绝删除，避免制造悬空边。失败不修改 state。 */
function removeTaskFromGraph(state, taskId) {
  const tasks = state?.tasks;
  assertTaskGraph(tasks);
  const index = tasks.findIndex((task) => task?.id === taskId);
  if (index < 0) throw graphError('TASK_TARGET_MISSING', `task ${taskId} not found`, { taskId });
  const dependents = tasks.filter((task) => (task.deps || []).includes(taskId)).map((task) => task.id);
  if (dependents.length) {
    throw graphError('TASK_HAS_DEPENDENTS', `cannot delete task ${taskId}; depended on by ${dependents.join(', ')}`, { taskId, dependents });
  }
  const nextTasks = tasks.filter((_, taskIndex) => taskIndex !== index);
  assertTaskGraph(nextTasks);
  state.tasks = nextTasks;
  return true;
}

module.exports = {
  TaskGraphError,
  taskGraphErrors,
  assertTaskGraph,
  assertTaskDependenciesDone,
  insertPrerequisiteTask,
  replaceTaskDependencies,
  removeTaskFromGraph,
};
