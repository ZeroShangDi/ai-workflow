'use strict';
/**
 * cc-shapes.cjs — Claude Code 回写形状构造（ccOutput/block/permissionDecision/AskUserQuestion）
 *
 * server 回给 Claude 的 hook ccOutput 形状（decision block + continuePrompt、permissionDecision
 * deny + updatedInput.questions 清空等）集中在此 adapter，避免在决策/门禁逻辑里散拼 cc 字面。
 * 决策/权限判断仍属领域（decision-gate/interact），此处只管「cc 回写形状」。
 */

/** Stop 闸门 block：要求当前会话产出决策结果（decision: block + continuePrompt 指令） */
function blockDecision(continuePrompt) {
  return { ccOutput: { decision: 'block', continuePrompt } };
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
