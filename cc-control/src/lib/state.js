import path from 'path';
import fs from 'fs';
import { logger } from './ui/log.js';

const STATE_FILE = '.awf/state.json';

// ── 基础读写 ──

/** 读取 .awf/state.json */
export function loadState(projectRoot) {
  const filePath = path.join(projectRoot, STATE_FILE);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/** 写入 .awf/state.json（自动补 lastUpdated） */
export function saveState(projectRoot, state) {
  const filePath = path.join(projectRoot, STATE_FILE);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  state.lastUpdated = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

// ── 任务查询 ──

/** 获取当前工作流阶段 */
export function getCurrentPhase(projectRoot) {
  const state = loadState(projectRoot);
  return state?.currentState || null;
}

/** 获取下一个待执行任务（pending 且 deps 已满足） */
export function getNextTask(state) {
  return findNextTask(state);
}

/** 任务依赖是否全部 done（含 deps 缺失 → 不满足） */
function depsDone(task, taskById) {
  if (!task.deps || task.deps.length === 0) return true;
  return task.deps.every((depId) => {
    const dep = taskById.get(depId);
    return dep && dep.status === 'done';
  });
}

export function findNextTask(state) {
  const tasks = state?.tasks || [];
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  return tasks.find((t) => t.status === 'pending' && depsDone(t, taskById)) || null;
}

// ── 多 agent 批次选择 ──

/** 独占任务类型：doc/commit 必须单独成批，不与其他任务并行 */
const EXCLUSIVE_KINDS = new Set(['doc', 'commit']);

/**
 * 静态作用域索引：taskId → { featureId, moduleId }
 * - review gate 的 deps 内任务归该功能（featureId = review gate id）
 * - test gate 的 deps 内任务归该模块（moduleId = test gate id）
 * doc gate（deps=全部任务）不参与，避免污染模块归属
 */
function buildScopeIndex(tasks) {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const scope = new Map();
  const get = (id) => {
    let s = scope.get(id);
    if (!s) { s = {}; scope.set(id, s); }
    return s;
  };
  for (const t of tasks) {
    if (t.kind === 'review') {
      get(t.id).featureId = t.id;
      for (const depId of t.deps || []) {
        const d = taskById.get(depId);
        if (d) get(depId).featureId = t.id;
      }
    } else if (t.kind === 'test') {
      get(t.id).moduleId = t.id;
      for (const depId of t.deps || []) {
        const d = taskById.get(depId);
        if (d) get(depId).moduleId = t.id;
      }
    }
  }
  return scope;
}

/**
 * 选择一个可并行的 ready 批次（确定性 greedy，保持 state 原始顺序）
 *
 * 规则：
 * 1. ready 集合 = pending 且 deps 全部 done
 * 2. doc/commit 独占成批（优先返回，不与任何任务并行）
 * 3. 四级配额 greedy 打包：max 总并发 / maxModules 活跃模块 / maxPerModule 每模块任务 / maxPerFeature 每功能任务
 *
 * @param {object} state
 * @param {{ agents?: { max?: number, maxModules?: number, maxPerModule?: number, maxPerFeature?: number } }} [config]
 * @returns {object[]} 选中的任务列表（可能为空）
 */
export function selectReadyBatch(state, config) {
  const tasks = state?.tasks || [];
  if (tasks.length === 0) return [];
  const agents = config?.agents || {};
  const max = Math.max(1, agents.max ?? 1);
  const maxModules = Math.max(1, agents.maxModules ?? 1);
  const maxPerModule = Math.max(1, agents.maxPerModule ?? 1);
  const maxPerFeature = Math.max(1, agents.maxPerFeature ?? 1);

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const ready = tasks.filter((t) => t.status === 'pending' && depsDone(t, taskById));
  if (ready.length === 0) return [];

  // 独占任务单独成批
  const exclusive = ready.find((t) => EXCLUSIVE_KINDS.has(t.kind || 'dev'));
  if (exclusive) return [exclusive];

  const scope = buildScopeIndex(tasks);
  const batch = [];
  const perFeature = new Map();
  const perModule = new Map();
  const activeModules = new Set();

  for (const t of ready) {
    if (batch.length >= max) break;
    const s = scope.get(t.id) || {};
    const fid = s.featureId;
    const mid = s.moduleId;
    if (fid && (perFeature.get(fid) || 0) >= maxPerFeature) continue;
    if (mid && (perModule.get(mid) || 0) >= maxPerModule) continue;
    if (mid && !activeModules.has(mid)) {
      if (activeModules.size >= maxModules) continue;
      activeModules.add(mid);
    }
    batch.push(t);
    if (fid) perFeature.set(fid, (perFeature.get(fid) || 0) + 1);
    if (mid) perModule.set(mid, (perModule.get(mid) || 0) + 1);
  }
  return batch;
}

/** 检查是否所有任务均已完成 */
export function isMilestoneDone(state) {
  const tasks = state?.tasks || [];
  return tasks.length > 0 && tasks.every((t) => t.status === 'done');
}

// ── 快照备份 ──

/**
 * 将当前 state.json 快照到 .awf/versions/<version>-<timestamp>.json
 * 仅在 run 所有 tasks 完成后调用
 */
export function backupState(projectRoot) {
  const state = loadState(projectRoot);
  if (!state) return;
  if (!state.version) return;

  const dir = path.join(projectRoot, '.awf', 'versions');
  fs.mkdirSync(dir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `${state.version}-${ts}.json`);
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}
