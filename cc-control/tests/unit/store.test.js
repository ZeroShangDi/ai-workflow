import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import store from '../../src/lib/store.cjs';

const {
  createWriteQueue,
  createJsonFileStore,
  createAppendFileStore,
  createSnapshotStore,
  createRunStores,
} = store;

// store 骨架层（W1-017 / T1-025）：写/读 API + 进程内串行化队列 + 每 run 布局分流。

const tmpDirs = [];
function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-store-'));
  tmpDirs.push(dir);
  return dir;
}
const withLock = (base) => path.join(base, 'state.lock');

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('createWriteQueue — 进程内串行化', () => {
  it('FIFO 依序执行，不同时长任务不交错', async () => {
    const q = createWriteQueue();
    const order = [];
    await Promise.all([1, 2, 3].map((i) => q.enqueue(async () => {
      await new Promise((r) => setTimeout(r, i === 1 ? 20 : 1));
      order.push(i);
      return i;
    })));
    expect(order).toEqual([1, 2, 3]);
  });

  it('单步失败不影响后续任务，且该步结果可被捕获', async () => {
    const q = createWriteQueue();
    const errP = q.enqueue(() => { throw new Error('boom'); }).then(() => 'ok').catch((e) => e.message);
    const after = await q.enqueue(() => 'done');
    expect(await errP).toBe('boom');
    expect(after).toBe('done');
  });
});

describe('createJsonFileStore — 单文档 JSON', () => {
  it('writeSync/readSync/updateSync（false 不写、true 就地写、对象整份替换、null 缺失可建）', () => {
    const dir = tmpPath();
    const sp = path.join(dir, 'state.json');
    const store = createJsonFileStore({ filePath: sp, lockPath: withLock(dir) });

    // updateSync 在文件缺失时用返回对象建（普通对象 = 整份替换）
    expect(store.updateSync((s) => ({ mode: 'run', tasks: [] }))).toEqual({ mode: 'run', tasks: [] });
    expect(store.readSync()).toEqual({ mode: 'run', tasks: [] });

    // true + 就地改
    expect(store.updateSync((s) => { s.mode = 'idle'; return true; })).toBe(true);
    expect(store.readSync().mode).toBe('idle');

    // false 不写
    expect(store.updateSync(() => false)).toBe(false);
    expect(store.readSync().mode).toBe('idle');

    // writeSync 覆盖
    store.writeSync({ v: 2 });
    expect(store.readSync()).toEqual({ v: 2 });
  });

  it('锁内读最新（互斥累加）', () => {
    const dir = tmpPath();
    const store = createJsonFileStore({ filePath: path.join(dir, 's.json'), lockPath: withLock(dir) });
    store.writeSync({ n: 0 });
    store.updateSync((s) => { s.n += 1; return true; });
    store.updateSync((s) => { s.n += 1; return true; });
    expect(store.readSync().n).toBe(2);
  });

  it('异步 update 经队列串行、支持缺失建对象', async () => {
    const dir = tmpPath();
    const store = createJsonFileStore({ filePath: path.join(dir, 'usage.json') });
    await Promise.all([1, 2, 3, 4].map((i) => store.update(async (s) => {
      await new Promise((r) => setTimeout(r, i === 1 ? 15 : 1));
      const base = s || { n: 0 };
      base.n += 1;
      return s ? true : base; // 缺失（首个）以对象建；已有就地改
    })));
    expect(store.readSync().n).toBe(4);
  });

  it('缺失文件 readSync → null', () => {
    const dir = tmpPath();
    expect(createJsonFileStore({ filePath: path.join(dir, 'none.json') }).readSync()).toBeNull();
  });
});

describe('createAppendFileStore — 追加流', () => {
  it('json 模式：appendSync 写 jsonl、readAllSync 容忍坏行', () => {
    const dir = tmpPath();
    const fp = path.join(dir, 'd.jsonl');
    const store = createAppendFileStore({ filePath: fp, json: true });
    store.appendSync({ id: 1 });
    fs.appendFileSync(fp, '{broken}\n', 'utf8');
    store.appendSync({ id: 2 });
    const all = store.readAllSync();
    expect(all).toEqual([{ id: 1 }, { id: 2 }]); // 坏行跳过
  });

  it('appendRaw 原样追加（不加换行/不 JSON 化）', () => {
    const dir = tmpPath();
    const fp = path.join(dir, 'main.log');
    const store = createAppendFileStore({ filePath: fp });
    store.appendRawSync('line1');
    expect(fs.readFileSync(fp, 'utf8')).toBe('line1');
  });

  it('非 json 模式 readAllSync 返回行数组；缺失 → []', () => {
    const dir = tmpPath();
    const fp = path.join(dir, 'x.log');
    const store = createAppendFileStore({ filePath: fp });
    expect(store.readAllSync()).toEqual([]);
    store.appendSync('a');
    store.appendSync('b');
    expect(store.readAllSync()).toEqual(['a', 'b']);
  });
});

describe('createSnapshotStore — 版本快照', () => {
  it('命名 ${version}-${ts}.json 且原子写、listSync 排序', () => {
    const dir = tmpPath();
    const snap = createSnapshotStore({ dir: path.join(dir, 'versions') });
    const file = snap.snapshotSync({ v: 1 }, { version: '0.2.0', ts: new Date('2026-09-07T13:09:35.000Z') });
    expect(path.basename(file)).toBe('0.2.0-2026-09-07T13-09-35.json');
    expect(snap.listSync()).toEqual(['0.2.0-2026-09-07T13-09-35.json']);
  });

  it('非法时间戳抛错', () => {
    const snap = createSnapshotStore({ dir: tmpPath() });
    expect(() => snap.snapshotSync({}, { ts: 'not-a-date' })).toThrowError(/非法时间戳/);
  });
});

describe('createRunStores — 每 run / 单 run 布局分流', () => {
  const runContext = (sid) => {
    // 用最小 ctx 形状（等价 buildRunContext 输出）驱动分流
    return {
      sid: sid ?? null,
      runDir: sid ? `${'/p'}/.awf/runs/${sid}` : undefined,
      runStatePath: sid ? `${'/p'}/.awf/runs/${sid}/state.json` : undefined,
      runUsagePath: sid ? `${'/p'}/.awf/runs/${sid}/context/usage.json` : undefined,
      statePath: `${'/p'}/.awf/state.json`,
      contextUsagePath: `${'/p'}/.awf/context/usage.json`,
      runConfigPath: `${'/p'}/.awf/config.json`,
      runMetaPath: sid ? `${'/p'}/.awf/runs/${sid}/meta/run-meta.json` : `${'/p'}/.awf/logs/run-meta.json`,
      awfDir: `${'/p'}/.awf`,
    };
  };

  it('无 sid：state 落 .awf 根并带 lock；有 sid：落 runs/<sid>', () => {
    const legacy = createRunStores(runContext(null));
    expect(legacy.state.filePath).toBe('/p/.awf/state.json');
    const perRun = createRunStores(runContext('r1'));
    expect(perRun.state.filePath).toBe('/p/.awf/runs/r1/state.json');
    expect(perRun.usage.filePath).toBe('/p/.awf/runs/r1/context/usage.json');
    expect(perRun.meta.filePath).toBe('/p/.awf/runs/r1/meta/run-meta.json');
    expect(legacy.snapshots.dir).toBe('/p/.awf/versions');
  });
});
