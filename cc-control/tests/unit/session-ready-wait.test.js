import { describe, it, expect } from 'vitest';
import { waitSessionStarted } from '../../src/cli/run.js';

// 会话就绪等待（2026-09-10 dual-b 现场）：派发前必须确认 SessionStart 已到达，
// 否则任务文本可能被打进尚未消除的文件夹信任弹窗而丢弃。

const ctx = { runSessionName: 'cc-test' };

describe('waitSessionStarted — 等 SessionStart 到达才放行派发', () => {
  it('sessionSeq 增长 → 放行，且不补 Enter', async () => {
    const nudges = [];
    let calls = 0;
    const ok = await waitSessionStarted(ctx, '/p', 2, {
      status: async () => ({ sessionSeq: (calls++ === 0 ? 2 : 3) }),
      nudge: () => nudges.push(1),
      sleepFn: async () => {},
      timeoutMs: 1000,
    });
    expect(ok).toBe(true);
    expect(nudges).toHaveLength(0);
  });

  it('始终未收到 SessionStart → 超时返回 false（告警放行，不硬失败）', async () => {
    const ok = await waitSessionStarted(ctx, '/p', 5, {
      status: async () => ({ sessionSeq: 5 }),
      nudge: () => {},
      sleepFn: async () => new Promise((r) => setTimeout(r, 1)),
      timeoutMs: 50,
    });
    expect(ok).toBe(false);
  });

  it('等待期间周期性补 Enter（兜住 claude 起得慢时仍挂着的信任弹窗）', async () => {
    const nudges = [];
    await waitSessionStarted(ctx, '/p', 0, {
      status: async () => ({ sessionSeq: 0 }),
      nudge: () => nudges.push(Date.now()),
      sleepFn: async () => new Promise((r) => setTimeout(r, 1)),
      timeoutMs: 60,
      nudgeMs: 5,
    });
    expect(nudges.length).toBeGreaterThanOrEqual(1);
  });

  it('拿不到 status（服务不可达）不抛，按未就绪处理', async () => {
    const ok = await waitSessionStarted(ctx, '/p', 0, {
      status: async () => null,
      nudge: () => {},
      sleepFn: async () => {},
      timeoutMs: 0,
    });
    expect(ok).toBe(false);
  });
});
