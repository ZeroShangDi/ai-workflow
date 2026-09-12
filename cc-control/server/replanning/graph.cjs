'use strict';
/**
 * task-graph.cjs — 任务依赖图校验与安全变更（纯函数/纯内存，不做 I/O）
 *
 * ## 图不变量（taskGraphErrors 逐条落实）
 *   1. 每个任务有非空字符串 id；id 在整图唯一；
 *   2. deps 是数组（缺省视作空数组），元素唯一（无重复边）；
 *   3. 每个 dep 都指向图中真实存在的任务（无悬空边）；
 *   4. 任务不依赖自己（无自环）；
 *   5. 依赖关系无环（DFS 检测）。
 *
 * ## 为什么所有变更都先 assertTaskGraph 再写
 * 本模块的每个变更函数都遵循「先校验 → 内存组装新数组 → 再校验 → 才写回 state」的模式。
 * 任一步抛错都在写回之前中止，因此**失败不修改 state**（调用方拿到异常时 state 原样）。
 * 最后一次 assert 是关键：单步变更本身合法，但叠加后可能破坏全局不变量（如成环）。
 *
 * ## 边界
 * 只做图结构层面的事，不理解业务语义（任务该不该做、优先级）：那是 planner.cjs 的职责。
 */

class TaskGraphError extends Error {
  /**
   * @param {string} code - 机器可判别的错误码（TASK_DEP_CYCLE 等）
   * @param {string} message - 人类可读描述
   * @param {object} [details] - 附加上下文（taskId/cycle/errors 等）
   */
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
 * 返回图错误列表；空数组表示合法。
 * 约束：任务 id 唯一、依赖存在、无重复/自依赖、无环。
 *
 * 分两趟：先建 byId 索引并查 id 合法性/重复，再逐任务查 deps 的重复/自依赖/悬空，
 * 最后对引用完整的边跑 DFS 找环。缺失边已单独报错，故 DFS 只在 byId.has(depId) 时才深入，
 * 避免顺着悬空边崩。
 * @param {Array} tasks
 * @returns {Array<{code: string, message: string, [k: string]: any}>}
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
    // 重复 id 时保留先出现者入索引（byId 只记首个），后续查边以首个为准。
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
  // 三色标记：visiting=当前 DFS 栈上（命中即环），visited=已确认无环。命中 visiting 时从 path
  // 截出真正的环再做环内路径回显。
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
  // 对每个 id 都起一次 DFS，保证不连通的分量也被覆盖。
  for (const id of byId.keys()) visit(id, []);

  // 同一个环可能由多入口命中，按 message 去重。
  return errors.filter((error, index) => errors.findIndex((item) => item.message === error.message) === index);
}

/** 校验通过返回 true，否则抛 TASK_GRAPH_INVALID（details.errors 带全部错误明细） */
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
// 用途：调度前确认某任务真的可执行。前置「未 done」都算不完整（pending/active/blocked 皆拦）。
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
 *
 * 语义：prerequisite 成为 target 的新前置——target.deps 追加 prerequisite.id，deps 用 Set 去重
 * （target 原本可能已依赖同名 id 的旧值不会重复）。prerequisite 插进 tasks 数组紧邻 target 之前，
 * 保持「前置紧挨目标」的可读顺序。deps 做浅拷贝以免与原对象共享引用。
 * @param {object} state - 含 tasks 的 state（就地修改 state.tasks）
 * @param {{ targetId: string, task: object, allowedTargetStatuses?: string[] }} opts
 *   allowedTargetStatuses 缺省 ['pending']：只有未开工的目标才允许被插入前置。
 * @returns {{ task: object, target: object }} 新建的 prerequisite 与改写后的 target
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

  // 拷出 prerequisite 与 target 的新副本，绝不复用旧引用（旧对象可能仍被 before/after 快照持有）。
  const prerequisite = { ...task, deps: [...(task.deps || [])], status: task.status || 'pending' };
  const target = {
    ...currentTarget,
    exec: currentTarget.exec ? { ...currentTarget.exec } : currentTarget.exec,
    deps: [...new Set([...(currentTarget.deps || []), prerequisite.id])],
  };
  const nextTasks = [...tasks];
  nextTasks.splice(targetIndex, 1, prerequisite, target);
  // 二次全局校验：新插入的边可能引入环或不一致，只有通过才允许写回。
  assertTaskGraph(nextTasks);
  state.tasks = nextTasks;
  return { task: prerequisite, target };
}

/** 安全替换依赖；active 任务不得新增未完成依赖。失败不修改 state。 */
// 「active 不得新增未完成依赖」的原因：active 表示任务已开工并基于当时的依赖集合推进；
// 中途新增一个尚未 done 的前置，会造成「任务在跑、它的前置还没做完」的因果倒置，
// 故只允许新增已 done 的依赖，其余一律拒绝。
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
// 删除前先查「谁依赖我」：只要还有别的任务依赖 taskId，删掉它就会留下指向不存在任务的边，
// 破坏图不变量，故一律拒绝（调用方需先自行迁移/重连依赖）。
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
