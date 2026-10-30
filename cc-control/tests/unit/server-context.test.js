import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createContextCompactor, COMPACTION } = require('../../server/features/context/compaction.cjs');

/** 造一个记录调用的 compactor 环境 */
function makeEnv({ pct = null, snapshot = null, readyAfterCheck = true } = {}) {
  const calls = [];
  const compactor = createContextCompactor({
    send: async (text) => { calls.push(['send', text]); },
    prompts: { contextCheck: async (usage) => { calls.push(['contextCheck', usage]); return `CHECK(${usage})`; } },
    readUsagePct: async () => pct,
    readHandoffSnapshot: async () => snapshot,
    consumeContextReady: () => { calls.push(['consumeReady']); return readyAfterCheck; },
    clearSession: async () => { calls.push(['clear']); },
    log: (level, msg) => calls.push(['log', level, msg]),
  });
  return { compactor, calls, has: (name) => calls.some((c) => c[0] === name) };
}

describe('context · 任务前压缩检查', () => {
  it('首个任务跳过（上下文必然干净，不打扰 AI）', async () => {
    const env = makeEnv({ pct: 99 });
    const out = await env.compactor.maybeCompact('原始 prompt', 1);
    expect(out).toBe('原始 prompt');
    expect(env.calls.length).toBe(0);
  });

  it('有实测且低于阈值 → 不打扰 AI', async () => {
    const env = makeEnv({ pct: COMPACTION.checkThreshold - 10 });
    const out = await env.compactor.maybeCompact('原始 prompt', 2);
    expect(out).toBe('原始 prompt');
    expect(env.has('contextCheck')).toBe(false);
  });

  it('越过阈值且 AI 写了快照 → /clear 并注入快照前缀', async () => {
    const env = makeEnv({ pct: COMPACTION.checkThreshold + 5, snapshot: '## 交接\n做完了 A' });
    const out = await env.compactor.maybeCompact('原始 prompt', 2);
    expect(env.has('contextCheck')).toBe(true);
    expect(env.has('clear')).toBe(true);
    expect(out).toContain('【上下文快照】');
    expect(out).toContain('做完了 A');
    expect(out).toContain('原始 prompt'); // 原任务 prompt 仍带在快照之后
  });

  it('AI 未就绪（consumeContextReady=false）→ 原样返回，不清会话', async () => {
    const env = makeEnv({ pct: 99, readyAfterCheck: false });
    const out = await env.compactor.maybeCompact('原始 prompt', 2);
    expect(out).toBe('原始 prompt');
    expect(env.has('clear')).toBe(false);
  });

  it('快照不可读 → 保守跳过（清空却不注入比保留旧上下文更糟）', async () => {
    const env = makeEnv({ pct: 99, snapshot: null });
    const out = await env.compactor.maybeCompact('原始 prompt', 2);
    expect(out).toBe('原始 prompt');
    expect(env.has('clear')).toBe(false);
    expect(env.calls.some((c) => c[0] === 'log' && c[1] === 'warn')).toBe(true);
  });

  it('无实测占用（statusline 未配置）→ 仍触发检查，让 AI 自行估算', async () => {
    const env = makeEnv({ pct: null, snapshot: '## 交接\nB' });
    const out = await env.compactor.maybeCompact('原始 prompt', 2);
    expect(env.has('contextCheck')).toBe(true);
    // 提示词里应带「自行估算」的措辞
    const checkCall = env.calls.find((c) => c[0] === 'contextCheck');
    expect(String(checkCall[1])).toContain('自行估算');
    expect(out).toContain('【上下文快照】');
  });
});
