import { describe, it, expect } from 'vitest';
import { toDashboardModel, phaseLabel, applyRunEvent } from '../../web/src/views/dashboard-model.js';

// T1-087：Dashboard 视图模型（server payload → 展示模型，纯逻辑可测）。

describe('toDashboardModel', () => {
  it('run/status + status + metrics → 归一展示模型（overview/task/phase/metrics）', () => {
    const m = toDashboardModel({
      runStatus: { ok: true, runs: [{ runId: 'r1', status: 'running', mode: 'single', counts: { total: 3, done: 1, blocked: 0 }, currentTaskTitle: '做 A', currentStage: 'DEV' }] },
      status: { state: 'busy', projectRoot: '/p', activeAgents: 0 },
      metrics: { ok: true, metrics: { token_in: 123, token_out: 45 } },
    });
    expect(m.runId).toBe('r1');
    expect(m.runStatus).toBe('running');
    expect(m.progress).toBe('1/3');
    expect(m.currentTaskTitle).toBe('做 A');
    expect(m.currentStage).toBe('DEV');
    expect(m.metrics.token_in).toBe(123);
    expect(m.activeAgents).toBe(0);
  });

  it('无 run → idle 兜底', () => {
    const m = toDashboardModel({ status: { state: 'ready' } });
    expect(m.runId).toBe(null);
    expect(m.progress).toBe('0/0');
  });
});

describe('phaseLabel / applyRunEvent', () => {
  it('阶段文案映射', () => {
    expect(phaseLabel('CODE')).toBe('编码');
    expect(phaseLabel('X')).toBe('X');
  });

  it('WS 事件更新模型', () => {
    const base = toDashboardModel({});
    expect(applyRunEvent(base, { type: 'run.stopped', payload: { status: 'done' } }).runStatus).toBe('done');
    expect(applyRunEvent(base, { type: 'task.done', payload: { taskId: 'T1' } }).lastEvent).toBe('task.done');
  });
});
