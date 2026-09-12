// src/server/gate-fix.js — 门禁闭环：fail 自动派生修复 + 复审回退（原 cli/gate-fix，T1-062 归位 server 侧）
//
// 门禁任务（kind=review/test）由子 Agent / 主会话完成时输出结构化 verdict
// （exec.verdict，见 plugin/core/agents/awf-worker.md）。CLI 检测
// 「blocked + verdict.level !== 'pass'」→ 派生修复任务（kind=dev）→ 门禁回退
// pending + deps 追加修复任务 → 修复完成门禁重新就绪复审 → 直到 pass 或达轮次上限
// （MAX_RECHECK，state.js 定义，超限保持 blocked 需人工介入）。
//
// 接线：
//  - 多 agent：runScheduler.onTaskComplete → 本模块
//  - 单 agent：driveSingle → settleTaskCompletion → 门禁锚点（driver.gateCompletionHook）
// 入口统一为 host 侧：单/多 agent 都经 run-driver.gateCompletionHook 收敛到本函数（见 run/host.cjs runGateHook）。
//
// 边界：本模块只做「幂等判定 + 派生修复任务」；读盘/写盘靠 core/state.js 的原子原语，
// 修复提示词靠插件模板（core/prompts.js），修复目标文案规则归 gate-loop.cjs。

import { loadState, spawnGateFixTaskAtomic, gateFixMeta, MAX_RECHECK } from '../core/state.js';
import { gateFixPrompt } from '../core/prompts.js';
import { buildFixTarget } from './gate-loop.cjs';

/**
 * 处理门禁完成：blocked + verdict 非 pass → 派生修复任务 + 回退门禁待复审。
 *
 * 幂等：gateFixMeta 判定不可派生（含已回退 pending）→ no-op；重复调用同一 id 时
 * `status !== 'blocked'` 直接 no-op（多 agent 下同 id 不会二次触发，此为防御）。
 * 提示词经插件模板（gate-fix）生成，CLI 只填任务 ID 与修复目标。
 *
 * @param {string} projectRoot
 * @param {string} id 门禁任务 id
 * @param {object} task 完成时的任务快照 — 仅用于 kind 快速过滤；
 *   status/verdict 以重新加载的 state 为准（多 agent 传入的是派发时快照，无 verdict）
 */
export async function handleGateCompletion(projectRoot, id, task) {
  if (!task) return;
  if (task.kind !== 'review' && task.kind !== 'test') return;

  const state = loadState(projectRoot);
  const gate = state?.tasks?.find((t) => t.id === id);
  if (!gate) return;
  const meta = gateFixMeta(gate);
  if (!meta) return;

  const v = gate.exec?.verdict; // 仅用于日志展示；能否派生的判定在 gateFixMeta / spawnGateFixTaskAtomic
  const fixTarget = buildFixTarget(gate); // verdict→修复目标规则归位 gate-loop
  const prompt = await gateFixPrompt({ fixId: meta.fixId, fixTarget });

  // 原子派生修复任务 + 回退门禁 pending + deps 串联。返回空可能是：已达复审上限（recheck≥MAX_RECHECK）
  // 或幂等 no-op（已派生过）；用 recheck 计数区分后给出对应日志结论。
  const applied = spawnGateFixTaskAtomic(projectRoot, id, prompt, meta.fixId);
  const fixId = applied?.fixId || null;
  if (fixId) {
    console.log(`[gate-fix] 门禁 ${id} ${v?.level} → 派生修复任务 ${fixId}，待复审`);
  } else if ((gate.exec?.recheck || 0) >= MAX_RECHECK) {
    console.warn(`[gate-fix] 门禁 ${id} 复审已达上限（${MAX_RECHECK}），保持 blocked，需人工介入`);
  }
}
