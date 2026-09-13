import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createContextCompactor, COMPACTION } = require('../../server/features/context/compaction.cjs');

// 上下文压缩检查的**协议**（两层判定 / 保守跳过 / 清会话注入）——
// 它是端口全注入的纯模块，协议用单测钉；真机 case（tests/e2e/cases/context-compaction）只验
// 「它在真实链路里不挡路」：真实的第二层需要把上下文堆到 80% 以上，真机造不出来
// （statusline 会不停用实测值覆盖 usage.json）。

/** 端口替身：记录调用，按脚本返回 */
function harness({ pct = null, ready = false, snapshot = null } = {}) {
  const calls = [];
  const compactor = createContextCompactor({
    send: async (text) => { calls.push(['send', text]); },
    prompts: { contextCheck: async (usage) => `CONTEXT_CHECK<${usage}>` },
    readUsagePct: async () => pct,
    readHandoffSnapshot: async () => snapshot,
    consumeContextReady: () => ready,
    clearSession: async () => { calls.push(['clear']); },
    log: () => {},
  });
  return { compactor, calls };
}

describe('server · 上下文压缩检查（两层判定）', () => {
  it('前 N 个任务直接跳过（首个任务上下文必然干净）', async () => {
    const { compactor, calls } = harness({ pct: 99 });
    expect(await compactor.maybeCompact('P', 1)).toBe('P');   // taskIndex <= skipFirstCount
    expect(calls).toHaveLength(0);
  });

  it('第一层：有实测且低于阈值 → 不打扰 AI，原样放行', async () => {
    const { compactor, calls } = harness({ pct: COMPACTION.checkThreshold - 1 });
    expect(await compactor.maybeCompact('P', 2)).toBe('P');
    expect(calls).toHaveLength(0); // 一次 send 都没有
  });

  it('第二层：越过阈值 → 发检查提示词；AI 没标 ready（判无需压缩）→ 原样放行', async () => {
    const { compactor, calls } = harness({ pct: COMPACTION.checkThreshold + 5, ready: false });
    expect(await compactor.maybeCompact('P', 2)).toBe('P');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toContain('CONTEXT_CHECK');
    expect(calls.some(([op]) => op === 'clear')).toBe(false);
  });

  it('无实测（null）也进第二层（交 AI 自行估算）', async () => {
    const { compactor, calls } = harness({ pct: null });
    await compactor.maybeCompact('P', 2);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toContain('未知');
  });

  it('AI 标记 ready 且快照可读 → 清会话并把快照前置到任务提示词', async () => {
    const { compactor, calls } = harness({ pct: 90, ready: true, snapshot: 'SNAPSHOT-BODY' });
    const out = await compactor.maybeCompact('TASK', 2);
    expect(calls.map(([op]) => op)).toEqual(['send', 'clear']);
    expect(out).toContain('SNAPSHOT-BODY');
    expect(out).toContain('TASK');
    expect(out.indexOf('SNAPSHOT-BODY')).toBeLessThan(out.indexOf('TASK'));
  });

  it('AI 标记 ready 但快照不可读 → 保守跳过：绝不清会话（清空却不注入比不压缩更糟）', async () => {
    const { compactor, calls } = harness({ pct: 90, ready: true, snapshot: null });
    expect(await compactor.maybeCompact('TASK', 2)).toBe('TASK');
    expect(calls.some(([op]) => op === 'clear')).toBe(false);
  });
});
