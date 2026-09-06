// src/cli/scheduler.js — 滑动窗口调度器核心（纯逻辑）
//
// CLI 拥有调度权：就绪池 + 配额上限 + plannedFiles 动态冲突 + 补位循环。
// 派发（dispatcher）与完成感知（waitAnyDone）通过注入接口抽象，便于先单测，
// 后接真实通道（inbox socket 派发 / SubagentStop hook 落账）。
//
// 配额语义：硬上限，非目标——池子按实际就绪任务填充，不足不凑满。
// 预留「延时补位」：waitAnyDone 可容忍完成信号延迟，补位不依赖即时信号。

import { loadState, peekReadyTasks, buildScopeIndex, filesConflict, EXCLUSIVE_KINDS } from '../lib/state.js';

/** 归一化配额（硬上限，缺省 1） */
function makeQuota(cfg) {
  const agents = cfg?.agents || {};
  return {
    max: Math.max(1, agents.max ?? 1),
    maxModules: Math.max(1, agents.maxModules ?? 1),
    maxPerModule: Math.max(1, agents.maxPerModule ?? 1),
    maxPerFeature: Math.max(1, agents.maxPerFeature ?? 1),
  };
}

/** 运行中集合：占用/配额判断/释放，按功能/模块计数 */
function makeRunning() {
  const tasks = new Map(); // taskId -> task
  const perModule = new Map();
  const perFeature = new Map();
  const activeModules = new Set();

  return {
    get size() { return tasks.size; },
    has(id) { return tasks.has(id); },
    getTask(id) { return tasks.get(id); },
    taskIds() { return [...tasks.keys()]; },
    add(task, scope) {
      tasks.set(task.id, task);
      if (scope?.moduleId) perModule.set(scope.moduleId, (perModule.get(scope.moduleId) || 0) + 1);
      if (scope?.featureId) perFeature.set(scope.featureId, (perFeature.get(scope.featureId) || 0) + 1);
      if (scope?.moduleId) activeModules.add(scope.moduleId);
    },
    remove(id, scope) {
      const task = tasks.get(id);
      tasks.delete(id);
      if (scope?.moduleId) {
        const n = (perModule.get(scope.moduleId) || 1) - 1;
        perModule.set(scope.moduleId, Math.max(0, n));
        if (n <= 0) activeModules.delete(scope.moduleId);
      }
      if (scope?.featureId) {
        perFeature.set(scope.featureId, Math.max(0, (perFeature.get(scope.featureId) || 1) - 1));
      }
      return task;
    },
    canOccupy(task, scope, quota) {
      if (tasks.size >= quota.max) return false;
      if (scope?.featureId && (perFeature.get(scope.featureId) || 0) >= quota.maxPerFeature) return false;
      if (scope?.moduleId && (perModule.get(scope.moduleId) || 0) >= quota.maxPerModule) return false;
      if (scope?.moduleId && !activeModules.has(scope.moduleId) && activeModules.size >= quota.maxModules) return false;
      return true;
    },
    /** 运行中所有任务的 plannedFiles 展平（动态文件冲突比对） */
    files() {
      return [...tasks.values()].flatMap((t) => t.plannedFiles || []);
    },
  };
}

/** 任务的 plannedFiles 与运行中集合是否有冲突 */
function filesConflictWithRunning(task, running) {
  const files = task.plannedFiles || [];
  const runningFiles = running.files();
  for (const f of files) {
    for (const rf of runningFiles) {
      if (filesConflict(f, rf)) return true;
    }
  }
  return false;
}

/** 独占任务（commit）：会改变共享仓库状态，不与任何任务并行 */
function isExclusive(task) {
  return EXCLUSIVE_KINDS.has(task.kind || 'dev');
}

/** 从池里取第一个满足「配额 + 文件冲突 + 独占」约束的任务；无可派 → null */
function pickFromPool(pool, running, quota, scope) {
  // 独占任务（commit）运行中 → 禁止派发任何其他任务
  const exclusiveRunning = [...running.taskIds()].some((id) => isExclusive(running.getTask(id)));
  if (exclusiveRunning) return null;

  for (const task of pool) {
    if (running.has(task.id)) continue;
    const s = scope.get(task.id) || {};
    // 缺失 plannedFiles（非只读 review）→ 保守串行，无法判定冲突面，不与任何任务并行
    const noFiles = !(Array.isArray(task.plannedFiles) && task.plannedFiles.length > 0) && task.kind !== 'review';
    if (isExclusive(task) || noFiles) {
      // 独占/保守串行：仅当无其他运行中时单独派发
      if (running.size === 0) return { task, scope: s };
      continue;
    }
    if (!running.canOccupy(task, s, quota)) continue;
    if (filesConflictWithRunning(task, running)) continue;
    return { task, scope: s };
  }
  return null;
}

/**
 * 滑动窗口主循环。
 *
 * @param {object} opts
 *  - projectRoot: 项目根（读 .awf/state.json）
 *  - cfg: run 配置（agents 配额）
 *  - dispatcher: { send(task) => Promise } — 派发「派生后台子 Agent 执行 task」指令
 *  - waitAnyDone: (running) => Promise<{ done: string[], suspended: boolean }> — 等待至少一个运行中任务完成；
 *    返回完成的 taskId 列表 + 是否决策上抛挂起（挂起时不补位，等决策解决）
 *  - onTaskComplete: (taskId, task) => void — 完成回调（可选，落账侧）
 * @returns {Promise<{ dispatched: number }>}
 */
export async function runScheduler({ projectRoot, cfg, dispatcher, waitAnyDone, onTaskComplete }) {
  const quota = makeQuota(cfg);
  const running = makeRunning();
  let state = loadState(projectRoot);
  let scope = buildScopeIndex(state?.tasks || []);
  const pool = peekReadyTasks(state);
  const poolIds = new Set(pool.map((t) => t.id));
  let dispatched = 0;
  let suspended = false; // 决策上抛挂起：不补位，等决策解决

  while (true) {
    // 补位：填到配额满或池无可派（含文件冲突/独占/保守串行阻塞）；决策挂起时跳过
    if (!suspended) {
      let picked;
      while ((picked = pickFromPool(pool, running, quota, scope))) {
        await dispatcher.send(picked.task);
        running.add(picked.task, picked.scope);
        pool.splice(pool.indexOf(picked.task), 1);
        poolIds.delete(picked.task.id);
        dispatched++;
      }
    }
    if (running.size === 0) break; // 池空或无可派且无运行 → 结束

    // 等至少一个完成（容忍延迟）
    const { done, suspended: nextSuspended } = await waitAnyDone(running);
    suspended = nextSuspended;
    for (const id of done) {
      const s = scope.get(id) || {};
      const task = running.remove(id, s);
      // await：门禁闭环钩子（gate-fix）同步改盘，须在池刷新前完成，派生修复任务才能进就绪池
      if (onTaskComplete) await onTaskComplete(id, task);
    }

    // 池刷新：落账后可能有新就绪任务（依赖链/门禁转换），重读 state 加入池 + 重算 scope
    state = loadState(projectRoot);
    const freshScope = buildScopeIndex(state?.tasks || []);
    const fresh = peekReadyTasks(state);
    for (const t of fresh) {
      if (!poolIds.has(t.id) && !running.has(t.id)) {
        pool.push(t);
        poolIds.add(t.id);
      }
    }
    scope = freshScope;
  }

  return { dispatched };
}
