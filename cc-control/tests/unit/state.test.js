import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { loadState, saveState, findNextTask, getCurrentPhase, isMilestoneDone } from '../../src/lib/state.js';

describe('state.js — CLI', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-state-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── loadState ──

  describe('loadState', () => {
    it('TC1: 正常读取 state.json', () => {
      const awfDir = path.join(tmpDir, '.awf');
      fs.mkdirSync(awfDir);
      fs.writeFileSync(path.join(awfDir, 'state.json'), JSON.stringify({ mode: 'idle', version: '0.1.0' }));

      const result = loadState(tmpDir);
      expect(result).toEqual({ mode: 'idle', version: '0.1.0' });
    });

    it('TC2: 文件不存在返回 null', () => {
      const result = loadState(tmpDir);
      expect(result).toBeNull();
    });

    it('TC3: 非法 JSON 返回 null', () => {
      const awfDir = path.join(tmpDir, '.awf');
      fs.mkdirSync(awfDir);
      fs.writeFileSync(path.join(awfDir, 'state.json'), '{invalid');

      const result = loadState(tmpDir);
      expect(result).toBeNull();
    });
  });

  // ── getCurrentPhase ──

  describe('getCurrentPhase', () => {
    it('TC: 正常读取 currentState', () => {
      const awfDir = path.join(tmpDir, '.awf');
      fs.mkdirSync(awfDir);
      fs.writeFileSync(path.join(awfDir, 'state.json'), JSON.stringify({ currentState: 'CODE' }));

      expect(getCurrentPhase(tmpDir)).toBe('CODE');
    });

    it('TC: state 不存在返回 null', () => {
      expect(getCurrentPhase(tmpDir)).toBeNull();
    });

    it('TC: state 无 currentState 字段返回 null', () => {
      const awfDir = path.join(tmpDir, '.awf');
      fs.mkdirSync(awfDir);
      fs.writeFileSync(path.join(awfDir, 'state.json'), JSON.stringify({ mode: 'idle' }));

      expect(getCurrentPhase(tmpDir)).toBeNull();
    });
  });

  // ── saveState ──

  describe('saveState', () => {
    it('TC4: 正常写入（含目录创建 + lastUpdated）', () => {
      saveState(tmpDir, { mode: 'idle', version: '0.1.0' });

      const filePath = path.join(tmpDir, '.awf', 'state.json');
      expect(fs.existsSync(filePath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(content.mode).toBe('idle');
      expect(content.version).toBe('0.1.0');
      expect(content.lastUpdated).toBeDefined();
      // 2-space indent
      const raw = fs.readFileSync(filePath, 'utf-8');
      expect(raw).toContain('  "mode"');
    });
  });

  // ── findNextTask ──

  describe('findNextTask', () => {
    it('TC5: 返回首个 pending 无 deps 任务', () => {
      const state = {
        tasks: [
          { id: 'T1', status: 'done' },
          { id: 'T2', status: 'pending', deps: [] },
          { id: 'T3', status: 'pending' },
        ],
      };
      const result = findNextTask(state);
      expect(result.id).toBe('T2');
    });

    it('TC6: deps 未满足时跳过', () => {
      const state = {
        tasks: [
          { id: 'T1', status: 'pending' },
          { id: 'T2', status: 'pending', deps: ['T1'] },
        ],
      };
      const result = findNextTask(state);
      expect(result.id).toBe('T1');
    });

    it('TC7: deps 全满足时返回', () => {
      const state = {
        tasks: [
          { id: 'T1', status: 'done' },
          { id: 'T2', status: 'pending', deps: ['T1'] },
        ],
      };
      const result = findNextTask(state);
      expect(result.id).toBe('T2');
    });

    it('TC8: 全部 done 返回 null', () => {
      const state = {
        tasks: [
          { id: 'T1', status: 'done' },
          { id: 'T2', status: 'done' },
        ],
      };
      expect(findNextTask(state)).toBeNull();
    });

    it('TC9: tasks 在根级', () => {
      const state = { tasks: [{ id: 'T1', status: 'pending' }] };
      expect(findNextTask(state).id).toBe('T1');

      // 无 tasks
      expect(findNextTask({})).toBeNull();
    });
  });

  // ── isMilestoneDone ──

  describe('isMilestoneDone', () => {
    it('TC10: isMilestoneDone', () => {
      // All done
      const allDone = { tasks: [
        { id: 'T1', status: 'done' },
        { id: 'T2', status: 'done' },
      ]};
      expect(isMilestoneDone(allDone)).toBe(true);

      // Partial
      const partial = { tasks: [
        { id: 'T1', status: 'done' },
        { id: 'T2', status: 'pending' },
      ]};
      expect(isMilestoneDone(partial)).toBe(false);

      // Empty
      expect(isMilestoneDone({ tasks: [] })).toBe(false);
    });
  });
});
