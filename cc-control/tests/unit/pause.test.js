import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const m = vi.hoisted(() => ({
  loadState: vi.fn(),
  sleep: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/lib/state.js', () => ({ loadState: m.loadState }));
vi.mock('../../src/lib/session/client.js', () => ({ sleep: m.sleep }));

import { isWorkflowPaused, waitWhilePaused, formatWait } from '../../src/lib/pause.js';

/**
 * pause 闩锁（T1-111）。
 *
 * 除「暂停期间不返回、恢复后放行」外，本轮新增两件事都要在这里锁死：
 *   ① 可观测：超阈值告警（含项目根与阶段）+ 周期心跳 + 放行日志；
 *   ② 目标结算即放行：等待期间目标任务 done/blocked → 立刻返回，不必等 mode 恢复
 *      （2026-09-10 事故：宿主卡在 settleTask 的 send 里，任务早已 done 却看不见，停摆 4 小时）。
 * 时间用可控 Date.now + sleep 累加推进，不依赖真实时钟。
 */
describe('pause 闩锁', () => {
  let now = 0;
  let logs;

  beforeEach(() => {
    now = 0;
    logs = [];
    m.loadState.mockReset();
    m.sleep.mockReset();
    m.sleep.mockImplementation(async (ms) => { now += ms; });
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const log = (level, msg) => logs.push({ level, msg });
  const OPTS = { pollMs: 25, alertMs: 100, heartbeatMs: 200, log, label: 'settle:T1' };

  it('mode=pause 时返回暂停', () => {
    m.loadState.mockReturnValue({ mode: 'pause' });
    expect(isWorkflowPaused('/tmp/proj')).toBe(true);
  });

  it('未暂停 → 立即放行，不算等待、不打日志', async () => {
    m.loadState.mockReturnValue({ mode: 'run' });
    const r = await waitWhilePaused('/tmp/proj', OPTS);
    expect(r).toEqual({ waited: false, releasedBy: null, waitedMs: 0, polls: 0 });
    expect(m.sleep).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it('持续等待到 mode 恢复为 run → releasedBy=resumed，并打一条放行日志', async () => {
    m.loadState
      .mockReturnValueOnce({ mode: 'pause' })
      .mockReturnValueOnce({ mode: 'pause' })
      .mockReturnValueOnce({ mode: 'run' });

    const r = await waitWhilePaused('/tmp/proj', OPTS);

    expect(r.releasedBy).toBe('resumed');
    expect(r.waited).toBe(true);
    expect(m.sleep).toHaveBeenCalledTimes(2);
    expect(m.sleep).toHaveBeenNthCalledWith(1, 25);
    expect(logs).toHaveLength(1);
    expect(logs[0].msg).toContain('mode 已恢复');
    expect(logs[0].msg).toContain('/tmp/proj');
    expect(logs[0].msg).toContain('settle:T1');
  });

  it('等待期间目标任务已结算 → 立即放行，不必等 mode 恢复', async () => {
    m.loadState.mockReturnValue({ mode: 'pause' }); // mode 一直是 pause
    let polls = 0;
    const r = await waitWhilePaused('/tmp/proj', {
      ...OPTS,
      isSettled: () => { polls += 1; return polls > 2; }, // 第 3 次轮询时「任务结算了」
    });

    expect(r.releasedBy).toBe('settled');
    expect(m.loadState.mock.calls.length).toBeLessThan(6); // 没有一直等到 mode 变
    expect(logs.some((l) => l.msg.includes('目标任务已结算'))).toBe(true);
  });

  it('isSettled 为真时不注入任何东西（releasedBy=settled 优先于 resumed）', async () => {
    m.loadState.mockReturnValue({ mode: 'pause' });
    const r = await waitWhilePaused('/tmp/proj', { ...OPTS, isSettled: () => true });
    expect(r.releasedBy).toBe('settled');
    expect(r.waitedMs).toBe(25);
  });

  it('超过阈值打一次告警（含项目根与阶段），之后每 heartbeatMs 一条心跳，且告警不重复', async () => {
    // 一直暂停：跑够 1 次告警 + 2 次心跳的时长
    m.loadState.mockReturnValue({ mode: 'pause' });
    let elapsed = 0;
    await waitWhilePaused('/tmp/proj', {
      ...OPTS,
      isSettled: () => { elapsed += 25; return elapsed > 900; }, // 900ms 后放行
    });

    const alerts = logs.filter((l) => l.msg.includes('pause 闩锁已挂起'));
    const beats = logs.filter((l) => l.msg.includes('pause 闩锁心跳'));
    expect(alerts).toHaveLength(1); // 告警只打一次
    expect(alerts[0].level).toBe('error');
    expect(alerts[0].msg).toContain('/tmp/proj');
    expect(alerts[0].msg).toContain('settle:T1');
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats[0].msg).toContain('仍在等待');
  });

  it('告警阈值内的短暂暂停不打告警（不制造噪音）', async () => {
    m.loadState
      .mockReturnValueOnce({ mode: 'pause' })
      .mockReturnValueOnce({ mode: 'run' });
    await waitWhilePaused('/tmp/proj', OPTS); // alertMs=100，只等了一轮=25ms
    expect(logs.some((l) => l.msg.includes('已挂起'))).toBe(false);
    expect(logs).toHaveLength(1); // 仅放行日志
  });

  it('formatWait 人类可读', () => {
    expect(formatWait(800)).toBe('800ms');
    expect(formatWait(45_000)).toBe('45s');
    expect(formatWait(3_725_000)).toBe('62min05s');
  });
});
