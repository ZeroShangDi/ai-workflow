import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { backupState } from '../../src/cli/backup.js';

describe('backupState', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-backup-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeState(overrides = {}) {
    const awfDir = path.join(tmpDir, '.awf');
    fs.mkdirSync(awfDir, { recursive: true });
    fs.writeFileSync(path.join(awfDir, 'state.json'), JSON.stringify({
      version: '0.1.0',
      mode: 'run',
      currentState: 'FINISH',
      plan: { tasks: [{ id: 'T1', status: 'done' }] },
      ...overrides,
    }));
  }

  it('正常备份 state 到 versions/<version>-<timestamp>.json', () => {
    writeState();
    backupState(tmpDir);

    const dir = path.join(tmpDir, '.awf', 'versions');
    expect(fs.existsSync(dir)).toBe(true);

    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^0\.1\.0-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/);

    const content = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf-8'));
    expect(content.version).toBe('0.1.0');
    expect(content.currentState).toBe('FINISH');
  });

  it('state.json 不存在 → 不创建备份', () => {
    backupState(tmpDir);

    const dir = path.join(tmpDir, '.awf', 'versions');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('state.json 无 version → 不创建备份', () => {
    writeState({ version: undefined });
    backupState(tmpDir);

    const dir = path.join(tmpDir, '.awf', 'versions');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('两次备份产生不同时间戳文件', () => {
    vi.useFakeTimers();
    try {
      writeState();
      backupState(tmpDir);

      vi.advanceTimersByTime(2000); // 确保时间戳不同
      writeState({ currentState: 'CODE' });
      backupState(tmpDir);

      const files = fs.readdirSync(path.join(tmpDir, '.awf', 'versions'));
      expect(files).toHaveLength(2);
      expect(files[0]).not.toBe(files[1]);
    } finally {
      vi.useRealTimers();
    }
  });
});
