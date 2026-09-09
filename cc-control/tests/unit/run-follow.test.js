import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRunFollow } from '../../src/lib/ui/run-follow.js';

function ttyOutput() {
  return { isTTY: true, write: vi.fn() };
}

const AWF = 'AWF_TASK_LIST_INTERACTIVE';

describe('createRunFollow — attach/follow 终端跟随展示', () => {
  beforeEach(() => { delete process.env[AWF]; });
  afterEach(() => { delete process.env[AWF]; vi.useRealTimers(); });

  it('TTY：attach 头部 + 宿主事件驱动任务行原地重绘（active→done ✓）', () => {
    const output = ttyOutput();
    const print = vi.fn();
    const follow = createRunFollow({ output, print });

    follow.attach({ runId: 'r1', mode: 'single', note: 'store 已落盘 0/1 done' });
    follow.event({ type: 'task.started', payload: { taskId: 'T1', title: '做 A' } });
    follow.event({ type: 'task.done', payload: { taskId: 'T1' } });
    follow.finish({ status: 'done', counts: { done: 1, total: 1, blocked: 0 } });

    // 头部/汇总经 print
    expect(print).toHaveBeenCalledWith(expect.stringContaining('run r1'));
    expect(print).toHaveBeenCalledWith(expect.stringContaining('store 已落盘 0/1 done'));
    expect(print).toHaveBeenCalledWith(expect.stringContaining('✔ run 完成'));
    // 任务行经 TTY 重绘写入 output：最终帧含 done ✓、任务键只出现一次
    const writes = output.write.mock.calls.map((c) => c[0]).join('\n');
    const last = output.write.mock.calls.at(-1)[0];
    expect(writes).toContain('[T1]');
    expect(last).toContain('✓');
    expect(last.match(/\[T1\]/g)).toHaveLength(1);
  });

  it('进度行按 counts 去重：相同进度只打一行；变化才追加', () => {
    const output = ttyOutput();
    const print = vi.fn();
    const follow = createRunFollow({ output, print });
    follow.status({ done: 0, total: 2, blocked: 0 });
    follow.status({ done: 0, total: 2, blocked: 0 });
    follow.status({ done: 1, total: 2, blocked: 0 });
    const progress = print.mock.calls.map((c) => c[0]).filter((s) => typeof s === 'string' && s.includes('进度'));
    expect(progress).toHaveLength(2);
  });

  it('非 TTY / 重定向：降级为完整状态事件行（不原地重绘）', () => {
    const output = { isTTY: false, write: vi.fn() };
    const print = vi.fn();
    const follow = createRunFollow({ output, print });

    follow.attach({ runId: 'r1', mode: 'single' });
    follow.event({ type: 'task.started', payload: { taskId: 'T1', title: '做 A' } });
    follow.event({ type: 'task.blocked', payload: { taskId: 'T1', verdict: { level: 'fail' } } });
    follow.finish({ status: 'blocked' });

    // 头部/汇总仍走 print；任务行走 output.write（完整事件行，含状态图标）
    expect(print).toHaveBeenCalledWith(expect.stringContaining('run r1'));
    const writes = output.write.mock.calls.map((c) => c[0]).join('\n');
    expect(writes).toContain('[T1]');
    expect(writes).toContain('⚠'); // blocked
  });
});
