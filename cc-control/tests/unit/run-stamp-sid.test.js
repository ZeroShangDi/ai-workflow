import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveRunStamp } = require('../../src/lib/run-id.cjs');
const { DecisionStore } = require('../../src/server/decision-store.cjs');

// T1-072：runStamp→sid 归一 + 决策 per-run 目录隔离（decision 不串 run）。

describe('resolveRunStamp（runStamp→sid 归一）', () => {
  it('显式 sid 即 run stamp；无 sid 回退派生 <version>-<ts>', () => {
    expect(resolveRunStamp({ sid: 'r1', version: '0.2.0' })).toBe('r1');
    expect(resolveRunStamp({ version: '0.2.0', ts: new Date('2026-09-09T08:00:00Z') }))
      .toBe('0.2.0-2026-09-09T08-00-00');
  });
  it('非法 sid 抛错', () => {
    expect(() => resolveRunStamp({ sid: '../bad', version: '0.2.0' })).toThrow();
  });
});

describe('DecisionStore per-run 隔离（runsDir + runStamp=sid）', () => {
  let tmp;
  let dirA;
  let dirB;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-dec-perrun-'));
    dirA = path.join(tmp, 'runs-a', 'decisions');
    dirB = path.join(tmp, 'runs-b', 'decisions');
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('run a 落决策到 <sid>.jsonl 且不串 run b', () => {
    const a = new DecisionStore(tmp, { runStamp: 'r1', runsDir: dirA });
    const b = new DecisionStore(tmp, { runStamp: 'r2', runsDir: dirB });

    expect(a.runStamp()).toBe('r1');
    expect(b.runStamp()).toBe('r2');

    const r = a.append({ decision_id: 'D-1', event: 'decision_completed', at: new Date().toISOString() });
    expect(r.appended).toBe(true);
    expect(r.file).toBe(path.join(dirA, 'r1.jsonl'));

    // b 目录无任何记录（不串 run）
    expect(b.listAll()).toEqual([]);
    // a 目录恰好一条
    expect(a.listAll()).toHaveLength(1);
    expect(a.listAll()[0]).toMatchObject({ runStamp: 'r1', decision_id: 'D-1' });
  });

  it('override 只命中本 run 文件', () => {
    const a = new DecisionStore(tmp, { runStamp: 'r1', runsDir: dirA });
    const b = new DecisionStore(tmp, { runStamp: 'r2', runsDir: dirB });
    a.append({ decision_id: 'D-A', event: 'decision_completed', at: new Date().toISOString() });

    const ov = a.override('D-A', { instruction: '改 A' });
    expect(ov.file).toBe(path.join(dirA, 'r1.jsonl'));
    // b 找 D-A → 抛错（不串读 b）
    expect(() => b.override('D-A', { instruction: 'x' })).toThrow('决策记录不存在');
  });
});
