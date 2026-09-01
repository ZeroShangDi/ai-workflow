import path from 'path';
import fs from 'fs';
import { logger } from './ui/log.js';

const STATE_FILE = '.awf/state.json';

// ── 基础读写 ──

/** 同步 sleep（锁重试用，避免依赖异步上下文） */
function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** state 写锁：与 awf-state MCP 的 writeState 共用 .awf/state.lock，防 CLI/MCP 并发写 */
function withStateLock(lockPath, fn) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() > deadline) throw new Error(`state lock timeout: ${lockPath}`);
      syncSleep(50);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(lockPath); } catch {} }
}

/** 读取 .awf/state.json */
export function loadState(projectRoot) {
  const filePath = path.join(projectRoot, STATE_FILE);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/** 写入 .awf/state.json（自动补 lastUpdated；加写锁防与 MCP 并发写） */
export function saveState(projectRoot, state) {
  const filePath = path.join(projectRoot, STATE_FILE);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  state.lastUpdated = new Date().toISOString();
  withStateLock(path.join(projectRoot, '.awf', 'state.lock'), () => {
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  });
}

/** 原子更新工作流 mode；读取锁内最新 state，避免用旧任务快照覆盖并发落账。 */
export function setWorkflowMode(projectRoot, mode) {
  const filePath = path.join(projectRoot, STATE_FILE);
  const lockPath = path.join(projectRoot, '.awf', 'state.lock');
  return withStateLock(lockPath, () => {
    let state;
    try {
      state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return false;
    }
    state.mode = mode;
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
    return true;
  });
}

/** 派发成功后将任务标记为执行中，保留其他 Agent 的并发落账。 */
export function markTaskActive(projectRoot, taskId) {
  const filePath = path.join(projectRoot, STATE_FILE);
  const lockPath = path.join(projectRoot, '.awf', 'state.lock');
  return withStateLock(lockPath, () => {
    let state;
    try {
      state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return false;
    }
    const task = state.tasks?.find((item) => item.id === taskId);
    if (!task || task.status !== 'pending') return false;
    task.status = 'active';
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
    return true;
  });
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
export const EXCLUSIVE_KINDS = new Set(['doc', 'commit']);

/**
 * 静态作用域索引：taskId → { featureId, moduleId }
 * - review gate 的 deps 内任务归该功能（featureId = review gate id）
 * - test gate 的 deps 内任务归该模块（moduleId = test gate id）
 * doc gate（deps=全部任务）不参与，避免污染模块归属
 */
export function buildScopeIndex(tasks) {
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

// ── plannedFiles 冲突判定 ──

/** 任务是否声明了 plannedFiles（缺失/空数组 → 保守串行） */
function hasPlannedFiles(task) {
  return Array.isArray(task.plannedFiles) && task.plannedFiles.length > 0;
}

/** 两个路径冲突：精确相同，或一方是另一方的目录前缀（src/util/ vs src/util/math.js） */
export function filesConflict(a, b) {
  if (a === b) return true;
  // 归一化尾斜杠，避免 'src/util/' + '/' = 'src/util//' 匹配不上
  const na = a.replace(/\/+$/, '');
  const nb = b.replace(/\/+$/, '');
  return na === nb || na.startsWith(nb + '/') || nb.startsWith(na + '/');
}

/** 任务的 plannedFiles 与已选批次的文件是否冲突 */
function conflictsWithBatch(task, batchFiles) {
  const files = task.plannedFiles || [];
  for (const f of files) {
    for (const bf of batchFiles) {
      if (filesConflict(f, bf)) return true;
    }
  }
  return false;
}

/**
 * 所有就绪任务（pending 且 deps 全 done），保持 state 原始顺序。
 * 不做配额/文件冲突/独占过滤——那些是滑动窗口调度器运行时判断。
 * @param {object} state
 * @returns {object[]}
 */
export function peekReadyTasks(state) {
  const tasks = state?.tasks || [];
  if (tasks.length === 0) return [];
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  return tasks.filter((t) => t.status === 'pending' && depsDone(t, taskById));
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
  const batchFiles = []; // 已选批次任务的 plannedFiles 展平（冲突判定）
  const perFeature = new Map();
  const perModule = new Map();
  const activeModules = new Set();

  for (const t of ready) {
    // 缺失 plannedFiles → 保守串行：不进并行批次（无文件声明，无法判定冲突面）。
    // 例外：review 门禁只读审查，天然无写冲突，无需文件声明即可并行。
    if (!hasPlannedFiles(t) && t.kind !== 'review') continue;
    if (batch.length >= max) break;
    // 文件冲突：plannedFiles 与已选批次不相交，否则留到后续批次
    if (conflictsWithBatch(t, batchFiles)) continue;
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
    batchFiles.push(...(t.plannedFiles || []));
    if (fid) perFeature.set(fid, (perFeature.get(fid) || 0) + 1);
    if (mid) perModule.set(mid, (perModule.get(mid) || 0) + 1);
  }

  // 有文件声明的任务都没能成批（全是缺失 plannedFiles 的任务）→ 取第一个缺失任务单独成批
  if (batch.length === 0) {
    const noFiles = ready.find((t) => !hasPlannedFiles(t));
    if (noFiles) return [noFiles];
  }
  return batch;
}

/** 检查是否所有任务均已完成 */
export function isMilestoneDone(state) {
  const tasks = state?.tasks || [];
  return tasks.length > 0 && tasks.every((t) => t.status === 'done');
}

// ── 门禁闭环 ──

/** 门禁复审最大轮次（超过则保持 blocked，需人工介入） */
export const MAX_RECHECK = 3;

/**
 * 计算门禁修复任务的下一轮元数据：recheck 序号 + 派生任务 id。
 * 与 spawnGateFixTask 共用同一组判定（null = 不可派生）。
 * 调用方先取此元数据构建 prompt，再传给 spawnGateFixTask，保证 fixId 一致。
 *
 * @param {object} gateTask 门禁任务（kind=review/test）
 * @returns {{ recheck: number, fixId: string } | null}
 */
export function gateFixMeta(gateTask) {
  if (!gateTask) return null;
  if (gateTask.kind !== 'review' && gateTask.kind !== 'test') return null;
  if (gateTask.status !== 'blocked') return null;
  const v = gateTask.exec?.verdict;
  if (!v || v.level === 'pass') return null; // 无 verdict 视为旧协议/卡住，不派生
  if ((gateTask.exec?.recheck || 0) >= MAX_RECHECK) return null; // 轮次上限，保持 blocked
  const recheck = (gateTask.exec?.recheck || 0) + 1;
  return { recheck, fixId: `${gateTask.id}-F${recheck}` };
}

/**
 * 门禁任务 fail → 派生修复任务 + 回退门禁待复审。
 * 纯 mutate state，不写盘——由调用方（gate-fix.handleGateCompletion）负责 load/save。
 *
 * 不派生的条件：非门禁 / 非 blocked / 无 verdict / verdict pass / 达轮次上限。
 * prompt 由调用方经插件模板生成后传入（gateFixMeta 取 fixId 保证一致），本函数不硬编码命令。
 *
 * @param {object} state
 * @param {object} gateTask 刚完成的门禁任务（kind=review/test）
 * @param {string} prompt 已生成的修复任务执行提示词
 * @returns {string|null} 新修复任务 id（不派生则 null）
 */
export function spawnGateFixTask(state, gateTask, prompt) {
  const meta = gateFixMeta(gateTask);
  if (!meta) return null;
  const { recheck, fixId } = meta;

  const fix = {
    id: fixId,
    kind: 'dev',
    title: `修复 ${gateTask.title} 发现的问题（第 ${recheck} 轮）`,
    status: 'pending', // 必须 pending 才进 peekReadyTasks 就绪池
    deps: [...(gateTask.deps || [])], // 复制原产物依赖，保证产物就绪后才修
    plannedFiles: [], // 保守串行：无文件声明不与其他任务并行
    constraints: [],
    acceptance: gateTask.acceptance || `门禁 ${gateTask.id} 复审通过`,
    prompt,
  };

  state.tasks.push(fix);
  gateTask.status = 'pending'; // 回退门禁待复审
  gateTask.deps = [...(gateTask.deps || []), fixId]; // deps 追加修复任务，复审时就绪
  gateTask.exec = gateTask.exec || {};
  gateTask.exec.recheck = recheck; // 保留 verdict
  return fixId;
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
