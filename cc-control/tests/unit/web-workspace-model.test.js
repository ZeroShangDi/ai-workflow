import { describe, it, expect } from 'vitest';
import { aggregateDecisions, mergeEvents } from '../../web/src/views/workspace-model.js';
describe('workspace current server projections', () => {
  it('joins nested decision results and overrides without combining different run stamps', () => {
    const rows = aggregateDecisions([
      { runStamp: 'one', decision_id: 'D1', event: 'decision_requested', status: 'awaiting_human' },
      { runStamp: 'one', decision_id: 'D1', event: 'decision_completed', status: 'reviewed', result: { answer: 'approved' } },
      { runStamp: 'one', decision_id: 'D1', event: 'decision_overridden', instruction: 'replace' },
      { runStamp: 'two', decision_id: 'D1', answer: 'legacy' },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: 'overridden', answer: 'approved', instruction: 'replace', completed: true });
    expect(rows[0].records).toHaveLength(3);
    expect(rows[1].answer).toBe('legacy');
  });
  it('deduplicates repeated event pages and retains sequence order', () => {
    expect(mergeEvents([{ seq: 2 }, { seq: 1 }], [{ seq: 2 }, { seq: 3 }]).map(e => e.seq)).toEqual([1, 2, 3]);
  });
});
