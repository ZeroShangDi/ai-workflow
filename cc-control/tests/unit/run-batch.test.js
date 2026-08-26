import { describe, it, expect, vi, beforeEach } from 'vitest';

// run-batch.js 依赖 mock（run.js 也 mock：run-batch 复用其辅助函数）
const m = vi.hoisted(() => ({
  mockLoadState: vi.fn(),
  mockSaveState: vi.fn(),
  mockSelectReadyBatch: vi.fn(() => []),
  mockIsMilestoneDone: vi.fn(() => true),
  mockBackupState: vi.fn(),
  mockHttpPostJson: vi.fn(),
  mockWaitForReady: vi.fn(),
  mockBatchDispatch: vi.fn(),
  mockBatchReconcile: vi.fn(),
  mockMaybeCompactContext: vi.fn((p) => Promise.resolve(p)),
  mockHandleDecision: vi.fn(),
  mockSendPrompt: vi.fn(),
  mockMarkTaskBlocked: vi.fn(),
  mockGetTaskStatus: vi.fn(),
  mockLogBanner: vi.fn(),
  mockLogPrompt: vi.fn(),
  mockLogStep: vi.fn(),
  mockCreateSpinner: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock('../../src/lib/state.js', () => ({
  loadState: m.mockLoadState,
  saveState: m.mockSaveState,
  selectReadyBatch: m.mockSelectReadyBatch,
  isMilestoneDone: m.mockIsMilestoneDone,
  backupState: m.mockBackupState,
}));

vi.mock('../../src/lib/session/client.js', () => ({
  httpPostJson: m.mockHttpPostJson,
  waitForReady: m.mockWaitForReady,
  SERVER_PORT: 8787,
}));

vi.mock('../../src/lib/plugin-bridge.js', () => ({
  batchDispatch: m.mockBatchDispatch,
  batchReconcile: m.mockBatchReconcile,
}));

vi.mock('../../src/cli/run.js', () => ({
  maybeCompactContext: m.mockMaybeCompactContext,
  handleDecision: m.mockHandleDecision,
  sendPrompt: m.mockSendPrompt,
  markTaskBlocked: m.mockMarkTaskBlocked,
  getTaskStatus: m.mockGetTaskStatus,
  logBanner: m.mockLogBanner,
  logPrompt: m.mockLogPrompt,
}));

vi.mock('../../src/lib/ui/log.js', () => ({ logStep: m.mockLogStep }));
vi.mock('../../src/lib/ui/spinner.js', () => ({ createSpinner: m.mockCreateSpinner }));

import { runBatchLoop } from '../../src/cli/run-batch.js';

const CFG = { agents: { max: 9, maxModules: 3, maxPerModule: 3, maxPerFeature: 1 } };

describe('runBatchLoop — 多 agent 批次循环（与单任务 runLoop 隔离）', () => {
  beforeEach(() => {
    for (const k of Object.keys(m)) m[k].mockReset();
    m.mockMaybeCompactContext.mockImplementation((p) => Promise.resolve(p));
    m.mockIsMilestoneDone.mockReturnValue(true);
    m.mockSelectReadyBatch.mockReturnValue([]);
    m.mockWaitForReady.mockResolvedValue();
    m.mockHttpPostJson.mockResolvedValue({ ok: true });
  });

  it('TC-A: 选一批 → 发一次 /send（batchDispatch 结果）→ 全部完成 → backup + 结束', async () => {
    const state = { currentState: 'CODE', tasks: [
      { id: 'T1', status: 'active' }, { id: 'T2', status: 'active' },
    ] };
    m.mockLoadState.mockReturnValue(state);
    m.mockSelectReadyBatch
      .mockReturnValueOnce([
        { id: 'T1', title: '做 A', kind: 'dev', prompt: 'p1' },
        { id: 'T2', title: '做 B', kind: 'dev', prompt: 'p2' },
      ])
      .mockReturnValueOnce([]);
    m.mockGetTaskStatus.mockReturnValue('done');
    m.mockBatchDispatch.mockResolvedValue('BATCH_PROMPT');

    await runBatchLoop('/tmp/proj', CFG);

    expect(m.mockSelectReadyBatch).toHaveBeenCalledTimes(2);
    // 批次派发：tasks 数组传给 batchDispatch，/send 只发一次
    expect(m.mockBatchDispatch).toHaveBeenCalledTimes(1);
    expect(m.mockBatchDispatch).toHaveBeenCalledWith({
      batchId: 'B1',
      tasks: [
        { taskId: 'T1', title: '做 A', kind: 'dev', prompt: 'p1' },
        { taskId: 'T2', title: '做 B', kind: 'dev', prompt: 'p2' },
      ],
    });
    expect(m.mockHttpPostJson).toHaveBeenCalledWith('http://127.0.0.1:8787/send', { text: 'BATCH_PROMPT' });
    expect(m.mockLogBanner).toHaveBeenCalledWith('批次 B1 (2): T1, T2');
    expect(m.mockBackupState).toHaveBeenCalled();
  });

  it('TC-B: 无 ready 且任务未全部完成 → 死锁 warn 并停止', async () => {
    const state = { currentState: 'CODE', tasks: [{ id: 'T1', status: 'pending', deps: ['X'] }] };
    m.mockLoadState.mockReturnValue(state);
    m.mockSelectReadyBatch.mockReturnValue([]);
    m.mockIsMilestoneDone.mockReturnValue(false);

    await runBatchLoop('/tmp/proj', CFG);

    expect(m.mockLogStep).toHaveBeenCalledWith('', 'warn', expect.stringContaining('无可调度的 ready 批次'));
    expect(m.mockBackupState).toHaveBeenCalled();
  });

  it('TC-C: 有未落账任务 → 补发 batchReconcile → 仍不落账 → 标 blocked', async () => {
    const state = { currentState: 'CODE', tasks: [{ id: 'T1', status: 'active' }] };
    m.mockLoadState.mockReturnValue(state);
    m.mockSelectReadyBatch
      .mockReturnValueOnce([{ id: 'T1', title: '做 A', kind: 'dev', prompt: 'p1' }])
      .mockReturnValueOnce([]);
    m.mockGetTaskStatus.mockReturnValue('active'); // 始终未落账
    m.mockBatchDispatch.mockResolvedValue('BATCH');
    m.mockBatchReconcile.mockResolvedValue('RECONCILE');

    await runBatchLoop('/tmp/proj', CFG);

    expect(m.mockBatchReconcile).toHaveBeenCalledWith('B1');
    expect(m.mockSendPrompt).toHaveBeenCalledWith('RECONCILE');
    expect(m.mockMarkTaskBlocked).toHaveBeenCalledWith('T1', '/tmp/proj');
  });

  it('TC-D: /send 失败 → 不抛错，进入 reconcile（未落账 → 收尾）', async () => {
    const state = { currentState: 'CODE', tasks: [{ id: 'T1', status: 'active' }] };
    m.mockLoadState.mockReturnValue(state);
    m.mockSelectReadyBatch
      .mockReturnValueOnce([{ id: 'T1', title: 'a', kind: 'dev', prompt: 'p1' }])
      .mockReturnValueOnce([]);
    m.mockGetTaskStatus.mockReturnValue('done');
    m.mockBatchDispatch.mockResolvedValue('BATCH');
    m.mockHttpPostJson.mockResolvedValue({ ok: false, error: 'session busy' });

    await runBatchLoop('/tmp/proj', CFG);

    expect(m.mockLogStep).toHaveBeenCalledWith('', 'error', expect.stringContaining('/send 失败'));
    expect(m.mockBackupState).toHaveBeenCalled();
  });
});
