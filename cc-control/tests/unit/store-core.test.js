import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { withFileLock, atomicWriteFileSync, writeJsonAtomicSync, readJsonSync, updateStateSync, DEFAULT_LOCK_TIMEOUT_MS } from '../../src/lib/store-core.js';

// store-core（W1-010/011 / T1-015）：单写序列化 + 原子写。
// - withFileLock：锁文件互斥（openSync 'wx'），持锁期间二次获取超时抛错；父目录自建
// - atomicWriteFileSync / writeJsonAtomicSync：同目录临时文件 + rename，失败清理，无 .tmp 残留
// - readJsonSync：缺失/非法 → null
// - updateStateSync：锁内 读→mutator→补 lastUpdated→原子写；mutator 返回 false 不写盘

const tmpDirs = [];

function tmpPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-storecore-'));
  tmpDirs.push(dir);
  return { dir, statePath: path.join(dir, 'state.json'), lockPath: path.join(dir, 'state.lock') };
}

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

const listTmp = (dir) => fs.readdirSync(dir).filter((f) => f.includes('.tmp'));

describe('withFileLock — 单写序列化', () => {
  it('持锁执行 fn，释放后锁文件无残留', () => {
    const { lockPath } = tmpPaths();
    let ran = false;
    withFileLock(lockPath, () => { ran = true; });
    expect(ran).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('持锁期间二次获取 → 超时抛错', () => {
    const { lockPath } = tmpPaths();
    expect(() =>
      withFileLock(lockPath, () => {
        withFileLock(lockPath, () => {}, { timeoutMs: 60 });
      }, { timeoutMs: 400 }),
    ).toThrowError(/timeout/);
  });

  it('锁文件父目录不存在时自建（首次写 .awf）', () => {
    const dir = path.join(os.tmpdir(), `awf-storecore-nested-${Date.now()}`);
    tmpDirs.push(dir);
    const lockPath = path.join(dir, '.awf', 'state.lock');
    withFileLock(lockPath, () => {});
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('fn 抛错仍释放锁', () => {
    const { lockPath } = tmpPaths();
    expect(() => withFileLock(lockPath, () => { throw new Error('boom'); })).toThrowError('boom');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('DEFAULT_LOCK_TIMEOUT_MS = 5000（与既有实现一致）', () => {
    expect(DEFAULT_LOCK_TIMEOUT_MS).toBe(5000);
  });
});

describe('atomicWriteFileSync / writeJsonAtomicSync — 原子写', () => {
  it('写入成功且内容一致，无 .tmp 残留', () => {
    const { dir, statePath } = tmpPaths();
    writeJsonAtomicSync(statePath, { tasks: [{ id: 'T1' }] });
    expect(readJsonSync(statePath).tasks[0].id).toBe('T1');
    expect(listTmp(dir)).toHaveLength(0);
  });

  it('原子覆盖已存在文件（rename 语义）', () => {
    const { dir, statePath } = tmpPaths();
    writeJsonAtomicSync(statePath, { v: 1 });
    writeJsonAtomicSync(statePath, { v: 2 });
    expect(readJsonSync(statePath).v).toBe(2);
    expect(listTmp(dir)).toHaveLength(0);
  });

  it('父目录缺失自建', () => {
    const dir = path.join(os.tmpdir(), `awf-storecore-atomic-${Date.now()}`);
    tmpDirs.push(dir);
    const p = path.join(dir, 'deep', 'a.json');
    atomicWriteFileSync(p, '{"a":1}');
    expect(fs.readFileSync(p, 'utf8')).toBe('{"a":1}');
  });

  it('写失败清理临时文件并抛错', () => {
    const { dir } = tmpPaths();
    const target = path.join(dir, 'occupied'); // 目标已被目录占用 → rename 失败
    fs.mkdirSync(target);
    expect(() => atomicWriteFileSync(target, '{}')).toThrow();
    expect(listTmp(dir)).toHaveLength(0);
  });
});

describe('readJsonSync — 读取', () => {
  it('缺失 → null；非法 JSON → null；正常 → 对象', () => {
    const { dir, statePath } = tmpPaths();
    expect(readJsonSync(statePath)).toBeNull();
    fs.writeFileSync(statePath, '{ broken');
    expect(readJsonSync(statePath)).toBeNull();
    writeJsonAtomicSync(statePath, { ok: true });
    expect(readJsonSync(statePath)).toEqual({ ok: true });
  });
});

describe('updateStateSync — 锁内读→改→原子写', () => {
  it('mutator 改字段 → 落盘且补 lastUpdated；返回 mutator 结果', () => {
    const { statePath, lockPath } = tmpPaths();
    const r = updateStateSync({ statePath, lockPath, mutator: (s) => { s.mode = 'run'; return { ok: true }; } });
    expect(r).toEqual({ ok: true });
    const s = readJsonSync(statePath);
    expect(s.mode).toBe('run');
    expect(typeof s.lastUpdated).toBe('string');
  });

  it('mutator 返回 false → 不写盘', () => {
    const { statePath, lockPath } = tmpPaths();
    const r = updateStateSync({ statePath, lockPath, mutator: () => false });
    expect(r).toBe(false);
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it('mutator 就地改既有 state（保留未触碰字段）', () => {
    const { statePath, lockPath } = tmpPaths();
    writeJsonAtomicSync(statePath, { mode: 'idle', keep: 1 });
    updateStateSync({ statePath, lockPath, mutator: (s) => { s.mode = 'run'; return true; } });
    const s = readJsonSync(statePath);
    expect(s.mode).toBe('run');
    expect(s.keep).toBe(1);
  });

  it('锁内读的是最新 state（互斥生效）', () => {
    const { statePath, lockPath } = tmpPaths();
    writeJsonAtomicSync(statePath, { mode: 'idle', n: 0 });
    updateStateSync({ statePath, lockPath, mutator: (s) => { s.n += 1; return true; } });
    updateStateSync({ statePath, lockPath, mutator: (s) => { s.n += 1; return true; } });
    expect(readJsonSync(statePath).n).toBe(2);
  });
});
