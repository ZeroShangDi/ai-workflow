import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const m = vi.hoisted(() => ({ loadState: vi.fn() }));

vi.mock('../../server/shared/state.js', () => ({ loadState: m.loadState }));

import { isWorkflowPaused, waitWhilePaused, formatWait, PAUSE_POLL_MS } from '../../server/features/pause/index.js';

/**
 * pause 闩锁（T1-111）。
 *
 * 随旧树退役重写：旧版靠 mock 掉 `src/lib/session/client.js` 的 `sleep` 来推进假时钟 ——
 * 新模块的 sleep 是**私有的**（server 不依赖 cli），也不接受 sleep 注入。故改为**真时钟 + 极小间隔**
 * （pollMs/alertMs/heartbeatMs 都可传），由 loadState 的返回值按真实时间驱动出口。
 *
 * 要锁死的三件事：
 *   ① 暂停期间不返回、mode 恢复后放行；
 *   ② 目标结算即放行（2026-09-10 事故：宿主卡在 settleTask 的 send 里，任务早已 done 却看不见，停摆 4h）；
 *   ③ 可观测：超阈值告警一次 + 周期心跳 + 放行日志，都带项目根与阶段。
 */

describe('pause 闩锁', () => {
  let logs;
  const log = (level, msg) => logs.push({ level, msg });

  beforeEach(() => {
    logs = [];
    m.loadState.mockReset();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('isWorkflowPaused：只有 mode=pause 算暂停', () => {
    m.loadState.mockReturnValue({ mode: 'pause' });
    expect(isWorkflowPaused('/tmp/proj')).toBe(true);
    m.loadState.mockReturnValue({ mode: 'run' });
    expect(isWorkflowPaused('/tmp/proj')).toBe(false);
    m.loadState.mockReturnValue(null); // state 读不到 → 不暂停
    expect(isWorkflowPaused('/tmp/proj')).toBe(false);
  });

  it('未暂停 → 立即放行，不算等待、不打日志', async () => {
    m.loadState.mockReturnValue({ mode: 'run' });
    const r = await waitWhilePaused('/tmp/proj', { pollMs: 5, log });
    expect(r).toEqual({ waited: false, releasedBy: null, waitedMs: 0, polls: 0 });
    expect(logs).toEqual([]);
  });

  it('mode 恢复为 run → releasedBy=resumed，并打一条放行日志', async () => {
    let calls = 0;
    // 第 1 次读是快路径（进函数时是否暂停）；之后每轮 sleep 后再读一次
    m.loadState.mockImplementation(() => (++calls <= 2 ? { mode: 'pause' } : { mode: 'run' }));
    const r = await waitWhilePaused('/tmp/proj', { pollMs: 5, log, label: 'settle:T1' });

    expect(r.releasedBy).toBe('resumed');
    expect(r.waited).toBe(true);
    expect(r.polls).toBe(2); // 第 2 个轮询点看到 mode 已恢复
    const release = logs.filter((l) => l.msg.includes('mode 已恢复'));
    expect(release).toHaveLength(1);
    expect(release[0].level).toBe('info');
    expect(release[0].msg).toContain('/tmp/proj');
    expect(release[0].msg).toContain('settle:T1');
  });

  it('目标已结算 → releasedBy=settled，**优先于**模式恢复（不用等 mode 改回来）', async () => {
    m.loadState.mockReturnValue({ mode: 'pause' }); // 一直暂停
    const r = await waitWhilePaused('/tmp/proj', { pollMs: 5, log, isSettled: () => true });

    expect(r.releasedBy).toBe('settled');
    expect(r.polls).toBe(1); // 第一个轮询点就放行
    const release = logs.filter((l) => l.msg.includes('目标任务已结算'));
    expect(release).toHaveLength(1);
    expect(release[0].level).toBe('warn');
  });

  it('挂起超阈值 → 告警一次（含项目根与阶段），之后走心跳，且告警不重复', async () => {
    const t0 = Date.now();
    // 暂停到"真实经过 120ms"为止 —— 覆盖 alertMs(30) 与至少一个 heartbeatMs(50)
    m.loadState.mockImplementation(() => (Date.now() - t0 < 120 ? { mode: 'pause' } : { mode: 'run' }));
    const r = await waitWhilePaused('/tmp/proj', { pollMs: 10, alertMs: 30, heartbeatMs: 50, log, label: 'dispatch:T2' });

    expect(r.releasedBy).toBe('resumed');
    const alerts = logs.filter((l) => l.msg.includes('pause 闩锁已挂起'));
    const beats = logs.filter((l) => l.msg.includes('pause 闩锁心跳'));
    expect(alerts).toHaveLength(1); // 只打一次
    expect(alerts[0].level).toBe('error');
    expect(alerts[0].msg).toContain('/tmp/proj');
    expect(alerts[0].msg).toContain('dispatch:T2');
    expect(beats.length).toBeGreaterThanOrEqual(1); // 长时间静默要有人报「还在等」
    expect(beats[0].level).toBe('warn');
  });

  it('缺省轮询间隔是 1s（不缓存 state，跨进程改动能被及时观察）', () => {
    expect(PAUSE_POLL_MS).toBe(1000);
  });

  it('formatWait：<1s 毫秒 / <1min 秒 / 更长 分秒（秒补零）', () => {
    expect(formatWait(500)).toBe('500ms');
    expect(formatWait(5000)).toBe('5s');
    expect(formatWait(62_000)).toBe('1min02s');
    expect(formatWait(600_000)).toBe('10min00s');
  });
});
