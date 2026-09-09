import { describe, it, expect } from 'vitest';
import { normalizeDecision, toDecisionsModel, decisionSummary } from '../../web/src/views/decisions-model.js';

// T1-088：Decisions 视图模型（决策列表 / override 判定）。

describe('Decisions 模型', () => {
  it('toDecisionsModel 归一决策列表（含 override 判定）', () => {
    const resp = {
      ok: true, total: 2,
      decisions: [
        { runStamp: 'r1', event: 'decision_completed', decision_id: 'D-1', answer: '选 B', type: 'resolved', finality: 'final' },
        { runStamp: 'r1', event: 'decision_overridden', decision_id: 'D-1', instruction: '改 C' },
      ],
    };
    const m = toDecisionsModel(resp);
    expect(m.total).toBe(2);
    const [d1, d2] = m.decisions;
    expect(d1.id).toBe('D-1');
    expect(d1.overridable).toBe(true);
    expect(d1.override).toBe(false);
    expect(d2.override).toBe(true);
    expect(d2.overridable).toBe(false);
  });

  it('decisionSummary：答案/兜底 摘要；无 id → 占位', () => {
    expect(decisionSummary({ id: 'D-1', answer: '选 B', fallback: true })).toBe('D-1（兜底） → 选 B');
    expect(decisionSummary({})).toBe('(无 decision_id)');
  });

  it('normalizeDecision 容忍 decisionId 字段', () => {
    expect(normalizeDecision({ decisionId: 'X1', answer: 1 }).id).toBe('X1');
  });
});
