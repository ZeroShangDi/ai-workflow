import { describe, it, expect } from 'vitest';
import { normalizeRun, toRunShellModel, runSummary } from '../../web/src/views/run-shell-model.js';

// T1-092：多 run 列表壳模型（/run/status → run 列表/当前选择归一，纯逻辑可测）。

describe('normalizeRun', () => {
  it('缺省/缺 counts 安全兜底', () => {
    expect(normalizeRun()).toEqual(expect.objectContaining({ runId: null, status: 'unknown', progress: '0/0' }));
    expect(normalizeRun({ runId: 'r1' }).counts).toEqual({ done: 0, total: 0, blocked: 0, active: 0, pending: 0 });
  });

  it('counts → progress + currentTaskTitle 派生', () => {
    const r = normalizeRun({
      runId: 'it1', status: 'running', mode: 'single',
      counts: { total: 3, done: 1, blocked: 0, active: 1, pending: 1 },
      currentTaskTitle: '做 A',
    });
    expect(r.progress).toBe('1/3');
    expect(r.currentTaskTitle).toBe('做 A');
  });
});

describe('toRunShellModel', () => {
  it('多 run：running/queued 优先为 active，否则首条', () => {
    const m = toRunShellModel({
      ok: true,
      runs: [
        { runId: 'a', status: 'done', counts: { total: 1, done: 1 } },
        { runId: 'b', status: 'queued' },
        { runId: 'c', status: 'running', counts: { total: 2, done: 1 } },
      ],
    });
    expect(m.total).toBe(3);
    expect(m.active.runId).toBe('c'); // running 优先
    expect(m.runs[1].runId).toBe('b');
    expect(m.isEmpty).toBe(false);
  });

  it('空/无 runs → isEmpty + active null', () => {
    const empty = toRunShellModel({});
    expect(empty.runs).toEqual([]);
    expect(empty.active).toBe(null);
    expect(empty.isEmpty).toBe(true);
  });
});

describe('runSummary', () => {
  it('展示文案含 runId/status/progress/task；空兜底', () => {
    expect(runSummary({ runId: 'x', status: 'running', progress: '1/2', currentTaskTitle: '做 A' }))
      .toContain('x [running]');
    expect(runSummary(null)).toBe('(无 run)');
  });
});
