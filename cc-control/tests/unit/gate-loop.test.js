import { describe, it, expect } from 'vitest';
import { buildFixTarget, verdictSummary } from '../../src/lib/gate-loop.cjs';

// 门禁闭环规则（W1-034）：verdict → 修复目标文案纯规则。

describe('buildFixTarget', () => {
  it('有报告文件 → 指向报告', () => {
    const gate = { id: 'T-R', exec: { files: ['.awf/reports/review.md', 'src/a.js'], verdict: { level: 'fail' } } };
    expect(buildFixTarget(gate)).toContain('修复门禁 T-R 报告 .awf/reports/review.md');
  });

  it('无报告 → 用 verdict conclusion/level', () => {
    const gate = { id: 'T-R', exec: { verdict: { level: 'changes_requested', conclusion: '有重复' } } };
    const t = buildFixTarget(gate);
    expect(t).toContain('修复门禁 T-R 判定中列出的问题');
    expect(t).toContain('有重复');
  });

  it('architecture 附注并入修复要求', () => {
    const gate = {
      id: 'T-R',
      exec: {
        verdict: { level: 'fail' },
        architecture: { changeAxis: 'x', boundary: 'b', path: 'refactor-then-change', note: '注意' },
      },
    };
    const t = buildFixTarget(gate);
    expect(t).toContain('变化轴=x');
    expect(t).toContain('期望边界=b');
    expect(t).toContain('路径=refactor-then-change');
    expect(t).toContain('注意');
  });

  it('verdictSummary：level + conclusion；无 level → null', () => {
    expect(verdictSummary({ exec: { verdict: { level: 'pass', conclusion: 'ok' } } })).toBe('pass：ok');
    expect(verdictSummary({ exec: {} })).toBeNull();
  });
});
