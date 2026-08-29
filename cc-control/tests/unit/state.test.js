import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { loadState, saveState, findNextTask, getCurrentPhase, isMilestoneDone, selectReadyBatch, spawnGateFixTask, MAX_RECHECK } from '../../src/lib/state.js';

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

    it('TC4b: saveState 加写锁且无 .awf/state.lock 残留', () => {
      saveState(tmpDir, { mode: 'idle', version: '0.1.0' });
      // 锁文件应被释放（withStateLock finally 清理）
      expect(fs.existsSync(path.join(tmpDir, '.awf', 'state.lock'))).toBe(false);
      // state.json 正常写入
      const content = JSON.parse(fs.readFileSync(path.join(tmpDir, '.awf', 'state.json'), 'utf-8'));
      expect(content.mode).toBe('idle');
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
          { id: 'T1', status: 'pending', plannedFiles: ['src/a.js'] },
          { id: 'T2', status: 'pending', plannedFiles: ['src/b.js'] },
          { id: 'T3', status: 'pending', plannedFiles: ['src/c.js'] },
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
          { id: 'T1', status: 'pending', plannedFiles: ['src/util/a.js'] },
          { id: 'T2', status: 'pending', plannedFiles: ['src/util/b.js'] },
          { id: 'R1', kind: 'review', status: 'pending', deps: ['T1', 'T2'] },
          { id: 'T3', status: 'pending', plannedFiles: ['src/model/c.js'] },
          { id: 'R2', kind: 'review', status: 'pending', deps: ['T3'] },
        ],
      };
      // 功能: T1/T2→R1, T3→R2。maxPerFeature=1 → T1 与 T3 并行，T2 被功能配额挡下
      expect(selectReadyBatch(state, { agents: { max: 9, maxPerFeature: 1 } }).map(t => t.id)).toEqual(['T1', 'T3']);
    });

    it('TC-B5: maxPerModule=1 → 每模块最多一个任务', () => {
      const state = {
        tasks: [
          { id: 'T1', status: 'pending', plannedFiles: ['src/util/a.js'] },
          { id: 'T2', status: 'pending', plannedFiles: ['src/util/b.js'] },
          { id: 'R1', kind: 'review', status: 'pending', deps: ['T1', 'T2'] },
          { id: 'T3', status: 'pending', plannedFiles: ['src/util/c.js'] },
          { id: 'R2', kind: 'review', status: 'pending', deps: ['T3'] },
          { id: 'X1', kind: 'test', status: 'pending', deps: ['R1', 'R2', 'T1', 'T2', 'T3'] },
          { id: 'T4', status: 'pending', plannedFiles: ['src/model/d.js'] },
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
          { id: 'T1', status: 'pending', plannedFiles: ['src/util/a.js'] },
          { id: 'R1', kind: 'review', status: 'pending', deps: ['T1'] },
          { id: 'X1', kind: 'test', status: 'pending', deps: ['R1', 'T1'] },
          { id: 'T4', status: 'pending', plannedFiles: ['src/model/d.js'] },
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

    it('TC-B10: 缺失 plannedFiles → 保守串行（不进并行批次，全缺失时单独成批一次一个）', () => {
      const state = {
        tasks: [
          { id: 'T1', status: 'pending' },                       // 缺失
          { id: 'T2', status: 'pending', plannedFiles: ['a.js'] },
          { id: 'T3', status: 'pending' },                       // 缺失
        ],
      };
      // 有文件 T2 组批；缺失 T1/T3 不进批次
      expect(selectReadyBatch(state, { agents: { max: 9 } }).map(t => t.id)).toEqual(['T2']);
      // 全缺失 → 单独成批第一个
      const allMissing = { tasks: [{ id: 'A', status: 'pending' }, { id: 'B', status: 'pending' }] };
      expect(selectReadyBatch(allMissing, { agents: { max: 9 } }).map(t => t.id)).toEqual(['A']);
    });

    it('TC-B11: plannedFiles 冲突 → 不同批（后到者留到下一批）', () => {
      const state = {
        tasks: [
          { id: 'T1', status: 'pending', plannedFiles: ['src/util/math.js'] },
          { id: 'T2', status: 'pending', plannedFiles: ['src/util/math.js'] },
          { id: 'T3', status: 'pending', plannedFiles: ['src/model/order.js'] },
        ],
      };
      // T1 与 T2 同文件冲突；T3 独立。max=3 → 批 [T1, T3]
      expect(selectReadyBatch(state, { agents: { max: 3 } }).map(t => t.id)).toEqual(['T1', 'T3']);
    });

    it('TC-B12: 目录前缀冲突（src/util/ vs src/util/math.js）', () => {
      const state = {
        tasks: [
          { id: 'T1', status: 'pending', plannedFiles: ['src/util/'] },
          { id: 'T2', status: 'pending', plannedFiles: ['src/util/math.js'] },
          { id: 'T3', status: 'pending', plannedFiles: ['src/model/'] },
        ],
      };
      // T1 目录 src/util/ 与 T2 冲突；T3 独立
      expect(selectReadyBatch(state, { agents: { max: 3 } }).map(t => t.id)).toEqual(['T1', 'T3']);
    });
  });

  // ── spawnGateFixTask（门禁闭环）──

  describe('spawnGateFixTask', () => {
    const gateBase = {
      id: 'R1', kind: 'review', title: '审查 T1', status: 'blocked',
      deps: ['T1'],
      exec: { verdict: { level: 'changes_requested', conclusion: '2 处失效引用' }, files: ['.awf/reports/review/review-r1.md'] },
    };

    it('TC-G1: blocked + verdict 非 pass → 派生修复任务 + 回退门禁待复审', () => {
      const state = { tasks: [{ ...gateBase }] };
      const fixId = spawnGateFixTask(state, state.tasks[0]);
      expect(fixId).toBe('R1-F1');
      const fix = state.tasks.find((t) => t.id === 'R1-F1');
      expect(fix.kind).toBe('dev');
      expect(fix.status).toBe('pending');                     // 必须 pending 才进就绪池
      expect(fix.deps).toEqual(['T1']);                       // 复制原产物依赖
      expect(fix.plannedFiles).toEqual([]);                   // 保守串行
      expect(fix.prompt).toContain('.awf/reports/review/review-r1.md'); // 报告路径入 prompt
      expect(fix.prompt).toContain('changes_requested');      // verdict.conclusion 入 prompt
      // 门禁回退
      const gate = state.tasks.find((t) => t.id === 'R1');
      expect(gate.status).toBe('pending');
      expect(gate.deps).toEqual(['T1', 'R1-F1']);
      expect(gate.exec.recheck).toBe(1);
      expect(gate.exec.verdict).toEqual(gateBase.exec.verdict); // verdict 保留
    });

    it('TC-G2: verdict pass → 不派生', () => {
      const state = { tasks: [{ ...gateBase, exec: { verdict: { level: 'pass', conclusion: 'ok' } } }] };
      expect(spawnGateFixTask(state, state.tasks[0])).toBeNull();
      expect(state.tasks.length).toBe(1);
    });

    it('TC-G3: 无 verdict → 不派生（旧协议/卡住）', () => {
      const state = { tasks: [{ ...gateBase, exec: { result: 'x' } }] };
      expect(spawnGateFixTask(state, state.tasks[0])).toBeNull();
    });

    it('TC-G4: 非 blocked → 不派生', () => {
      const state = { tasks: [{ ...gateBase, status: 'done' }] };
      expect(spawnGateFixTask(state, state.tasks[0])).toBeNull();
    });

    it('TC-G5: 非门禁 kind → 不派生', () => {
      const state = { tasks: [{ ...gateBase, kind: 'dev' }] };
      expect(spawnGateFixTask(state, state.tasks[0])).toBeNull();
    });

    it('TC-G6: 达轮次上限 → 返回 null（保持 blocked）', () => {
      const state = { tasks: [{ ...gateBase, exec: { ...gateBase.exec, recheck: MAX_RECHECK } }] };
      expect(spawnGateFixTask(state, state.tasks[0])).toBeNull();
      expect(state.tasks[0].status).toBe('blocked');
    });

    it('TC-G7: 第二轮派生 id 递增为 -F2，deps 追加到 F1，recheck=2', () => {
      const state = {
        tasks: [
          { ...gateBase, deps: ['T1', 'R1-F1'], exec: { ...gateBase.exec, recheck: 1 } },
          { id: 'R1-F1', kind: 'dev', status: 'done', deps: ['T1'] },
        ],
      };
      const gate = state.tasks.find((t) => t.id === 'R1');
      expect(spawnGateFixTask(state, gate)).toBe('R1-F2');
      expect(state.tasks.find((t) => t.id === 'R1').deps).toEqual(['T1', 'R1-F1', 'R1-F2']);
      expect(state.tasks.find((t) => t.id === 'R1').exec.recheck).toBe(2);
      expect(state.tasks.some((t) => t.id === 'R1-F2')).toBe(true);
    });
  });
});
