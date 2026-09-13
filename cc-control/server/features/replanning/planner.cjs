'use strict';
/**
 * planner.cjs — 局部动态规划：把一组语义化任务调整展开成完整、可校验的 state 变更与副作用报告。
 *
 * ## 核心概念
 *   - **直接受影响**（directlyAffectedTaskIds）：操作本身碰到的任务（新增者、被编辑者、被删者、
 *     以及因重连依赖而改动的下游）。
 *   - **影响闭包**（affectedTaskIds）：直接受影响任务的**下游传递闭包**——即「上游一变，它就可能
 *     需要重做/重审」的全部任务。这个闭包是后续 hold（挡调度）与批准判据（scopeFingerprint）的
 *     对象，决定了「谁会被这次变更波及」。
 *   - **历史不可改写**（assertHistoryPreserved）：active/done 的任务是既成事实，动态规划一律不得
 *     改动它们——否则会把已发生的工作抹掉。这是本模块最硬的护栏。
 *
 * ## 为什么用「克隆 + 重放」而不是原地改
 * planAdjustment 在 clone 出来的 nextState 上做全部变更，原 state 与 before 快照都不动。
 * 未被接受的变更自然消失，被接受的则整份写回；配合上层 service.cjs 的「锁内对最新 state 重放」，
 * 保证运行期并行任务的前进不被旧快照回退。
 *
 * ## 边界
 * 本模块只产出「变更后的状态 + 分析报告」，不做 I/O、不落盘、不判断是否需人工批准
 * （requiresDecision 只是把理由汇出来，决策由 service.cjs 编排）。
 */
const taskGraph = require('../../shared/task-graph.cjs');
const { peekReadyTasks } = require('../../shared/ready-tasks.cjs'); // 就绪判据单源

/** 编辑允许触碰的字段白名单；未列入者（status/exec 等）一律拒绝，防止绕过状态机改历史 */
const EDITABLE_FIELDS = new Set([
  'title', 'kind', 'prompt', 'wbsRef', 'deps', 'plannedFiles', 'constraints', 'acceptance',
]);

/** 深拷贝（JSON 往返）：保证 nextState/before 与入参对象完全隔离，避免共享引用被就地改写 */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function taskMap(tasks) {
  return new Map((tasks || []).map((task) => [task.id, task]));
}

/**
 * 就绪任务 id（供 readyBefore/readyAfter 报告）。
 * 判据**不在这里** —— 就绪 = pending + 未 hold + deps 全 done，单源在 shared/ready-tasks.cjs
 * （state.js 的 peekReadyTasks、调度器、本报告共用同一份）。此处只做「取 id」的投影，
 * 避免报告里的 readyAfter 与调度器真去派的任务各算各的。
 */
const readyTaskIds = (state) => peekReadyTasks(state).map((task) => task.id);

function downstreamTaskIds(tasks, seedIds) {
  const found = new Set(seedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (found.has(task.id)) continue;
      if ((task.deps || []).some((depId) => found.has(depId))) {
        found.add(task.id);
        changed = true;
      }
    }
  }
  return [...found];
}

/**
 * 取「下游中已 active/done」的任务（不含 taskId 自身）。
 * 这批任务是「一动就会破坏历史」的集合：插入前置、编辑、删除若会波及它们，必须拒绝。
 */
function immutableDownstreamTasks(tasks, taskId) {
  const byId = taskMap(tasks);
  return downstreamTaskIds(tasks, [taskId])
    .filter((id) => id !== taskId)
    .map((id) => byId.get(id))
    .filter((task) => task && ['active', 'done'].includes(task.status));
}

/** 字段必填校验：非空字符串，否则抛错（错误信息带字段名便于定位哪个 operation 出的问题） */
function assertNonEmpty(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`);
}

/**
 * 把新增任务同步进 milestone 的任务列表：紧挨 targetId 之前插入，保持里程碑内的顺序语义。
 * 幂等：若该 milestone 已含 insertedId 则跳过，避免重复插入。
 */
function insertIntoMilestones(state, targetId, insertedId, sideEffects) {
  for (const milestone of state.milestones || []) {
    if (!Array.isArray(milestone.tasks)) continue;
    const index = milestone.tasks.indexOf(targetId);
    if (index < 0 || milestone.tasks.includes(insertedId)) continue;
    milestone.tasks.splice(index, 0, insertedId);
    sideEffects.push({ type: 'milestone_task_inserted', milestoneId: milestone.id, taskId: insertedId, before: targetId });
  }
}

/** 从所有 milestone 中移除某任务，并逐个记 sideEffect（删除任务时必须同步，否则里程碑留有幽灵引用） */
function removeFromMilestones(state, taskId, sideEffects) {
  for (const milestone of state.milestones || []) {
    if (!Array.isArray(milestone.tasks) || !milestone.tasks.includes(taskId)) continue;
    milestone.tasks = milestone.tasks.filter((id) => id !== taskId);
    sideEffects.push({ type: 'milestone_task_removed', milestoneId: milestone.id, taskId });
  }
}

/**
 * 归一化 insert_task 的新任务：四个必填字段校验后补默认值。
 * 缺省继承 target 的 wbsRef/deps（新前置与目标同属一个工作分解/依赖基线），
 * status 强制 pending（新任务永远是待办），source 标 dynamic_planning 以便追溯来源。
 */
function normalizeInsertedTask(raw, target) {
  assertNonEmpty(raw?.id, 'insert task.id');
  assertNonEmpty(raw?.title, 'insert task.title');
  assertNonEmpty(raw?.prompt, 'insert task.prompt');
  assertNonEmpty(raw?.acceptance, 'insert task.acceptance');
  return {
    id: raw.id,
    title: raw.title,
    kind: raw.kind || 'dev',
    prompt: raw.prompt,
    wbsRef: raw.wbsRef === undefined ? target.wbsRef : raw.wbsRef,
    deps: Array.isArray(raw.deps) ? [...raw.deps] : [...(target.deps || [])],
    status: 'pending',
    plannedFiles: Array.isArray(raw.plannedFiles) ? [...raw.plannedFiles] : [],
    constraints: Array.isArray(raw.constraints) ? [...raw.constraints] : [],
    acceptance: raw.acceptance,
    source: 'dynamic_planning',
  };
}

/**
 * applyInsert：插入前置任务（relation.type 必须 prerequisite_for）。
 * 护栏：若 target 已有 active/done 的下游，插入会连带这些历史任务失效 → 拒绝。
 * 副作用：target 若为 blocked，插入前置后重开为 pending（前置给了它新的可执行路径）。
 */
function applyInsert(state, operation, analysis) {
  const relation = operation.relation;
  if (relation?.type !== 'prerequisite_for') {
    throw new Error('insert_task relation.type must be prerequisite_for');
  }
  assertNonEmpty(relation.targetTaskId, 'insert_task relation.targetTaskId');
  const target = (state.tasks || []).find((task) => task.id === relation.targetTaskId);
  if (!target) throw new Error(`target task ${relation.targetTaskId} not found`);
  const historical = immutableDownstreamTasks(state.tasks, target.id);
  if (historical.length) {
    throw new Error(`cannot insert before ${target.id}; active/done downstream tasks would be invalidated: ${historical.map((task) => task.id).join(', ')}`);
  }

  const inserted = normalizeInsertedTask(operation.task, target);
  // 允许目标为 pending 或 blocked：blocked 目标本就卡住，插前置再重开是合理场景。
  const result = taskGraph.insertPrerequisiteTask(state, {
    targetId: target.id,
    task: inserted,
    allowedTargetStatuses: ['pending', 'blocked'],
  });
  if (result.target.status === 'blocked') {
    result.target.status = 'pending';
    // 重开时清掉上次执行的起止时间戳（exec 残留会让 UI/统计误以为还在跑）。
    if (result.target.exec) {
      delete result.target.exec.startedAt;
      delete result.target.exec.completedAt;
    }
    analysis.sideEffects.push({ type: 'task_reopened', taskId: result.target.id, from: 'blocked', to: 'pending' });
  }
  insertIntoMilestones(state, target.id, inserted.id, analysis.sideEffects);
  analysis.insertedTaskIds.push(inserted.id);
  analysis.directlyAffectedTaskIds.push(inserted.id, target.id);
  analysis.sideEffects.push({ type: 'dependency_added', taskId: target.id, dependencyId: inserted.id });
}

/**
 * applyEdit：编辑任务字段（仅 pending/blocked）。
 * 护栏：目标已有 active/done 下游 → 拒绝（改动会污染历史）。
 * 关键：变更目标承载字段（kind/wbsRef/acceptance/prompt）或移除依赖/文件/约束，都会推高
 * decisionReasons —— 这些是可能改变任务含义的「高风险编辑」，触发上层走人工决策。
 */
function applyEdit(state, operation, analysis) {
  assertNonEmpty(operation.taskId, 'edit_task taskId');
  const task = (state.tasks || []).find((item) => item.id === operation.taskId);
  if (!task) throw new Error(`task ${operation.taskId} not found`);
  if (!['pending', 'blocked'].includes(task.status)) {
    throw new Error(`cannot edit task ${task.id} while status=${task.status}`);
  }
  const historical = immutableDownstreamTasks(state.tasks, task.id);
  if (historical.length) {
    throw new Error(`cannot edit ${task.id}; active/done downstream tasks would be invalidated: ${historical.map((item) => item.id).join(', ')}`);
  }
  const patch = operation.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('edit_task patch must be an object');
  // 空 patch 且不重开 = 无意义操作，直接拒绝（避免产生空变更的 proposal）。
  if (Object.keys(patch).length === 0 && operation.reopen !== true) throw new Error('edit_task patch cannot be empty');
  const unknown = Object.keys(patch).filter((field) => !EDITABLE_FIELDS.has(field));
  if (unknown.length) throw new Error(`edit_task unsupported fields: ${unknown.join(', ')}`);

  // previous 留一份编辑前快照，用于后面比较「移除了什么」（依赖/文件/约束）。
  const previous = clone(task);
  const oldDeps = [...(previous.deps || [])];
  for (const [field, value] of Object.entries(patch)) {
    if (field === 'deps') continue;
    task[field] = clone(value);
  }
  // deps 单独走图校验（replaceTaskDependencies 会查环/自依赖/悬空边，并拦 active 新增未完成依赖）。
  if (patch.deps !== undefined) taskGraph.replaceTaskDependencies(state, task.id, patch.deps);
  if (operation.reopen === true && task.status === 'blocked') {
    const current = state.tasks.find((item) => item.id === task.id);
    current.status = 'pending';
    if (current.exec) {
      delete current.exec.startedAt;
      delete current.exec.completedAt;
    }
    analysis.sideEffects.push({ type: 'task_reopened', taskId: task.id, from: 'blocked', to: 'pending' });
  }

  // 移除依赖、改目标承载字段、删文件/约束——都算高风险，逐条汇进 decisionReasons。
  const removedDeps = oldDeps.filter((id) => !(patch.deps || oldDeps).includes(id));
  if (removedDeps.length) analysis.decisionReasons.push(`edit ${task.id} removes dependencies: ${removedDeps.join(', ')}`);
  for (const field of ['kind', 'wbsRef', 'acceptance', 'prompt']) {
    if (patch[field] !== undefined) analysis.decisionReasons.push(`edit ${task.id} changes goal-bearing field: ${field}`);
  }
  for (const field of ['plannedFiles', 'constraints']) {
    if (!Array.isArray(patch[field])) continue;
    const removed = (Array.isArray(previous[field]) ? previous[field] : [])
      .filter((value) => !patch[field].includes(value));
    if (removed.length) analysis.decisionReasons.push(`edit ${task.id} removes ${field}: ${removed.join(', ')}`);
  }
  analysis.editedTaskIds.push(task.id);
  analysis.directlyAffectedTaskIds.push(task.id);
}

/**
 * applyDelete：删除任务（仅 pending/blocked）。
 * 护栏：目标有 active/done 下游 → 拒绝。
 * 删除前把每个依赖它的任务「重连」——把被删任务的 deps 平铺进依赖者，顶替掉对被删任务的引用，
 * 从而不留悬空边（这是 removeTaskFromGraph 会拒绝删除的图约束，这里先替它铺好路）。
 */
function applyDelete(state, operation, analysis) {
  assertNonEmpty(operation.taskId, 'delete_task taskId');
  const target = (state.tasks || []).find((task) => task.id === operation.taskId);
  if (!target) throw new Error(`task ${operation.taskId} not found`);
  if (!['pending', 'blocked'].includes(target.status)) {
    throw new Error(`cannot delete task ${target.id} while status=${target.status}`);
  }
  const dependents = (state.tasks || []).filter((task) => (task.deps || []).includes(target.id));
  const immutable = immutableDownstreamTasks(state.tasks, target.id);
  if (immutable.length) {
    throw new Error(`cannot delete ${target.id}; active/done dependents would be rewritten: ${immutable.map((task) => task.id).join(', ')}`);
  }

  for (const dependent of dependents) {
    // 依赖重连：把对 target 的引用替换成 target 自己的 deps（保持原有的因果链不丢）。
    const nextDeps = [];
    for (const depId of dependent.deps || []) {
      if (depId === target.id) nextDeps.push(...(target.deps || []));
      else nextDeps.push(depId);
    }
    // Set 去重：可能出现「平铺后与新依赖重复」或「与既有依赖重复」的边。
    taskGraph.replaceTaskDependencies(state, dependent.id, [...new Set(nextDeps)]);
    analysis.sideEffects.push({
      type: 'dependency_reconnected',
      taskId: dependent.id,
      removedDependencyId: target.id,
      addedDependencyIds: [...(target.deps || [])],
    });
    analysis.directlyAffectedTaskIds.push(dependent.id);
  }
  removeFromMilestones(state, target.id, analysis.sideEffects);
  taskGraph.removeTaskFromGraph(state, target.id);
  analysis.deletedTaskIds.push(target.id);
  analysis.directlyAffectedTaskIds.push(target.id);
  analysis.decisionReasons.push(`delete planned task ${target.id}`);
}

/**
 * 硬护栏：before 中每个 active/done 任务，在 after 中必须原样存在（含全部字段）。
 * 用整对象 JSON 比较，任何字段被改动都算违规——动态规划不得篡改既成事实。
 */
function assertHistoryPreserved(before, after) {
  const afterById = taskMap(after.tasks);
  for (const task of before.tasks || []) {
    if (!['active', 'done'].includes(task.status)) continue;
    const current = afterById.get(task.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(task)) {
      throw new Error(`dynamic planning cannot rewrite ${task.status} task ${task.id}`);
    }
  }
}

/**
 * 局部规划主入口：对 currentState 施加 request.operations，产出 { nextState, analysis }。
 *
 * 流程：
 *   1. 参数与整图合法性校验；
 *   2. 存 before 快照、clone 出 nextState，逐个 operation 在 nextState 上执行（applyInsert/Edit/Delete）；
 *   3. 收尾三校验：图仍合法、历史（active/done）未被改写；
 *   4. 汇总分析：影响闭包、就绪面变化、是否需决策及其理由、不变量快照。
 *
 * 全程不修改传入的 currentState（只在 clone 上动手），失败即抛错、留不下半成品。
 * @param {object} currentState
 * @param {{ reason: string, operations: object[] }} request
 * @returns {{ nextState: object, analysis: object }}
 */
function planAdjustment(currentState, request) {
  assertNonEmpty(request?.reason, 'reason');
  if (!Array.isArray(request.operations) || request.operations.length === 0) {
    throw new Error('operations must be a non-empty array');
  }
  taskGraph.assertTaskGraph(currentState?.tasks || []);

  const before = clone(currentState);
  const nextState = clone(currentState);
  const analysis = {
    insertedTaskIds: [],
    editedTaskIds: [],
    deletedTaskIds: [],
    directlyAffectedTaskIds: [],
    affectedTaskIds: [],
    sideEffects: [],
    decisionReasons: [],
    readyBefore: readyTaskIds(before),
    readyAfter: [],
  };

  // 逐个 operation 施加到 nextState（而非 currentState），分析对象收集副作用与决策理由。
  for (const operation of request.operations) {
    if (operation?.type === 'insert_task') applyInsert(nextState, operation, analysis);
    else if (operation?.type === 'edit_task') applyEdit(nextState, operation, analysis);
    else if (operation?.type === 'delete_task') applyDelete(nextState, operation, analysis);
    else throw new Error(`unsupported dynamic planning operation: ${operation?.type || '(missing)'}`);
  }

  // 收尾校验：叠加多个操作后仍须满足图不变量与历史不可改写。
  taskGraph.assertTaskGraph(nextState.tasks || []);
  assertHistoryPreserved(before, nextState);
  analysis.directlyAffectedTaskIds = [...new Set(analysis.directlyAffectedTaskIds)];
  // 影响闭包 = 直接受影响者的下游传递闭包；只保留「当前仍存在」或「本就被删」的 id
  // （被删任务也应出现在闭包里，供 hold / 审计看到它曾被波及）。
  analysis.affectedTaskIds = downstreamTaskIds(nextState.tasks || [], analysis.directlyAffectedTaskIds)
    .filter((id) => (nextState.tasks || []).some((task) => task.id === id) || analysis.deletedTaskIds.includes(id));
  analysis.readyAfter = readyTaskIds(nextState);
  // 有任何高风险理由 → 上层须走人工决策（service 据此决定 proposal 状态）。
  analysis.requiresDecision = analysis.decisionReasons.length > 0;
  // 不变量快照：图合法、历史保留在到达此处时已成立；验收标准是否被改动是给上层判冲突用的。
  analysis.invariants = {
    taskGraphValid: true,
    activeAndDoneTasksPreserved: true,
    planAcceptanceCriteriaPreserved: JSON.stringify(before.plan?.acceptanceCriteria ?? null)
      === JSON.stringify(nextState.plan?.acceptanceCriteria ?? null),
  };

  return { nextState, analysis };
}

module.exports = { EDITABLE_FIELDS, readyTaskIds, downstreamTaskIds, immutableDownstreamTasks, planAdjustment };
