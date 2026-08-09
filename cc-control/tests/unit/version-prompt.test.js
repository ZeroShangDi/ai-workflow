import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSelect, mockInput, mockReadFile } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInput: vi.fn(),
  mockReadFile: vi.fn(),
}));

vi.mock('@inquirer/prompts', () => ({
  select: mockSelect,
  input: mockInput,
}));

vi.mock('node:fs/promises', () => {
  const fs = { readFile: mockReadFile };
  return { ...fs, default: fs };
});

import { promptVersion } from '../../src/lib/version.js';

describe('version-prompt', () => {
  const cwd = '/tmp/mock-cwd';

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockSelect.mockReset();
    mockInput.mockReset();
    mockReadFile.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers(); // 防止 TC10/11 中途失败时 fake timers 泄漏
  });

  // ── version reading ──

  describe('version reading', () => {
    it('TC1: 读取 state.json 中的版本号', async () => {
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify({ version: '0.2.0' })); // state.json
      mockSelect.mockResolvedValue('0.2.0'); // 选择"当前"

      const result = await promptVersion(cwd);
      expect(result).toBe('0.2.0');
      // package.json 不应被读取（version != '0.0.1'）
      expect(mockReadFile).toHaveBeenCalledTimes(1);
    });

    it('TC2: state.json 无 version 时回退到 package.json', async () => {
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify({ mode: 'idle' })) // state.json, no version
        .mockResolvedValueOnce(JSON.stringify({ version: '0.3.0' })); // package.json
      mockSelect.mockResolvedValue('0.3.0');

      const result = await promptVersion(cwd);
      expect(result).toBe('0.3.0');
      expect(mockReadFile).toHaveBeenCalledTimes(2);
    });

    it('TC3: state.json version=0.0.1 时继续读取 package.json', async () => {
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify({ version: '0.0.1' }))
        .mockResolvedValueOnce(JSON.stringify({ version: '1.2.3' }));
      mockSelect.mockResolvedValue('1.2.3');

      const result = await promptVersion(cwd);
      expect(result).toBe('1.2.3');
      expect(mockReadFile).toHaveBeenCalledTimes(2);
    });

    it('TC4: package.json 不存在 → 使用默认 0.0.1', async () => {
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify({ mode: 'idle' })) // state.json no version
        .mockRejectedValueOnce(new Error('ENOENT')); // package.json missing
      mockSelect.mockResolvedValue('0.0.1');

      const result = await promptVersion(cwd);
      expect(result).toBe('0.0.1');
    });

    it('TC5: 两者都不存在 → 使用 0.0.1', async () => {
      mockReadFile
        .mockRejectedValueOnce(new Error('ENOENT')) // state.json
        .mockRejectedValueOnce(new Error('ENOENT')); // package.json
      mockSelect.mockResolvedValue('0.0.1');

      const result = await promptVersion(cwd);
      expect(result).toBe('0.0.1');
    });
  });

  // ── user interaction ──

  describe('user interaction', () => {
    it('TC6: 用户选择"当前"→ 返回原版本号', async () => {
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ version: '0.2.0' }));
      mockSelect.mockResolvedValue('0.2.0');

      const result = await promptVersion(cwd);
      expect(result).toBe('0.2.0');
      expect(mockInput).not.toHaveBeenCalled();
    });

    it('TC7: 用户选择 +patch → 返回递增版本号', async () => {
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ version: '0.1.3' }));
      mockSelect.mockResolvedValue('0.1.4');

      const result = await promptVersion(cwd);
      expect(result).toBe('0.1.4');
      expect(mockInput).not.toHaveBeenCalled();
    });

    it('TC8: 用户选择 +minor → 返回递增版本号', async () => {
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ version: '0.1.3' }));
      mockSelect.mockResolvedValue('0.2.0');

      const result = await promptVersion(cwd);
      expect(result).toBe('0.2.0');
    });

    it('TC9: 用户选择 +major → 返回递增版本号', async () => {
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ version: '0.1.3' }));
      mockSelect.mockResolvedValue('1.0.0');

      const result = await promptVersion(cwd);
      expect(result).toBe('1.0.0');
    });

    it('TC10: 用户选择"自定义"→ 输入有效版本号', async () => {
      vi.useFakeTimers();
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ version: '0.1.3' }));
      mockSelect.mockResolvedValue('__custom__');
      mockInput.mockResolvedValue('2.0.0-beta');

      const promise = promptVersion(cwd);
      await vi.advanceTimersByTimeAsync(100);
      const result = await promise;
      vi.useRealTimers();

      expect(mockInput).toHaveBeenCalledWith({
        message: '输入版本号',
        default: '0.1.3',
        prefill: 'editable',
      });
      expect(result).toBe('2.0.0-beta');
    });

    it('TC11: 用户选择"自定义"→ 输入为空 → 返回当前版本', async () => {
      vi.useFakeTimers();
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ version: '0.1.3' }));
      mockSelect.mockResolvedValue('__custom__');
      mockInput.mockResolvedValue('   '); // whitespace only

      const promise = promptVersion(cwd);
      await vi.advanceTimersByTimeAsync(100);
      const result = await promise;
      vi.useRealTimers();

      expect(result).toBe('0.1.3');
    });
  });

  // ── choices validation ──

  describe('choices validation', () => {
    it('TC12: select 选项列表包含正确的 5 项', async () => {
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ version: '0.1.3' }));

      // Don't resolve select — just inspect the call
      let resolveSelect;
      mockSelect.mockImplementation(() => new Promise((r) => { resolveSelect = r; }));

      const promise = promptVersion(cwd);

      // Wait for microtask to ensure select was called
      await new Promise((r) => setTimeout(r, 10));

      const choices = mockSelect.mock.calls[0][0].choices;
      expect(choices).toHaveLength(5);

      expect(choices[0].name).toContain('当前');
      expect(choices[0].name).toContain('0.1.3');
      expect(choices[0].value).toBe('0.1.3');

      expect(choices[1].name).toContain('+patch');
      expect(choices[1].value).toBe('0.1.4');

      expect(choices[2].name).toContain('+minor');
      expect(choices[2].value).toBe('0.2.0');

      expect(choices[3].name).toContain('+major');
      expect(choices[3].value).toBe('1.0.0');

      expect(choices[4].name).toContain('自定义');
      expect(choices[4].value).toBe('__custom__');
      expect(choices[4].description).toBeDefined();

      // Clean up
      resolveSelect('0.1.3');
      await promise;
    });
  });

  // ── error handling ──

  describe('error handling', () => {
    it('TC13: package.json 无效 JSON → 不抛异常', async () => {
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify({ mode: 'idle' })) // state.json no version
        .mockResolvedValueOnce('{broken'); // invalid JSON
      mockSelect.mockResolvedValue('0.0.1');

      const result = await promptVersion(cwd);
      expect(result).toBe('0.0.1');
    });

    it('TC14: state.json 无效 JSON → 不抛异常，回退到 package.json', async () => {
      mockReadFile
        .mockResolvedValueOnce('{broken') // invalid state.json
        .mockResolvedValueOnce(JSON.stringify({ version: '0.5.0' })); // valid package.json
      mockSelect.mockResolvedValue('0.5.0');

      const result = await promptVersion(cwd);
      expect(result).toBe('0.5.0');
    });
  });

  // ── edge cases ──

  describe('edge cases', () => {
    it('TC15: 版本号格式 — semver 解析（非标准格式）', async () => {
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ version: '1' }));

      let resolveSelect;
      mockSelect.mockImplementation(() => new Promise((r) => { resolveSelect = r; }));

      const promise = promptVersion(cwd);
      await new Promise((r) => setTimeout(r, 10));

      const choices = mockSelect.mock.calls[0][0].choices;
      // +patch: '1'.split('.') → ['1'], minor=undefined, patch=NaN
      expect(choices[1].value).toBe('1.undefined.NaN');

      resolveSelect('1');
      await promise;
    });

    it('TC16: 边界: 版本号各部分为 0', async () => {
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ version: '0.0.0' }));

      let resolveSelect;
      mockSelect.mockImplementation(() => new Promise((r) => { resolveSelect = r; }));

      const promise = promptVersion(cwd);
      await new Promise((r) => setTimeout(r, 10));

      const choices = mockSelect.mock.calls[0][0].choices;
      expect(choices[1].value).toBe('0.0.1');  // +patch
      expect(choices[2].value).toBe('0.1.0');  // +minor
      expect(choices[3].value).toBe('1.0.0');  // +major

      resolveSelect('0.0.0');
      await promise;
    });

    it('TC17: 边界: 大版本号', async () => {
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ version: '999.999.999' }));

      let resolveSelect;
      mockSelect.mockImplementation(() => new Promise((r) => { resolveSelect = r; }));

      const promise = promptVersion(cwd);
      await new Promise((r) => setTimeout(r, 10));

      const choices = mockSelect.mock.calls[0][0].choices;
      expect(choices[1].value).toBe('999.999.1000'); // +patch
      expect(choices[2].value).toBe('999.1000.0');   // +minor
      expect(choices[3].value).toBe('1000.0.0');     // +major

      resolveSelect('999.999.999');
      await promise;
    });
  });
});
