'use strict';

/** 局部动态规划：把一组语义化任务调整展开成完整、可校验的 state 变更与副作用报告。 */
const taskGraph = require('../../lib/task-graph.cjs');

const EDITABLE_FIELDS = new Set([
  'title', 'kind', 'prompt', 'wbsRef', 'deps', 'plannedFiles', 'constraints', 'acceptance',
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function taskMap(tasks) {
  return new Map((tasks || []).map((task) => [task.id, task]));
}

function readyTaskIds(state) {
  const byId = taskMap(state.tasks);
  const held = new Set(Object.values(state.dynamicPlanning?.holds || {}).flatMap((hold) => hold.taskIds || []));
  return (state.tasks || [])
    .filter((task) => task.status === 'pending' && !held.has(task.id)
      && (task.deps || []).every((depId) => byId.get(depId)?.status === 'done'))
    .map((task) => task.id);
}

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

function immutableDownstreamTasks(tasks, taskId) {
  const byId = taskMap(tasks);
  return downstreamTaskIds(tasks, [taskId])
    .filter((id) => id !== taskId)
    .map((id) => byId.get(id))
    .filter((task) => task && ['active', 'done'].includes(task.status));
}

function assertNonEmpty(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`);
}

function insertIntoMilestones(state, targetId, insertedId, sideEffects) {
  for (const milestone of state.milestones || []) {
    if (!Array.isArray(milestone.tasks)) continue;
    const index = milestone.tasks.indexOf(targetId);
    if (index < 0 || milestone.tasks.includes(insertedId)) continue;
    milestone.tasks.splice(index, 0, insertedId);
    sideEffects.push({ type: 'milestone_task_inserted', milestoneId: milestone.id, taskId: insertedId, before: targetId });
  }
}

function removeFromMilestones(state, taskId, sideEffects) {
  for (const milestone of state.milestones || []) {
    if (!Array.isArray(milestone.tasks) || !milestone.tasks.includes(taskId)) continue;
    milestone.tasks = milestone.tasks.filter((id) => id !== taskId);
    sideEffects.push({ type: 'milestone_task_removed', milestoneId: milestone.id, taskId });
  }
}

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
  const result = taskGraph.insertPrerequisiteTask(state, {
    targetId: target.id,
    task: inserted,
    allowedTargetStatuses: ['pending', 'blocked'],
  });
  if (result.target.status === 'blocked') {
    result.target.status = 'pending';
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
  if (Object.keys(patch).length === 0 && operation.reopen !== true) throw new Error('edit_task patch cannot be empty');
  const unknown = Object.keys(patch).filter((field) => !EDITABLE_FIELDS.has(field));
  if (unknown.length) throw new Error(`edit_task unsupported fields: ${unknown.join(', ')}`);

  const previous = clone(task);
  const oldDeps = [...(previous.deps || [])];
  for (const [field, value] of Object.entries(patch)) {
    if (field === 'deps') continue;
    task[field] = clone(value);
  }
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
    const nextDeps = [];
    for (const depId of dependent.deps || []) {
      if (depId === target.id) nextDeps.push(...(target.deps || []));
      else nextDeps.push(depId);
    }
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

  for (const operation of request.operations) {
    if (operation?.type === 'insert_task') applyInsert(nextState, operation, analysis);
    else if (operation?.type === 'edit_task') applyEdit(nextState, operation, analysis);
    else if (operation?.type === 'delete_task') applyDelete(nextState, operation, analysis);
    else throw new Error(`unsupported dynamic planning operation: ${operation?.type || '(missing)'}`);
  }

  taskGraph.assertTaskGraph(nextState.tasks || []);
  assertHistoryPreserved(before, nextState);
  analysis.directlyAffectedTaskIds = [...new Set(analysis.directlyAffectedTaskIds)];
  analysis.affectedTaskIds = downstreamTaskIds(nextState.tasks || [], analysis.directlyAffectedTaskIds)
    .filter((id) => (nextState.tasks || []).some((task) => task.id === id) || analysis.deletedTaskIds.includes(id));
  analysis.readyAfter = readyTaskIds(nextState);
  analysis.requiresDecision = analysis.decisionReasons.length > 0;
  analysis.invariants = {
    taskGraphValid: true,
    activeAndDoneTasksPreserved: true,
    planAcceptanceCriteriaPreserved: JSON.stringify(before.plan?.acceptanceCriteria ?? null)
      === JSON.stringify(nextState.plan?.acceptanceCriteria ?? null),
  };

  return { nextState, analysis };
}

module.exports = { EDITABLE_FIELDS, readyTaskIds, downstreamTaskIds, immutableDownstreamTasks, planAdjustment };
