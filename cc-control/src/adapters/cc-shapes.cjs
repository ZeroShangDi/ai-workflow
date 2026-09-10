'use strict';
/**
 * cc-shapes.cjs — Claude Code 回写形状构造（ccOutput/block/permissionDecision/AskUserQuestion）
 *
 * server 回给 Claude 的 hook ccOutput 形状（Stop block + reason、permissionDecision deny +
 * updatedInput.questions 清空等）集中在此 adapter，避免在决策/门禁逻辑里散拼 cc 字面。
 * 决策/权限判断仍属领域（decision-gate/interact），此处只管「cc 回写形状」。
 */

/**
 * Stop 闸门 block：要求当前会话产出决策结果。
 *
 * 字段名必须是 `reason` —— Claude Code 的 Stop hook block 契约是 `{decision:'block', reason}`，
 * reason 即回灌给模型的继续指令。2026-09-10 真 run 回归暴露：此前用 `continuePrompt`，
 * Claude Code 不认该字段 → 模型只看到兜底文案「Blocked by hook」、收不到决策模式指令 →
 * 门阀停在 deciding、决策从未真正发生（单测按错字段断言，故一直全绿）。
 */
function blockDecision(reason) {
  return { ccOutput: { decision: 'block', reason } };
}

/** PreToolUse 权限 deny：拒绝工具并给原因，updatedInput.questions 清空（AskUserQuestion 处理） */
function denyPermission(reason, { updatedInput } = {}) {
  return {
    ccOutput: {
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
        updatedInput: updatedInput || { questions: [] },
      },
    },
  };
}

module.exports = { blockDecision, denyPermission };
