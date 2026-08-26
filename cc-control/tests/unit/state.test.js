import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { loadState, saveState, findNextTask, getCurrentPhase, isMilestoneDone, selectReadyBatch } from '../../src/lib/state.js';

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

  // ── selectReadyBatch ──

  describe('selectReadyBatch', () => {
    it('TC-B1: 无 deps 多任务按 max 截断，保持原始顺序', () => {
      const state = {
        tasks: [
          { id: 'T1', status: 'pending' },
          { id: 'T2', status: 'pending' },
          { id: 'T3', status: 'pending' },
        ],
      };
      expect(selectReadyBatch(state, { agents: { max: 2 } }).map(t => t.id)).toEqual(['T1', 'T2']);
      expect(selectReadyBatch(state, { agents: { max: 1 } }).map(t => t.id)).toEqual(['T1']);
    });

    it('TC-B2: deps 未满足的任务不 ready', () => {
      const state = {
        tasks: [
          { id: 'T1', status: 'pending' },
          { id: 'T2', status: 'pending', deps: ['T1'] },
        ],
      };
      expect(selectReadyBatch(state).map(t => t.id)).toEqual(['T1']);
    });

    it('TC-B3: doc 独占成批（优先返回，不与其他 ready 任务并行）', () => {
      const state = {
        tasks: [
          { id: 'T1', status: 'pending' },
          { id: 'D1', kind: 'doc', status: 'pending' },
        ],
      };
      expect(selectReadyBatch(state, { agents: { max: 9 } }).map(t => t.id)).toEqual(['D1']);
    });

    it('TC-B4: maxPerFeature=1 → 功能内串行，跨功能并行', () => {
      const state = {
        tasks: [
          { id: 'T1', status: 'pending' },
          { id: 'T2', status: 'pending' },
          { id: 'R1', kind: 'review', status: 'pending', deps: ['T1', 'T2'] },
          { id: 'T3', status: 'pending' },
          { id: 'R2', kind: 'review', status: 'pending', deps: ['T3'] },
        ],
      };
      // 功能: T1/T2→R1, T3→R2。maxPerFeature=1 → T1 与 T3 并行，T2 被功能配额挡下
      expect(selectReadyBatch(state, { agents: { max: 9, maxPerFeature: 1 } }).map(t => t.id)).toEqual(['T1', 'T3']);
    });

    it('TC-B5: maxPerModule=1 → 每模块最多一个任务', () => {
      const state = {
        tasks: [
          { id: 'T1', status: 'pending' },
          { id: 'T2', status: 'pending' },
          { id: 'R1', kind: 'review', status: 'pending', deps: ['T1', 'T2'] },
          { id: 'T3', status: 'pending' },
          { id: 'R2', kind: 'review', status: 'pending', deps: ['T3'] },
          { id: 'X1', kind: 'test', status: 'pending', deps: ['R1', 'R2', 'T1', 'T2', 'T3'] },
          { id: 'T4', status: 'pending' },
          { id: 'R3', kind: 'review', status: 'pending', deps: ['T4'] },
          { id: 'X2', kind: 'test', status: 'pending', deps: ['R3', 'T4'] },
        ],
      };
      // 模块: T1/T2/T3/R1/R2→X1, T4/R3→X2。maxPerModule=1 → 每模块取一个
      expect(selectReadyBatch(state, { agents: { max: 9, maxModules: 9, maxPerModule: 1 } }).map(t => t.id)).toEqual(['T1', 'T4']);
    });

    it('TC-B6: maxModules=1 → 只允许一个模块活跃', () => {
      const state = {
        tasks: [
          { id: 'T1', status: 'pending' },
          { id: 'R1', kind: 'review', status: 'pending', deps: ['T1'] },
          { id: 'X1', kind: 'test', status: 'pending', deps: ['R1', 'T1'] },
          { id: 'T4', status: 'pending' },
          { id: 'R3', kind: 'review', status: 'pending', deps: ['T4'] },
          { id: 'X2', kind: 'test', status: 'pending', deps: ['R3', 'T4'] },
        ],
      };
      // 模块 X1={T1,R1}, X2={T4,R3}。maxModules=1 → 只取第一个模块的任务
      expect(selectReadyBatch(state, { agents: { max: 9, maxModules: 1 } }).map(t => t.id)).toEqual(['T1']);
    });

    it('TC-B7: review gate deps 全 done 后 ready', () => {
      const state = {
        tasks: [
          { id: 'T1', status: 'done' },
          { id: 'R1', kind: 'review', status: 'pending', deps: ['T1'] },
        ],
      };
      expect(selectReadyBatch(state).map(t => t.id)).toEqual(['R1']);
    });

    it('TC-B8: 全部完成 / 无 tasks → 空批次', () => {
      expect(selectReadyBatch({ tasks: [{ id: 'T1', status: 'done' }] })).toEqual([]);
      expect(selectReadyBatch({ tasks: [] })).toEqual([]);
      expect(selectReadyBatch({})).toEqual([]);
    });

    it('TC-B9: max=1 返回首个 ready（与 findNextTask 语义一致）', () => {
      const state = {
        tasks: [
          { id: 'T1', status: 'done' },
          { id: 'T2', status: 'pending' },
          { id: 'T3', status: 'pending' },
        ],
      };
      expect(selectReadyBatch(state).map(t => t.id)).toEqual(['T2']);
    });
  });
});
