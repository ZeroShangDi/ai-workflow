import { describe, it, expect } from 'vitest';
import {
  DECISION_REQUIRED_RE,
  endsWithDecisionRequired,
  deferredFallbackResult,
  buildCompletedRecord,
  createDecisionSeq,
  classifyStop,
  classifyAskQuestion,
} from '../../src/server/decision-gate.cjs';

// 决策闸门规则归位（W1-032）：标记/分类/记录构造纯逻辑。

describe('标记检测', () => {
  it('endsWithDecisionRequired：末尾含 <AWF_DECISION_REQUIRED>…</…>', () => {
    expect(endsWithDecisionRequired('x\n<AWF_DECISION_REQUIRED>问题</AWF_DECISION_REQUIRED>')).toBe(true);
    expect(endsWithDecisionRequired('普通文本')).toBe(false);
    expect(endsWithDecisionRequired('<AWF_DECISION_REQUIRED>a</AWF_DECISION_REQUIRED> 尾巴')).toBe(false);
  });

  it('DECISION_REQUIRED_RE 导出可复用', () => {
    expect(DECISION_REQUIRED_RE.test('<AWF_DECISION_REQUIRED>x</AWF_DECISION_REQUIRED>')).toBe(true);
  });
});

describe('classifyStop — 闸门三分支', () => {
  it('gate 关 → complete', () => {
    expect(classifyStop({ enabled: false, text: 'x', deciding: false }).branch).toBe('complete');
  });

  it('gate 开 & 非 deciding & 末尾标签且非 stop_hook_active → deciding；否则 complete', () => {
    const req = 'x\n<AWF_DECISION_REQUIRED>q</AWF_DECISION_REQUIRED>';
    expect(classifyStop({ enabled: true, text: req, deciding: false, stopHookActive: false }).branch).toBe('deciding');
    expect(classifyStop({ enabled: true, text: req, deciding: false, stopHookActive: true }).branch).toBe('complete');
    expect(classifyStop({ enabled: true, text: 'plain', deciding: false }).branch).toBe('complete');
  });

  it('gate 开 & deciding → resolve', () => {
    expect(classifyStop({ enabled: true, text: 'x', deciding: true }).branch).toBe('resolve');
  });
});

describe('classifyAskQuestion — PreToolUse 决策化', () => {
  const questions = [{ multiSelect: false, question: 'Q?', options: [{ label: 'A' }] }];
  it('gate 关 → capture（含 question）', () => {
    const a = classifyAskQuestion({ enabled: false, deciding: false, questions });
    expect(a.kind).toBe('capture');
    expect(a.question.question).toBe('Q?');
  });

  it('gate 开 & deciding → deny_deciding；非 deciding → deny_gate', () => {
    expect(classifyAskQuestion({ enabled: true, deciding: true, questions }).kind).toBe('deny_deciding');
    const g = classifyAskQuestion({ enabled: true, deciding: false, questions });
    expect(g.kind).toBe('deny_gate');
    expect(g.output.ccOutput.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('无 questions → capture(null)', () => {
    expect(classifyAskQuestion({ enabled: true, deciding: false, questions: [] }).kind).toBe('capture');
  });
});

describe('deferredFallbackResult / buildCompletedRecord / createDecisionSeq', () => {
  it('deferred fallback 带 fallback=true', () => {
    expect(deferredFallbackResult().fallback).toBe(true);
  });

  it('buildCompletedRecord 组装 decision_completed 记录', () => {
    const record = buildCompletedRecord({ decisionId: 'D-1', result: { answer: 'a', type: 'resolved', fallback: false }, source: 'text', createdAt: 't' });
    expect(record.event).toBe('decision_completed');
    expect(record.decision_id).toBe('D-1');
    expect(record.fallback).toBe(false);
    expect(record.source).toBe('text');
  });

  it('createDecisionSeq id 唯一递增', () => {
    const seq = createDecisionSeq();
    const a = seq.nextId();
    const b = seq.nextId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^D-/);
  });
});
