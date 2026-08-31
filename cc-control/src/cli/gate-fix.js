// src/cli/gate-fix.js — 门禁闭环：fail 自动派生修复 + 复审回退
//
// 门禁任务（kind=review/test）由子 Agent / 主会话完成时输出结构化 verdict
// （exec.verdict，见 plugin/core/agents/awf-worker.md）。CLI 检测
// 「blocked + verdict.level !== 'pass'」→ 派生修复任务（kind=dev）→ 门禁回退
// pending + deps 追加修复任务 → 修复完成门禁重新就绪复审 → 直到 pass 或达轮次上限
// （MAX_RECHECK，state.js 定义，超限保持 blocked 需人工介入）。
//
// 接线：
//  - 多 agent：runScheduler.onTaskComplete → 本模块（run-batch.js）
//  - 单 agent：runLoop 完成感知后（run.js）

import { loadState, saveState, spawnGateFixTask, gateFixMeta, MAX_RECHECK } from '../lib/state.js';
import { gateFixPrompt } from '../lib/plugin-bridge.js';
import { logStep } from '../lib/ui/log.js';

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

  const v = gate.exec?.verdict;
  const reportPath = (gate.exec?.files || []).find((f) => f.startsWith('.awf/reports/')) || '';
  const fixTarget = reportPath
    ? `修复门禁 ${gate.id} 报告 ${reportPath} 中列出的全部问题。`
    : `修复门禁 ${gate.id} 判定中列出的问题：${v?.conclusion || v?.level}。`;
  const prompt = await gateFixPrompt({ fixId: meta.fixId, fixTarget });

  const fixId = spawnGateFixTask(state, gate, prompt);
  saveState(projectRoot, state);
  if (fixId) {
    logStep('', 'ok', `门禁 ${id} ${v?.level} → 派生修复任务 ${fixId}，待复审`);
  } else if ((gate.exec?.recheck || 0) >= MAX_RECHECK) {
    logStep('', 'warn', `门禁 ${id} 复审已达上限（${MAX_RECHECK}），保持 blocked，需人工介入`);
  }
}
