import { describe, it, expect, vi, beforeEach } from 'vitest';

// drainDecisionResume 只依赖 session client + pause；全量 mock client 以精确控制轮询序列
vi.mock('../../src/lib/session/client.js', () => ({
  httpPost: vi.fn(),
  httpPostJson: vi.fn(() => Promise.resolve({ ok: true })),
  autoSelect: vi.fn(),
  waitForReady: vi.fn(() => Promise.resolve(true)),
  getStatus: vi.fn(() => Promise.resolve({})),
  sleep: vi.fn(),
  sendCmd: vi.fn(),
  getContextReady: vi.fn(),
  SERVER_PORT: 8787,
}));

vi.mock('../../src/lib/pause.js', () => ({
  waitWhilePaused: vi.fn(() => Promise.resolve()),
}));

import { drainDecisionResume } from '../../src/cli/run.js';
import { httpPostJson, getStatus, waitForReady } from '../../src/lib/session/client.js';

beforeEach(() => {
  vi.clearAllMocks();
  httpPostJson.mockResolvedValue({ ok: true });
});

describe('drainDecisionResume — gate on 决策捕获后的单 agent 续跑', () => {
  it('探测到 decisionResume → 注入续跑消息（含 answer）→ 再等待；无 resume 后结束', async () => {
    getStatus
      .mockResolvedValueOnce({ decisionResume: { decision_id: 'D-1', answer: '选 B 方案', type: 'resolved', finality: 'final', fallback: false } })
      .mockResolvedValueOnce({ decisionResume: null });

    await drainDecisionResume('/tmp/proj');

    expect(httpPostJson).toHaveBeenCalledTimes(1);
    expect(httpPostJson.mock.calls[0][0]).toContain('/send');
    expect(httpPostJson.mock.calls[0][1].text).toContain('选 B 方案');
    expect(waitForReady).toHaveBeenCalledTimes(1);
  });

  it('gate off / 无决策：decisionResume 恒 null → 零注入、零等待', async () => {
    getStatus.mockResolvedValue({ decisionResume: null });
    await drainDecisionResume('/tmp/proj');
    expect(httpPostJson).not.toHaveBeenCalled();
    expect(waitForReady).not.toHaveBeenCalled();
  });

  it('多次决策依次续跑（多轮 resume），直到耗尽', async () => {
    getStatus
      .mockResolvedValueOnce({ decisionResume: { decision_id: 'D-1', answer: 'a', fallback: false } })
      .mockResolvedValueOnce({ decisionResume: { decision_id: 'D-2', answer: 'b', fallback: true } })
      .mockResolvedValueOnce({ decisionResume: null });

    await drainDecisionResume('/tmp/proj');

    expect(httpPostJson).toHaveBeenCalledTimes(2);
    expect(waitForReady).toHaveBeenCalledTimes(2);
    expect(httpPostJson.mock.calls[1][1].text).toContain('b');
  });

  it('续跑注入失败 → 停止续跑（不静默死循环）', async () => {
    getStatus.mockResolvedValue({ decisionResume: { decision_id: 'D-1', answer: 'a', fallback: false } });
    httpPostJson.mockResolvedValue({ ok: false, error: 'boom' });
    await drainDecisionResume('/tmp/proj');
    expect(waitForReady).not.toHaveBeenCalled();
  });
});
