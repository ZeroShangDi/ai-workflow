/**
 * state.js — 工作流状态（.awf/state.json）的读写与派生查询（ESM）
 *
 * 职责：封装 state.json 的全部访问面——
 *   1. 基础读写：loadState / saveState / backupState / archiveOldStateForPlan；
 *   2. 并发安全落账原语：模式切换、任务原子占用 / 回退、CAS 整份替换（replaceStateIfUnchanged）；
 *   3. 派生查询：就绪池（peekReadyTasks）、作用域索引、文件冲突判定、门禁派生元数据。
 * 上层（run 宿主 / 调度器 scheduler.js / gate-fix / CLI / MCP）只经本模块读写 state，
 * 不直接碰文件。持久化本身统一走 store-core（单写序列化 + 原子写）。
 *
 * 并发模型（本模块的核心价值）：CLI / MCP / server 共用同一把 .awf/state.lock（stateLockPath），
 * 所有「读-改-写」都在锁内完成，避免并发覆盖。尤其 server-mode MCP 先在进程内跑完工具语义、
 * 之后才落盘，中间存在窗口，故提供 replaceStateIfUnchanged 做乐观并发（CAS）而非裸覆盖。
 *
 * 边界：
 *   - 不含调度决策（配额/补位在 server/run/scheduler.js），本模块只提供「谁就绪、谁冲突」的纯查询。
 *   - 不实现任务图校验/变更算法（在 server/replanning/graph.cjs），此处只调用其 assert / insert 组合。
 *   - 全模块无进程内缓存：每次读盘，保证跨进程对 state.json 的改动能被及时看到。
 *   - STATE_FILE 常量锁定现行单 run 布局（.awf/state.json 相对 projectRoot）；每 run 布局
 *     （.awf/runs/<sid>/state.json）由 store.cjs / run-context 走 filePath 直取，不经过本模块。
 */

import path from 'path';
import fs from 'fs';
import crypto from 'node:crypto';
// 持久化统一走 store-core（单写序列化 + 原子写），不再各自实现 state.lock + writeFileSync
import { withFileLock as withStateLock, readJsonSync, writeJsonAtomicSync, updateStateSync } from './store-core.cjs';
// 任务图校验与安全插入的唯一实现（纯内存、不做 I/O）；本模块在落账边界调用它兜住非法图
import taskGraph from '../features/replanning/graph.cjs';

const { assertTaskGraph, assertTaskDependenciesDone, insertPrerequisiteTask } = taskGraph;

/** 现行单 run 布局下 state.json 相对 projectRoot 的位置 */
const STATE_FILE = '.awf/state.json';

// ── 基础读写 ──

/** state 写锁路径（CLI/MCP/server 共用同名 .awf/state.lock，防跨实现并发写） */
function stateLockPath(projectRoot) {
  return path.join(projectRoot, '.awf', 'state.lock');
}

/** 读取 .awf/state.json（缺失/非法 → null） */
export function loadState(projectRoot) {
  return readJsonSync(path.join(projectRoot, STATE_FILE));
}

/**
 * 写入 .awf/state.json（锁内整份覆盖 + 原子写；自动补 lastUpdated）。
 *
 * 注意是「整份覆盖」：调用方应先 loadState 拿到最新版再改再存，否则会覆盖他人写入。
 * 若调用方持有的是较早读到的快照、又必须落盘，应改用 replaceStateIfUnchanged（CAS）。
 */
export function saveState(projectRoot, state) {
  const filePath = path.join(projectRoot, STATE_FILE);
  state.lastUpdated = new Date().toISOString();
  return withStateLock(stateLockPath(projectRoot), () => {
    writeJsonAtomicSync(filePath, state);
  });
}

/**
 * state 乐观并发指纹：对 state 全量 JSON 求 sha256。
 * 用途：lastUpdated 只到毫秒，同一毫秒内的两次写入时间戳可能相同，仅靠时间戳无法区分版本；
 * 指纹比时间戳更能识别「内容真的变了」，用于覆盖 lastUpdated 碰撞。
 */
export function stateFingerprint(state) {
  return crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

/**
 * 仅当磁盘 state 仍是调用方刚读取的版本时，才整份替换（乐观并发 / CAS）。
 *
 * server-mode MCP 需要先读 state、在进程内执行工具语义、再把结果交给 server 落盘；
 * 这段时间内若别的写者已经推进 state，普通 saveState 会把新结果静默覆盖。这里以
 * lastUpdated + state 内容指纹作为乐观并发令牌，并把“比较 + 写入”放在同一把
 * state.lock 内；指纹用于覆盖同一毫秒内时间戳碰撞。
 * null 表示调用方读到的 state 当时没有 lastUpdated（兼容旧 state）。
 *
 * @param {string} projectRoot
 * @param {object} nextState 要写入的新 state（须为普通对象）
 * @param {string|null} [expectedLastUpdated] 调用方读到的 lastUpdated（旧 state 无此字段时为 null）
 * @param {string} expectedStateFingerprint 调用方读到时经 stateFingerprint 算出的指纹（必填非空）
 * @returns {{ ok: true, lastUpdated: string }
 *          | { ok: false, conflict: true, expectedLastUpdated, actualLastUpdated, actualStateFingerprint }}
 *          冲突时返回 ok:false 并带上实际值，便于调用方决定重读重试还是放弃（不会抛错）。
 * @throws {TypeError} 入参形态非法（nextState 非对象 / 指纹缺失）——这是编程错误，直接抛。
 */
export function replaceStateIfUnchanged(
  projectRoot,
  nextState,
  expectedLastUpdated = null,
  expectedStateFingerprint = null,
) {
  if (!nextState || typeof nextState !== 'object' || Array.isArray(nextState)) {
    throw new TypeError('nextState must be an object');
  }
  if (typeof expectedStateFingerprint !== 'string' || expectedStateFingerprint.length === 0) {
    throw new TypeError('expectedStateFingerprint must be a non-empty string');
  }
  const filePath = path.join(projectRoot, STATE_FILE);
  return withStateLock(stateLockPath(projectRoot), () => {
    const current = readJsonSync(filePath);
    const actualLastUpdated = current?.lastUpdated ?? null;
    const expected = expectedLastUpdated ?? null;
    const actualStateFingerprint = stateFingerprint(current);
    const fingerprintMismatch = actualStateFingerprint !== expectedStateFingerprint;
    // 时间戳或内容任一不符即判定冲突：两者都由调用方读盘时记下，比对全部在锁内完成
    if (actualLastUpdated !== expected || fingerprintMismatch) {
      return {
        ok: false,
        conflict: true,
        expectedLastUpdated: expected,
        actualLastUpdated,
        actualStateFingerprint,
      };
    }

    nextState.lastUpdated = new Date().toISOString();
    writeJsonAtomicSync(filePath, nextState);
    return { ok: true, lastUpdated: nextState.lastUpdated };
  });
}

/**
 * 原子更新工作流 mode（idle/plan/run/pause）；读取锁内最新 state，避免用旧任务快照覆盖并发落账。
 * @returns {boolean} 锁内读到 state 且写入成功 → true；state 不存在 → false（不凭空创建）
 */
export function setWorkflowMode(projectRoot, mode) {
  const filePath = path.join(projectRoot, STATE_FILE);
  return withStateLock(stateLockPath(projectRoot), () => {
    const state = readJsonSync(filePath);
    if (!state) return false;
    state.mode = mode;
    state.lastUpdated = new Date().toISOString();
    writeJsonAtomicSync(filePath, state);
    return true;
  });
}

/**
 * 派发前原子占用任务（pending → active）；只有占用成功的调用者才可以真正执行。
 *
 * 占用成功的充要条件（任一不满足即返回 false，不做任何改动）：
 *   1. 整图合法（assertTaskGraph，非法直接抛）；
 *   2. 任务存在且当前是 pending（已 active/done/blocked 的任务不重复占用）；
 *   3. 该任务不是被 dynamicPlanning.holds 暂停的（heldTaskIds）；
 *   4. deps 全部 done（assertTaskDependenciesDone，未满足会抛错）。
 * 占用即打 exec.startedAt 并清掉旧 completedAt（重跑同一任务时不残留上次的完成时间）。
 *
 * @returns {boolean} true=占用成功（任务已变 active）；false=不满足占用条件，任务保持原状
 * @throws 图非法/依赖未满足时抛 TaskGraphError（调用方据此判断是否应当派发）
 */
export function markTaskActive(projectRoot, taskId) {
  const filePath = path.join(projectRoot, STATE_FILE);
  return withStateLock(stateLockPath(projectRoot), () => {
    const state = readJsonSync(filePath);
    if (!state) return false;
    assertTaskGraph(state.tasks || []);
    const task = state.tasks?.find((item) => item.id === taskId);
    if (!task || task.status !== 'pending') return false;
    if (heldTaskIds(state).has(taskId)) return false;
    assertTaskDependenciesDone(state.tasks, taskId);
    task.status = 'active';
    task.exec = task.exec || {};
    task.exec.startedAt = new Date().toISOString();
    delete task.exec.completedAt;
    state.lastUpdated = new Date().toISOString();
    writeJsonAtomicSync(filePath, state);
    return true;
  });
}

/**
 * 派发通道失败时释放尚未开始执行的占用（active → pending）。
 * 只回退仍为 active 的同一任务；已经被执行端结算的状态不会被覆盖。
 *
 * 边界：state 不存在或任务非 active → false（no-op）。清掉 startedAt，并在 exec 已空时
 * 连 exec 一起删掉，避免留下空对象污染后续读取。
 * @returns {boolean} true=确实回退了；false=无需回退
 */
export function requeueTaskIfActive(projectRoot, taskId) {
  const filePath = path.join(projectRoot, STATE_FILE);
  return withStateLock(stateLockPath(projectRoot), () => {
    const state = readJsonSync(filePath);
    if (!state) return false;
    const task = state.tasks?.find((item) => item.id === taskId);
    if (!task || task.status !== 'active') return false;
    task.status = 'pending';
    if (task.exec) {
      delete task.exec.startedAt;
      if (Object.keys(task.exec).length === 0) delete task.exec;
    }
    state.lastUpdated = new Date().toISOString();
    writeJsonAtomicSync(filePath, state);
    return true;
  });
}

// ── 任务查询 ──

/**
 * 获取当前工作流阶段（state.currentState，如 'CODE'）。
 * @returns {string|null} 取不到时 null
 */
export function getCurrentPhase(projectRoot) {
  const state = loadState(projectRoot);
  return state?.currentState || null;
}

/** 获取下一个待执行任务（pending 且 deps 已满足）；无则 null。findNextTask 的导出别名。 */
export function getNextTask(state) {
  return findNextTask(state);
}

/** 任务依赖是否全部 done（含 deps 缺失 → 不满足） */
function depsDone(task, taskById) {
  if (!task.deps || task.deps.length === 0) return true;
  // 依赖指向不存在任务时 dep 为 undefined → 视为未满足（保守，不放过悬空依赖）
  return task.deps.every((depId) => {
    const dep = taskById.get(depId);
    return dep && dep.status === 'done';
  });
}

/**
 * 收集被动态规划 proposal 暂停（hold）的任务 id 集合。
 * 语义：dynamicPlanning.holds 里每个 hold 记录它暂停的 taskIds；这些任务即使 pending + deps 满足
 * 也不进就绪池，等 proposal 批准/决策后再释放。state 或 holds 缺失 → 空集。
 */
export function heldTaskIds(state) {
  return new Set(Object.values(state?.dynamicPlanning?.holds || {}).flatMap((hold) => hold?.taskIds || []));
}

/**
 * 按 state 原始顺序找第一个「就绪」任务：pending 且未被 hold、且 deps 全 done。
 * 性能：每次调用重建 taskById 索引，对任务量小（百级）足够；调用频繁时注意重算成本。
 * @returns {object|null} 就绪任务对象，没有则 null
 */
export function findNextTask(state) {
  const tasks = state?.tasks || [];
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const held = heldTaskIds(state);
  return tasks.find((t) => t.status === 'pending' && !held.has(t.id) && depsDone(t, taskById)) || null;
}

// ── 多 agent 批次选择 ──

/**
 * 独占任务类型：commit 会改变共享仓库状态，必须单独成批（不与任何任务并行）。
 * 用 Set 而非单值判断，是为将来可能新增的独占类型留位；selectReadyBatch 命中即整批只返回它。
 */
export const EXCLUSIVE_KINDS = new Set(['commit']);

/**
 * 静态作用域索引：taskId → { featureId, moduleId }
 * - review gate 的 deps 内任务归该功能（featureId = review gate id）
 * - test gate 的 deps 内任务归该模块（moduleId = test gate id）
 * doc gate（deps=全部任务）不参与，避免污染模块归属
 *
 * 用途：selectReadyBatch 的 maxPerFeature / maxPerModule 配额按此归属计数。
 * 注意是「静态」派生——只看 deps 关系、不看运行期结果；未归属任何 gate 的任务在索引中无条目。
 * 同一个任务可能同时带 featureId 与 moduleId（既属某功能、又属某模块）。
 * @param {object[]} tasks
 * @returns {Map<string, { featureId?: string, moduleId?: string }>}
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

/**
 * 任务是否声明了 plannedFiles（缺失/空数组 → 保守串行）。
 * 无文件声明时无法判定冲突面，调度器据此不让它进并行批次（见 selectReadyBatch）。
 */
function hasPlannedFiles(task) {
  return Array.isArray(task.plannedFiles) && task.plannedFiles.length > 0;
}

/**
 * 两个路径是否冲突：精确相同，或一方是另一方的目录前缀（src/util/ vs src/util/math.js）。
 * 用于并行批次里判断两任务的改动文件是否可能重叠——重叠就不能并行，否则互相覆盖。
 * @returns {boolean}
 */
export function filesConflict(a, b) {
  if (a === b) return true;
  // 归一化尾斜杠，避免 'src/util/' + '/' = 'src/util//' 匹配不上
  const na = a.replace(/\/+$/, '');
  const nb = b.replace(/\/+$/, '');
  return na === nb || na.startsWith(nb + '/') || nb.startsWith(na + '/');
}

/**
 * 任务的 plannedFiles 与已选批次的文件（展平）是否相交；只要有一对冲突即 true。
 * 复杂度 O(|files| × |batchFiles|)：任务/文件量小，不做进一步优化。
 */
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
 * 所有就绪任务（pending 且 deps 全 done、未被 hold），保持 state 原始顺序。
 * 不做配额/文件冲突/独占过滤——那些是滑动窗口调度器运行时判断（selectReadyBatch）。
 * @param {object} state
 * @returns {object[]} 就绪任务（可能为空；state 无 tasks → []）
 */
export function peekReadyTasks(state) {
  const tasks = state?.tasks || [];
  if (tasks.length === 0) return [];
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const held = heldTaskIds(state);
  return tasks.filter((t) => t.status === 'pending' && !held.has(t.id) && depsDone(t, taskById));
}

/**
 * 选择一个可并行的 ready 批次（确定性 greedy，保持 state 原始顺序）
 *
 * 规则：
 * 1. ready 集合 = pending 且 deps 全部 done
 * 2. commit 独占成批（优先返回，不与任何任务并行）；doc 按 plannedFiles 正常判定并行
 * 3. 四级配额 greedy 打包：max 总并发 / maxModules 活跃模块 / maxPerModule 每模块任务 / maxPerFeature 每功能任务
 *
 * 确定性：按 state 原始顺序单向扫描、不做排序/随机，因此同一 state 多次调用结果一致
 * （宿主可安全地「选批 → 派发 → 再选下一批」而不会摇摆）。
 *
 * @param {object} state
 * @param {{ agents?: { max?: number, maxModules?: number, maxPerModule?: number, maxPerFeature?: number } }} [config]
 * @returns {object[]} 选中的任务列表（可能为空）
 */
export function selectReadyBatch(state, config) {
  const tasks = state?.tasks || [];
  if (tasks.length === 0) return [];
  const agents = config?.agents || {};
  // 每级配额下限保底 1：配置成 0/负数会永远选不出任务（调度停摆），故用 Math.max 兜住
  const max = Math.max(1, agents.max ?? 1);
  const maxModules = Math.max(1, agents.maxModules ?? 1);
  const maxPerModule = Math.max(1, agents.maxPerModule ?? 1);
  const maxPerFeature = Math.max(1, agents.maxPerFeature ?? 1);

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const held = heldTaskIds(state);
  const ready = tasks.filter((t) => t.status === 'pending' && !held.has(t.id) && depsDone(t, taskById));
  if (ready.length === 0) return [];

  // 独占任务单独成批：只要有一个独占任务就立即返回它，本轮不与任何任务并行
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
    if (batch.length >= max) break; // 已达总并发上限，停止打包
    // 文件冲突：plannedFiles 与已选批次不相交，否则留到后续批次
    if (conflictsWithBatch(t, batchFiles)) continue;
    const s = scope.get(t.id) || {};
    const fid = s.featureId;
    const mid = s.moduleId;
    if (fid && (perFeature.get(fid) || 0) >= maxPerFeature) continue;
    if (mid && (perModule.get(mid) || 0) >= maxPerModule) continue;
    // 首次激活某模块时占用一个「活跃模块」名额；模块已在活跃集内则不再占额
    if (mid && !activeModules.has(mid)) {
      if (activeModules.size >= maxModules) continue;
      activeModules.add(mid);
    }
    batch.push(t);
    batchFiles.push(...(t.plannedFiles || []));
    if (fid) perFeature.set(fid, (perFeature.get(fid) || 0) + 1);
    if (mid) perModule.set(mid, (perModule.get(mid) || 0) + 1);
  }

  // 兜底：一个都没成批（ready 全是缺失 plannedFiles 的任务）时，取第一个缺失任务单独成批。
  // 意图是「至少推进一个」，避免因所有任务都无文件声明而调度停摆；它已通过前面的
  // status/held/deps 过滤，单独执行不会破坏依赖或并发安全。
  if (batch.length === 0) {
    const noFiles = ready.find((t) => !hasPlannedFiles(t));
    if (noFiles) return [noFiles];
  }
  return batch;
}

/**
 * 检查是否所有任务均已完成（里程碑收尾判据）。
 * 空任务列表视为「未完成」（tasks.length > 0 是必要条件）——避免空 state 被误判为已完成。
 */
export function isMilestoneDone(state) {
  const tasks = state?.tasks || [];
  return tasks.length > 0 && tasks.every((t) => t.status === 'done');
}

// ── 门禁闭环 ──

/** 门禁复审最大轮次（超过则保持 blocked，需人工介入）——防止修复-复审无限循环 */
export const MAX_RECHECK = 3;

/**
 * 计算门禁修复任务的下一轮元数据：recheck 序号 + 派生任务 id。
 * 与 spawnGateFixTask 共用同一组判定（null = 不可派生）。
 * 调用方先取此元数据构建 prompt，再传给 spawnGateFixTask，保证 fixId 一致。
 *
 * 不可派生（返回 null）的所有情形：
 *   - gateTask 为空 / 非 review|test / 状态非 blocked
 *   - exec.verdict 缺失（旧协议或卡住，不派生）/ verdict.level === 'pass'（已通过，无需修）
 *   - 已到 MAX_RECHECK 轮次上限（保持 blocked，交人工）
 *
 * @param {object} gateTask 门禁任务（kind=review/test）
 * @returns {{ recheck: number, fixId: string } | null} recheck 为「这一轮」的序号，fixId 形如 `R1-F2`
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
 * 不派生的条件：非门禁 / 非 blocked / 无 verdict / verdict pass / 达轮次上限（见 gateFixMeta）。
 * prompt 由调用方经插件模板生成后传入（gateFixMeta 取 fixId 保证一致），本函数不硬编码命令。
 *
 * 注意本函数会修改传入的 state.tasks：insertPrerequisiteTask 就地 splice 并把 target 换成新副本，
 * 因此回退门禁时改的是 inserted.target（state 里的新对象），不是入参 gateTask。
 *
 * @param {object} state 会被就地修改
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
    acceptance: gateTask.acceptance || `门禁 ${gateTask.id} 复审通过`, // 复用门禁验收标准作为修复目标
    prompt,
  };

  // 修复任务是门禁的真实前置：必须插在门禁原位置之前，不能 push 到队尾让后续任务越过。
  // insertPrerequisiteTask 先在副本上校验完整图，失败不会留下半次 mutation。
  // allowedTargetStatuses=['blocked']：只允许回退 blocked 的门禁（其他状态说明并发写者已推进）。
  const inserted = insertPrerequisiteTask(state, {
    targetId: gateTask.id,
    task: fix,
    allowedTargetStatuses: ['blocked'],
  });
  const gate = inserted.target;
  gate.status = 'pending'; // 回退门禁待复审
  gate.exec = gate.exec || {};
  delete gate.exec.startedAt;
  delete gate.exec.completedAt;
  gate.exec.recheck = recheck; // 保留 verdict（供下一轮复审参考），仅递增 recheck
  return fixId;
}

/**
 * 锁内重新读取并派生 gate fix，避免 handleGateCompletion 的 load→save 覆盖并发状态。
 * expectedFixId 充当轻量 CAS：调用方生成 prompt 后若 gate 已被其他写者推进，本次 no-op。
 *
 * 与 spawnGateFixTask（纯 mutate、外部负责写盘）的分工：本函数把「读 + 判 + 改 + 写」整体放进
 * updateStateSync 的锁临界区，因此锁内读到的一定是最新 state，无需调用方自己 load/save。
 * 结果通过闭包变量 outcome 带出（mutator 的返回值语义被 updateStateSync 占用为「是否写盘」，
 * 不能直接当结果用——但这里恰好也用同一个对象）。
 *
 * @param {string} projectRoot
 * @param {string} gateId 门禁任务 id
 * @param {string} prompt 已生成的修复任务提示词
 * @param {string} [expectedFixId] 期望的派生 id；提供时若与实际 meta.fixId 不符则放弃（CAS）
 * @returns {{ fixId: string, recheck: number } | null} 派生成功返回元数据；未派生（条件不符或 CAS 失败）返回 null
 */
export function spawnGateFixTaskAtomic(projectRoot, gateId, prompt, expectedFixId) {
  const statePath = path.join(projectRoot, STATE_FILE);
  let outcome = null;
  updateStateSync({
    statePath,
    lockPath: stateLockPath(projectRoot),
    mutator: (state) => {
      const gate = state.tasks?.find((task) => task.id === gateId);
      const meta = gateFixMeta(gate);
      // meta 为空（不可派生）或 CAS 不符 → 返回 false：updateStateSync 不写盘，状态原样
      if (!meta || (expectedFixId && meta.fixId !== expectedFixId)) return false;
      const fixId = spawnGateFixTask(state, gate, prompt);
      if (!fixId) return false;
      outcome = { fixId, recheck: meta.recheck };
      return outcome; // 非 false → 触发落盘（state 已被 spawnGateFixTask 就地改好）
    },
  });
  return outcome;
}

// ── 快照备份 ──

/**
 * 将当前 state.json 快照到 .awf/versions/<version>-<timestamp>.json
 * 仅在 run 所有 tasks 完成后调用（宿主收尾）。
 *
 * 边界：state 缺失或没有 version 字段 → 直接返回（不产生空快照）。
 * 注意这里是唯一走裸 fs.writeFileSync 的地方（非原子写）：目标名带时间戳、每次新建，
 * 不会有并发写者覆盖同一文件，故无需临时文件 + rename。
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

/**
 * plan 启动守卫（T1-104）：若存在含残留内容的旧 state（且非 run/pause 运行生命周期），
 * 先把当前 state 原样归档到 .awf/versions/state-<ts>.json，再把当前文件重置为「空 plan 模板」
 * （mode=plan + 空 tasks/wbs/milestones/plan），让新 plan 会话从空板开始。
 *   - run/pause 模式 → 不触发（{ action: 'run-active' }）
 *   - 空 state（模板或无语义内容）→ 不重复归档（{ action: 'none' }）
 * 锁内原子完成归档 + 重置（单写语义，与 run 域写一致）。
 *
 * 为何要守卫：awf plan 直接覆盖 state.json 会丢失上一轮 plan 的成果，故先归档再重置。
 * run/pause 下不动手：说明有 run 生命周期正在使用当前 state，plan 不该介入。
 * 归档文件名前缀用 `state-`（区别于 backupState 的 `<version>-`），语义是「被 plan 顶掉的旧档」。
 * @param {string} projectRoot
 * @returns {{ action: 'none'|'run-active'|'archived', archivedPath?: string }}
 */
export function archiveOldStateForPlan(projectRoot) {
  const filePath = path.join(projectRoot, STATE_FILE);
  const cur = readJsonSync(filePath);
  if (!cur) return { action: 'none' };
  if (cur.mode === 'run' || cur.mode === 'pause') return { action: 'run-active' };

  // 只要任一维度（tasks/wbs/plan/milestones）有内容就认为「有残留」需要归档；
  // wbs 兼容数组与对象两种历史形态（否则老 state 会被误判为空板）。
  const hasContent =
    (Array.isArray(cur.tasks) && cur.tasks.length > 0) ||
    (Array.isArray(cur.wbs) && cur.wbs.length > 0) ||
    (cur.wbs && typeof cur.wbs === 'object' && !Array.isArray(cur.wbs) && Object.keys(cur.wbs).length > 0) ||
    (cur.plan && typeof cur.plan === 'object' && Object.keys(cur.plan).length > 0) ||
    (Array.isArray(cur.milestones) && cur.milestones.length > 0);
  if (!hasContent) return { action: 'none' };

  const dir = path.join(projectRoot, '.awf', 'versions');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const archivedPath = path.join(dir, `state-${ts}.json`);
  // 重置模板保留 version（版本连续性），清空内容维度；currentState 归到 PLAN
  const reset = {
    mode: 'plan',
    currentState: 'PLAN',
    version: cur.version,
    milestones: [],
    tasks: [],
    wbs: [],
    plan: {},
    lastUpdated: new Date().toISOString(),
  };
  // 归档 + 重置在同一把 state.lock 内完成：中途失败不会出现「归档了但没重置」的半态
  withStateLock(stateLockPath(projectRoot), () => {
    fs.mkdirSync(dir, { recursive: true });
    writeJsonAtomicSync(archivedPath, cur);
    writeJsonAtomicSync(filePath, reset);
  });
  return { action: 'archived', archivedPath };
}
