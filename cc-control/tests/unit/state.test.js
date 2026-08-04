import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { loadState, saveState, findNextTask, isMilestoneDone } from '../../src/cli/state.js';

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
        plan: { tasks: [
          { id: 'T1', status: 'done' },
          { id: 'T2', status: 'pending', deps: [] },
          { id: 'T3', status: 'pending' },
        ]},
      };
      const result = findNextTask(state);
      expect(result.id).toBe('T2');
    });

    it('TC6: deps 未满足时跳过', () => {
      const state = {
        plan: { tasks: [
          { id: 'T1', status: 'pending' },
          { id: 'T2', status: 'pending', deps: ['T1'] },
        ]},
      };
      const result = findNextTask(state);
      expect(result.id).toBe('T1');
    });

    it('TC7: deps 全满足时返回', () => {
      const state = {
        plan: { tasks: [
          { id: 'T1', status: 'done' },
          { id: 'T2', status: 'pending', deps: ['T1'] },
        ]},
      };
      const result = findNextTask(state);
      expect(result.id).toBe('T2');
    });

    it('TC8: 全部 done 返回 null', () => {
      const state = {
        plan: { tasks: [
          { id: 'T1', status: 'done' },
          { id: 'T2', status: 'done' },
        ]},
      };
      expect(findNextTask(state)).toBeNull();
    });

    it('TC9: 双位置兼容 — plan.tasks 优先', () => {
      // plan.tasks present
      const stateA = { plan: { tasks: [{ id: 'T1', status: 'pending' }] } };
      expect(findNextTask(stateA).id).toBe('T1');

      // only root tasks
      const stateB = { tasks: [{ id: 'T2', status: 'pending' }] };
      expect(findNextTask(stateB).id).toBe('T2');

      // both: plan.tasks wins
      const stateC = { plan: { tasks: [{ id: 'T3', status: 'pending' }] }, tasks: [{ id: 'T4', status: 'pending' }] };
      expect(findNextTask(stateC).id).toBe('T3');

      // neither
      const stateD = {};
      expect(findNextTask(stateD)).toBeNull();
    });
  });

  // ── isMilestoneDone ──

  describe('isMilestoneDone', () => {
    it('TC10: isMilestoneDone', () => {
      // All done
      const allDone = { plan: { tasks: [
        { id: 'T1', status: 'done' },
        { id: 'T2', status: 'done' },
      ]}};
      expect(isMilestoneDone(allDone)).toBe(true);

      // Partial
      const partial = { plan: { tasks: [
        { id: 'T1', status: 'done' },
        { id: 'T2', status: 'pending' },
      ]}};
      expect(isMilestoneDone(partial)).toBe(false);

      // Empty
      expect(isMilestoneDone({ plan: { tasks: [] } })).toBe(false);
    });
  });
});
