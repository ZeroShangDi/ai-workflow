import { describe, it, expect } from 'vitest';
import { STAGE_CHAINS, classifyComplexity, decideChain, nextStage, assertStage, gateCompletionHook } from '../../src/server/run-driver.cjs';

// 单 agent 阶段链驱动（W1-035 纯规则层）：阶段序/复杂度/链推进。

describe('STAGE_CHAINS / decideChain', () => {
  it('三级链定义符合文档', () => {
    expect(STAGE_CHAINS.simple).toEqual(['DEV', 'COMMIT']);
    expect(STAGE_CHAINS.medium).toEqual(['DEV', 'TEST', 'COMMIT']);
    expect(STAGE_CHAINS.complex).toEqual(['DEV', 'DOCS', 'REVIEW', 'TEST', 'COMMIT']);
  });

  it('review/test/doc/commit 门禁类 → 保守 simple 链', () => {
    for (const kind of ['review', 'test', 'doc', 'commit']) {
      expect(decideChain({ kind }).chain).toBe('simple');
    }
  });

  it('dev 按计划改动面/依赖/约束分级', () => {
    const small = decideChain({ kind: 'dev', plannedFiles: ['a.js'] });
    const big = decideChain({ kind: 'dev', plannedFiles: ['a', 'b', 'c', 'd', 'e'], deps: ['T1', 'T2'], constraints: ['c'] });
    expect(small.chain).toBe('simple');
    expect(big.chain).toBe('complex');
  });
});

describe('classifyComplexity', () => {
  it('缺省空任务 → simple；高分 → complex', () => {
    expect(classifyComplexity({})).toBe('simple');
    expect(classifyComplexity({ plannedFiles: new Array(4), deps: ['x'], constraints: ['y'] })).toBe('complex');
  });
});

describe('nextStage / assertStage', () => {
  it('推进链并结尾返回 null', () => {
    const { stages } = decideChain({ kind: 'dev', plannedFiles: ['a.js'] }); // simple
    expect(nextStage(stages, 'DEV')).toBe('COMMIT');
    expect(nextStage(stages, 'COMMIT')).toBeNull();
  });

  it('assertStage 拒绝链外阶段；nextStage 对非法阶段抛错', () => {
    const { stages } = decideChain({ kind: 'dev', plannedFiles: ['a'] });
    expect(() => assertStage(stages, 'DOCS')).toThrowError(/非法/);
    expect(() => nextStage(stages, 'DOCS')).toThrowError(/不在链/);
  });
});

describe('gateCompletionHook — 门禁闭环链入 driver', () => {
  it('仅对 review/test 委托 handleGateCompletion；dev 不触发', async () => {
    const calls = [];
    const hook = gateCompletionHook('/p', { handleGateCompletion: (root, id, task) => { calls.push([root, id, task.kind]); return Promise.resolve(); } });
    await hook('T2-001', { kind: 'review' });
    await hook('T3-001', { kind: 'test' });
    await hook('T1-001', { kind: 'dev' });
    expect(calls).toEqual([['/p', 'T2-001', 'review'], ['/p', 'T3-001', 'test']]);
  });

  it('未注入 handleGateCompletion → 直接 false', async () => {
    const hook = gateCompletionHook('/p', {});
    expect(await hook('T2-001', { kind: 'review' })).toBe(false);
  });
});
