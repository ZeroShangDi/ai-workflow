'use strict';
/**
 * ready-tasks.cjs — 「谁就绪」的判据单源（纯查询，不做 I/O）
 *
 * 就绪 = **pending** + **未被 dynamicPlanning.holds 挡住** + **deps 全部 done**。
 * 这三条是本文件唯一要说的事 —— 调度器（run/scheduler.js）、门禁/实例化前判断、
 * 动态规划的 readyBefore/readyAfter 报告，全都必须用它，否则「报告里说就绪」与
 * 「调度器真去派的」会各算各的，漂移了也不报错。
 *
 * 为什么单独一个 CJS 模块：消费方横跨 ESM/CJS（`shared/state.js` 是 ESM，
 * `features/replanning/planner.cjs` 是 CJS，后者 require 不了 ESM）—— 同 state-paths.cjs 的处置。
 *
 * 边界：只回答「哪些任务就绪」。不判文件冲突、不判配额、不决定派发顺序（那些在 run/scheduler.js）。
 */

/**
 * 被动态规划 hold 住的任务 id 集合（state.dynamicPlanning.holds 里登记的全部 taskIds）。
 * hold 是「提案挂起期间先别动这些任务」的跨进程标记，故它参与就绪判定。
 * @param {object} state
 * @returns {Set<string>}
 */
function heldTaskIds(state) {
  return new Set(Object.values(state?.dynamicPlanning?.holds || {}).flatMap((hold) => hold?.taskIds || []));
}

/** 单任务的依赖是否全部满足（依赖指向不存在任务 → 视为未满足，保守不放过悬空依赖） */
function depsDone(task, taskById) {
  if (!task.deps || task.deps.length === 0) return true;
  return task.deps.every((depId) => {
    const dep = taskById.get(depId);
    return dep && dep.status === 'done';
  });
}

/**
 * 就绪任务列表（保持 tasks 原顺序）。
 * 返回的是**任务对象**而非 id —— 调用方要 id 自行 map，需要整对象时不必二次查找。
 * @param {object} state
 * @returns {object[]}
 */
function peekReadyTasks(state) {
  const tasks = state?.tasks || [];
  if (tasks.length === 0) return [];
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const held = heldTaskIds(state);
  return tasks.filter((t) => t.status === 'pending' && !held.has(t.id) && depsDone(t, taskById));
}

module.exports = { heldTaskIds, depsDone, peekReadyTasks };
