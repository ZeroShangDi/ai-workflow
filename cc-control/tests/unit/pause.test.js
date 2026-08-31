import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  loadState: vi.fn(),
  sleep: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/lib/state.js', () => ({ loadState: m.loadState }));
vi.mock('../../src/lib/session/client.js', () => ({ sleep: m.sleep }));

import { isWorkflowPaused, waitWhilePaused } from '../../src/lib/pause.js';

describe('pause 闩锁', () => {
  beforeEach(() => {
    m.loadState.mockReset();
    m.sleep.mockClear();
  });

  it('mode=pause 时返回暂停', () => {
    m.loadState.mockReturnValue({ mode: 'pause' });
    expect(isWorkflowPaused('/tmp/proj')).toBe(true);
  });

  it('持续等待到 mode 恢复为 run', async () => {
    m.loadState
      .mockReturnValueOnce({ mode: 'pause' })
      .mockReturnValueOnce({ mode: 'pause' })
      .mockReturnValueOnce({ mode: 'run' });

    const waited = await waitWhilePaused('/tmp/proj', 25);

    expect(waited).toBe(true);
    expect(m.sleep).toHaveBeenCalledTimes(2);
    expect(m.sleep).toHaveBeenNthCalledWith(1, 25);
  });
});
