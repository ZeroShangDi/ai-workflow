import { describe, it, expect } from 'vitest';
import { blockDecision, denyPermission } from '../../src/adapters/cc-shapes.cjs';

describe('cc-shapes — cc 回写形状（block/permissionDecision/AskUserQuestion）', () => {
  it('blockDecision：ccOutput.decision=block + reason（Stop hook block 契约字段，必须叫 reason）', () => {
    expect(blockDecision('请产出决策')).toEqual({ ccOutput: { decision: 'block', reason: '请产出决策' } });
    // 回归守护：曾误用 continuePrompt，Claude Code 不认 → 模型收不到决策模式指令（2026-09-10 真 run）
    expect(blockDecision('x').ccOutput).not.toHaveProperty('continuePrompt');
  });

  it('denyPermission：permissionDecision deny + reason + questions 清空', () => {
    const out = denyPermission('原因');
    expect(out.ccOutput.hookSpecificOutput).toEqual({
      permissionDecision: 'deny',
      permissionDecisionReason: '原因',
      updatedInput: { questions: [] },
    });
  });

  it('denyPermission 可覆盖 updatedInput', () => {
    const out = denyPermission('r', { updatedInput: { questions: [{ q: 1 }] } });
    expect(out.ccOutput.hookSpecificOutput.updatedInput.questions).toEqual([{ q: 1 }]);
  });
});
