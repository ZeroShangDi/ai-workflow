import { describe, it, expect } from 'vitest';
import { blockDecision, denyPermission } from '../../src/adapters/cc-shapes.cjs';

describe('cc-shapes — cc 回写形状（block/permissionDecision/AskUserQuestion）', () => {
  it('blockDecision：ccOutput.decision=block + continuePrompt', () => {
    expect(blockDecision('请产出决策')).toEqual({ ccOutput: { decision: 'block', continuePrompt: '请产出决策' } });
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
