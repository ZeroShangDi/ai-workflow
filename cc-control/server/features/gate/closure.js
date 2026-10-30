/**
 * gate/closure.js — 门禁闭环协议：fail → 派生修复 → 回退待复审，直到 pass 或达轮次上限
 *
 * ## 为什么在 features/gate，而不是 shared/state.js
 * 本文件每一条判据都是**门禁闭环自己定的规则** —— 非 review|test 不派生、verdict 缺失不派生、
 * verdict pass 不派生、recheck 达上限不派生；派生出来的任务长什么样（id `R1-F2`、kind=dev、
 * deps 继承、插在门禁之前、`source=gate_fix`）也全由门禁流程发明。换 CLI、改 state 布局都不动它，只有门禁流程改了才动。
 * `shared/state.js` 只留「锁哪个文件、锁内读改写、命中才原子写」这类**通用落账原语**（mutateState），
 * 领域规则由本文件自带。
 *
 * ## 接线
 *  - 多 agent：runScheduler.onTaskComplete → handleGateCompletion
 *  - 单 agent：driveSingle → settleTaskCompletion → 门禁锚点（driver.gateCompletionHook）
 *  单/多 agent 都经 run-driver.gateCompletionHook 收敛到 handleGateCompletion（见 run/host.cjs runGateHook）。
 *
 * ## 边界
 * 只做「判定 + 派生」；提示词由调用方经插件模板生成后传入（本文件不硬编码命令）；
 * 任务图的合法插入靠 shared/task-graph.cjs 的 insertPrerequisiteTask（先在副本上校验，失败不留半次 mutation）。
 */

import taskGraph from '../../shared/task-graph.cjs';
import { mutateState } from '../../shared/state.js';

const { insertPrerequisiteTask } = taskGraph;

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
 * 纯 mutate state，不写盘——由调用方（或 spawnGateFixTaskAtomic）负责落盘。
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
    // 任务来源，与 planner 的 `dynamic_planning` 同一个字段（不另开第二个来源字段）：
    // 缺省 = 来自初始规划，前端据此区分「原计划 / 门禁派生 / 动态规划」。
    source: 'gate_fix',
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
 * 通用部分（在锁内读最新 state、命中才原子写）归 shared/state.js 的 mutateState；
 * 本函数只带门禁规则与 CAS 判据。
 *
 * @param {string} projectRoot
 * @param {string} gateId 门禁任务 id
 * @param {string} prompt 已生成的修复任务提示词
 * @param {string} [expectedFixId] 期望的派生 id；提供时若与实际 meta.fixId 不符则放弃（CAS）
 * @returns {{ fixId: string, recheck: number } | null} 派生成功返回元数据；未派生（条件不符或 CAS 失败）返回 null
 */
export function spawnGateFixTaskAtomic(projectRoot, gateId, prompt, expectedFixId) {
  return mutateState(projectRoot, (state) => {
    const gate = state.tasks?.find((task) => task.id === gateId);
    const meta = gateFixMeta(gate);
    // 不可派生（meta 为空）或 CAS 不符 → 不写盘，state 原样
    if (!meta || (expectedFixId && meta.fixId !== expectedFixId)) return false;
    const fixId = spawnGateFixTask(state, gate, prompt);
    if (!fixId) return false;
    return { fixId, recheck: meta.recheck };
  });
}
