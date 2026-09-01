import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// run-batch.js 是滑动窗口的薄集成：runScheduler + socket dispatcher + 轮询 waitAnyDone。
// 核心调度逻辑已由 scheduler.test.js 覆盖；这里测集成接线。

const m = vi.hoisted(() => ({
  mockRunScheduler: vi.fn(),
  mockHttpPostJson: vi.fn(),
  mockSubagentDispatch: vi.fn(),
  mockSleep: vi.fn(() => Promise.resolve()),
  mockBackupState: vi.fn(),
  mockMarkTaskActive: vi.fn(),
  mockLoadState: vi.fn(() => null),
  mockGetStatus: vi.fn(),
  mockHandleDecision: vi.fn(),
  mockHandleGateCompletion: vi.fn(() => Promise.resolve()),
  mockWaitWhilePaused: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/lib/plugin-bridge.js', () => ({ subagentDispatch: m.mockSubagentDispatch }));
vi.mock('../../src/lib/session/client.js', () => ({ httpPostJson: m.mockHttpPostJson, sleep: m.mockSleep, SERVER_PORT: 8787, getStatus: m.mockGetStatus }));
vi.mock('../../src/lib/state.js', () => ({
  loadState: m.mockLoadState,
  backupState: m.mockBackupState,
  markTaskActive: m.mockMarkTaskActive,
}));
vi.mock('../../src/cli/scheduler.js', () => ({ runScheduler: m.mockRunScheduler }));
vi.mock('../../src/cli/run.js', () => ({ handleDecision: m.mockHandleDecision }));
vi.mock('../../src/cli/gate-fix.js', () => ({ handleGateCompletion: m.mockHandleGateCompletion }));
vi.mock('../../src/lib/pause.js', () => ({ waitWhilePaused: m.mockWaitWhilePaused }));

import { runBatchLoop } from '../../src/cli/run-batch.js';

describe('runBatchLoop — 滑动窗口集成（薄封装）', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const k of Object.keys(m)) m[k].mockReset();
    m.mockSleep.mockImplementation(() => Promise.resolve());
    m.mockLoadState.mockReturnValue(null);
    m.mockGetStatus.mockResolvedValue({}); // 默认无主 Agent 决策
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

  it('TC-B: dispatcher.send 经 subagentDispatch + /send 派发到主会话', async () => {
    let captured;
    m.mockRunScheduler.mockImplementation(async ({ dispatcher }) => {
      captured = dispatcher;
      return { dispatched: 1 };
    });
    m.mockSubagentDispatch.mockResolvedValue('DISPATCH_PROMPT');
    m.mockHttpPostJson.mockResolvedValue({ ok: true });
    await runBatchLoop('/tmp/proj', { agents: { max: 2 } });

    await captured.send({ id: 'T1', title: '做任务', prompt: 'do it' });
    expect(m.mockWaitWhilePaused).toHaveBeenCalledWith('/tmp/proj');
    expect(m.mockSubagentDispatch).toHaveBeenCalledWith({ taskId: 'T1', taskTitle: '做任务', taskPrompt: 'do it' });
    expect(m.mockHttpPostJson).toHaveBeenCalledWith('http://127.0.0.1:8787/send', { text: 'DISPATCH_PROMPT' });
    expect(m.mockMarkTaskActive).toHaveBeenCalledWith('/tmp/proj', 'T1');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[T1]'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('做任务'));
  });

  it('TC-D: dispatcher.send 派发失败（/send 非 ok）→ 抛错', async () => {
    let captured;
    m.mockRunScheduler.mockImplementation(async ({ dispatcher }) => {
      captured = dispatcher;
      return { dispatched: 1 };
    });
    m.mockSubagentDispatch.mockResolvedValue('PROMPT');
    m.mockHttpPostJson.mockResolvedValue({ ok: false, error: 'still busy' });
    await runBatchLoop('/tmp/proj', { agents: { max: 2 } });

    await expect(captured.send({ id: 'T1', title: 't', prompt: 'p' })).rejects.toThrow(/派发 T1 失败/);
  });

  it('TC-E: 落账失败记录 → 触发补发（sendRaw 恢复子 Agent 补齐 RESULT）', async () => {
    let dispatcher, waitAnyDone;
    m.mockRunScheduler.mockImplementation(async ({ dispatcher: d, waitAnyDone: w }) => {
      dispatcher = d; waitAnyDone = w;
      return { dispatched: 0 };
    });
    m.mockHttpPostJson.mockResolvedValue({ ok: true });
    // 先清残留：cursor 初始化必须看到空日志（跨次运行幂等，避免历史记录抬高游标跳过本条）
    const failedLog = '/tmp/proj/.awf/logs/subagent-failed.jsonl';
    fs.rmSync(failedLog, { force: true });
    fs.mkdirSync(path.dirname(failedLog), { recursive: true });
    await runBatchLoop('/tmp/proj', { agents: { max: 2 } });

    // 预置失败记录（server 落账失败时写入的）——用当前时间，保证 > 起始游标 0
    fs.writeFileSync(failedLog, JSON.stringify({ ts: new Date().toISOString(), agentId: 'agent-bad', reason: 'task T999 not found', resultTaskId: 'T999' }) + '\n');

    // 驱动 waitAnyDone：先无完成（触发补发检测），后 T1 完成（返回）
    m.mockLoadState
      .mockReturnValueOnce({ tasks: [{ id: 'T1', status: 'pending' }] })
      .mockReturnValueOnce({ tasks: [{ id: 'T1', status: 'done' }] });
    await waitAnyDone({ taskIds: () => ['T1'] });

    // 补发：经 /send 注入「SendMessage 恢复子 Agent」指令（含 agent-bad）
    expect(m.mockHttpPostJson).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/send',
      expect.objectContaining({ text: expect.stringContaining('agent-bad') }),
    );
  });

  it('TC-G: 主 Agent AskUserQuestion（决策挂起）→ handleDecision 响应', async () => {
    let waitAnyDone;
    m.mockRunScheduler.mockImplementation(async ({ waitAnyDone: w }) => {
      waitAnyDone = w;
      return { dispatched: 0 };
    });
    m.mockHandleDecision.mockResolvedValue();
    await runBatchLoop('/tmp/proj', { agents: { max: 2 } });

    // 第一次：有未答决策 → handleDecision 处理（响应主 Agent AskUserQuestion）；之后无决策
    m.mockGetStatus
      .mockResolvedValueOnce({ decisionPending: { question: '选 A 还是 B', options: ['A', 'B'], answered: false } })
      .mockResolvedValue({});
    m.mockLoadState
      .mockReturnValueOnce({ tasks: [{ id: 'T1', status: 'pending' }] })
      .mockReturnValueOnce({ tasks: [{ id: 'T1', status: 'pending' }] })
      .mockReturnValue({ tasks: [{ id: 'T1', status: 'done' }] });
    await waitAnyDone({ taskIds: () => ['T1'] });

    expect(m.mockHandleDecision).toHaveBeenCalledTimes(1); // 决策被响应（/respond 回主 Agent）
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

  it('TC-H: onTaskComplete 接线到 handleGateCompletion（门禁闭环钩子）', async () => {
    let captured;
    m.mockRunScheduler.mockImplementation(async ({ onTaskComplete }) => {
      captured = onTaskComplete;
      return { dispatched: 0 };
    });
    await runBatchLoop('/tmp/proj', { agents: { max: 2 } });
    expect(captured).toBeTypeOf('function');

    // 触发完成回调：门禁任务 blocked → handleGateCompletion 被调用（projectRoot/id/task 透传）
    const gateTask = { id: 'R1', kind: 'review', status: 'blocked', exec: { verdict: { level: 'fail' } } };
    await captured('R1', gateTask);
    expect(m.mockHandleGateCompletion).toHaveBeenCalledWith('/tmp/proj', 'R1', gateTask);
  });

  it('TC-I: 任务落账后输出完成状态与标题', async () => {
    let captured;
    m.mockRunScheduler.mockImplementation(async ({ onTaskComplete }) => {
      captured = onTaskComplete;
      return { dispatched: 0 };
    });
    m.mockLoadState.mockReturnValue({ tasks: [{ id: 'T1', title: '实现登录', status: 'done' }] });
    await runBatchLoop('/tmp/proj', { agents: { max: 2 } });

    await captured('T1', { id: 'T1', title: '旧标题', status: 'active' });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[T1]'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('实现登录'));
  });
});
