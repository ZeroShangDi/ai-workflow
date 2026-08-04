import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { autoSelect, DEFAULT_TIMEOUT_MS } from '../../src/cli/auto-selector.js';

describe('auto-selector', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers(); // 防止断言失败时 fake timers 泄漏到后续测试
  });

  // ── TC1: 单选 ──

  it('TC1: 单选 — 等待 5s 后返回 index=1', async () => {
    vi.useFakeTimers();

    const decision = {
      multiSelect: false,
      options: ['A方案', 'B方案'],
      question: '选择',
    };

    const promise = autoSelect(decision);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;
    vi.useRealTimers();

    expect(result).toEqual({ index: 1, label: 'A方案' });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('5s'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('A方案'));
  });

  // ── TC2: 多选 ──

  it('TC2: 多选 — 返回 multiSelect + selected[0]', async () => {
    vi.useFakeTimers();

    const decision = {
      multiSelect: true,
      options: ['X', 'Y'],
      question: '多选',
    };

    const promise = autoSelect(decision);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;
    vi.useRealTimers();

    expect(result).toEqual({ multiSelect: true, selected: [0], customInput: '' });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('X'));
  });

  // ── TC3: 无 options ──

  it('TC3: 无 options → label 为空字符串', async () => {
    vi.useFakeTimers();

    const decision = {
      multiSelect: false,
      options: [],
      question: '?',
    };

    const promise = autoSelect(decision);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;
    vi.useRealTimers();

    expect(result).toEqual({ index: 1, label: '' });
  });

  // ── TC4: 超时时间恒为 5s ──

  it('TC4: 超时时间恒为 5s', async () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(5000);

    vi.useFakeTimers();

    const decision = { multiSelect: false, options: ['X'] };
    const promise = autoSelect(decision);

    // 推进 4999ms — 还没 resolve
    await vi.advanceTimersByTimeAsync(4999);
    // Promise shouldn't be resolved yet — check by racing
    const raceResult = await Promise.race([
      promise.then(() => 'resolved'),
      Promise.resolve('still-pending'),
    ]);
    expect(raceResult).toBe('still-pending');

    // 推进剩余 1ms
    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;
    vi.useRealTimers();

    expect(result.index).toBe(1);
  });
});
