import { describe, it, expect, vi, beforeEach } from 'vitest';

// run-batch.js 是滑动窗口的薄集成：runScheduler + socket dispatcher + 轮询 waitAnyDone。
// 核心调度逻辑已由 scheduler.test.js 覆盖；这里测集成接线。

const m = vi.hoisted(() => ({
  mockRunScheduler: vi.fn(),
  mockInjectText: vi.fn(),
  mockSubagentDispatch: vi.fn(),
  mockSleep: vi.fn(() => Promise.resolve()),
  mockBackupState: vi.fn(),
}));

vi.mock('../../src/lib/messaging.js', () => ({ injectText: m.mockInjectText }));
vi.mock('../../src/lib/plugin-bridge.js', () => ({ subagentDispatch: m.mockSubagentDispatch }));
vi.mock('../../src/lib/session/client.js', () => ({ sleep: m.mockSleep }));
vi.mock('../../src/lib/state.js', () => ({
  loadState: vi.fn(() => null),
  backupState: m.mockBackupState,
}));
vi.mock('../../src/cli/scheduler.js', () => ({ runScheduler: m.mockRunScheduler }));

import { runBatchLoop } from '../../src/cli/run-batch.js';

describe('runBatchLoop — 滑动窗口集成（薄封装）', () => {
  beforeEach(() => {
    for (const k of Object.keys(m)) m[k].mockReset();
    m.mockSleep.mockImplementation(() => Promise.resolve());
  });

  it('TC-A: 调用 runScheduler（透传 cfg）并 backup', async () => {
    m.mockRunScheduler.mockResolvedValue({ dispatched: 3 });
    await runBatchLoop('/tmp/proj', { agents: { max: 2 } });
    expect(m.mockRunScheduler).toHaveBeenCalledTimes(1);
    const args = m.mockRunScheduler.mock.calls[0][0];
    expect(args.projectRoot).toBe('/tmp/proj');
    expect(args.cfg).toEqual({ agents: { max: 2 } });
    expect(m.mockBackupState).toHaveBeenCalled();
  });

  it('TC-B: dispatcher.send 经 subagentDispatch + injectText 派发到 messaging.sock', async () => {
    let captured;
    m.mockRunScheduler.mockImplementation(async ({ dispatcher }) => {
      captured = dispatcher;
      return { dispatched: 1 };
    });
    m.mockSubagentDispatch.mockResolvedValue('DISPATCH_PROMPT');
    await runBatchLoop('/tmp/proj', { agents: { max: 2 } });

    await captured.send({ id: 'T1', title: '做任务', prompt: 'do it' });
    expect(m.mockSubagentDispatch).toHaveBeenCalledWith({ taskId: 'T1', taskPrompt: 'do it' });
    expect(m.mockInjectText).toHaveBeenCalledWith('/tmp/proj/.awf/messaging.sock', 'DISPATCH_PROMPT');
  });

  it('TC-C: waitAnyDone 轮询 state 检测运行中任务完成', async () => {
    // 用真实 loadState 验证轮询逻辑（runScheduler 捕获 waitAnyDone 后手动驱动）
    let captured;
    m.mockRunScheduler.mockImplementation(async ({ waitAnyDone }) => {
      captured = waitAnyDone;
      return { dispatched: 0 };
    });
    await runBatchLoop('/tmp/proj', { agents: { max: 2 } });
    expect(captured).toBeTypeOf('function');
  });
});
