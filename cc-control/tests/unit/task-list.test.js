import { describe, it, expect, vi } from 'vitest';
import { createTaskList, formatDuration } from '../../src/lib/ui/task-list.js';

function ttyOutput() {
  return { isTTY: true, write: vi.fn() };
}

describe('createTaskList', () => {
  it('格式化秒、分钟和小时', () => {
    expect(formatDuration(9_900)).toBe('9s');
    expect(formatDuration(65_000)).toBe('1m 05s');
    expect(formatDuration(3_665_000)).toBe('1h 01m 05s');
  });

  it('按首次派发顺序保留任务，完成时原行更新', () => {
    const output = ttyOutput();
    const list = createTaskList({ output, intervalMs: 60_000 });

    list.update('T2', '第二个', 'active');
    list.update('T1', '第一个', 'active');
    list.update('T2', '第二个', 'done');
    list.stop();

    const finalRender = output.write.mock.calls.at(-1)[0];
    expect(finalRender.indexOf('[T2]')).toBeLessThan(finalRender.indexOf('[T1]'));
    expect(finalRender).toContain('✓');
    expect(finalRender.match(/\[T2\]/g)).toHaveLength(1);
  });

  it('运行中任务使用动态 spinner 帧', () => {
    vi.useFakeTimers();
    const output = ttyOutput();
    const list = createTaskList({ output, intervalMs: 80 });
    list.update('T1', '运行中', 'active');
    const first = output.write.mock.calls.at(-1)[0];

    vi.advanceTimersByTime(80);
    const second = output.write.mock.calls.at(-1)[0];
    list.stop();
    vi.useRealTimers();

    expect(first).toContain('⠋');
    expect(second).toContain('⠙');
  });

  it('eval 透传环境即使 stdout 为 pipe 也启用动态重绘', () => {
    vi.useFakeTimers();
    const output = { isTTY: false, write: vi.fn() };
    const previous = process.env.AWF_TASK_LIST_INTERACTIVE;
    process.env.AWF_TASK_LIST_INTERACTIVE = '1';
    const list = createTaskList({ output, intervalMs: 80 });

    list.update('T1', 'eval 任务', 'active');
    vi.advanceTimersByTime(80);
    list.stop();

    if (previous === undefined) delete process.env.AWF_TASK_LIST_INTERACTIVE;
    else process.env.AWF_TASK_LIST_INTERACTIVE = previous;
    vi.useRealTimers();

    expect(output.write).toHaveBeenCalledWith(expect.stringContaining('⠙'));
    expect(output.write).toHaveBeenCalledWith(expect.stringContaining('\x1b[1A'));
  });
});
