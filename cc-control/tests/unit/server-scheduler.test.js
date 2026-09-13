import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
// 新 server 树的调度器是 ESM（export），用动态 import 拿命名导出
const { runScheduler } = await import('../../server/run/scheduler.js');

// 本文件测的是新 server 树（server/run/scheduler.js）。旧树 src/server/run-scheduler.js 仍在
// 被 awf run 执行，其回归由 tests/unit/scheduler.test.js 负责。

const CFG = (agents) => ({ agents: { max: 9, maxModules: 3, maxPerModule: 9, maxPerFeature: 9, ...agents } });

function writeState(root, tasks) {
  fs.mkdirSync(path.join(root, '.awf'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.awf', 'state.json'),
    JSON.stringify({ mode: 'run', currentState: 'CODE', tasks }, null, 2),
  );
}

describe('server · 滑动窗口调度器 shouldStop', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-server-scheduler-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  // 若 shouldStop 被忽略，循环会在 done:[] 上永远打转 —— 用次数上限让它快速失败而不是挂住整个套件
  function neverDone(limit = 5) {
    let calls = 0;
    return async () => {
      if (++calls > limit) throw new Error('shouldStop 未被调度循环采纳：waitAnyDone 被反复调用');
      return { done: [], suspended: false };
    };
  }

  it('停止位上置位后主循环退出，不再补位（池中仍有就绪任务）', async () => {
    writeState(root, [
      { id: 'T1', kind: 'dev', plannedFiles: ['a.js'], status: 'pending', deps: [] },
      { id: 'T2', kind: 'dev', plannedFiles: ['b.js'], status: 'pending', deps: [] },
    ]);
    const sent = [];
    let stopCalls = 0;
    // 第 1 次 false（放过首轮派发），第 2 次 true（等完一轮后应立刻退出）
    const { dispatched } = await runScheduler({
      projectRoot: root,
      cfg: CFG({ max: 1 }),
      dispatcher: { send: async (task) => { sent.push(task.id); return true; } },
      waitAnyDone: neverDone(),
      shouldStop: () => (++stopCalls > 1),
    });

    expect(dispatched).toBe(1);   // 首轮派了 T1 之后才置位
    expect(sent).toEqual(['T1']); // 置位后 T2 不再补位
    expect(stopCalls).toBe(2);    // 主循环每轮开头检查一次
  });

  it('一开始就置位 → 一个任务都不派，也不进入等待', async () => {
    writeState(root, [
      { id: 'T1', kind: 'dev', plannedFiles: ['a.js'], status: 'pending', deps: [] },
    ]);
    const sent = [];
    const { dispatched } = await runScheduler({
      projectRoot: root,
      cfg: CFG({ max: 1 }),
      dispatcher: { send: async (task) => { sent.push(task.id); return true; } },
      waitAnyDone: async () => { throw new Error('置位后不应进入等待'); },
      shouldStop: () => true,
    });

    expect(dispatched).toBe(0);
    expect(sent).toEqual([]);
  });

  it('未传 shouldStop 时行为不变（向后兼容）', async () => {
    writeState(root, [
      { id: 'T1', kind: 'dev', plannedFiles: ['a.js'], status: 'pending', deps: [] },
    ]);
    // 与真实落账一致：waitAnyDone 返回前把完成的任务标 done 落盘，池刷新后不会重复派发
    const waitAnyDone = async () => {
      const s = JSON.parse(fs.readFileSync(path.join(root, '.awf', 'state.json'), 'utf8'));
      for (const t of s.tasks) if (t.id === 'T1') t.status = 'done';
      fs.writeFileSync(path.join(root, '.awf', 'state.json'), JSON.stringify(s));
      return { done: ['T1'], suspended: false };
    };
    const { dispatched } = await runScheduler({
      projectRoot: root,
      cfg: CFG({ max: 1 }),
      dispatcher: { send: async () => true },
      waitAnyDone,
    });

    expect(dispatched).toBe(1);
  });
});
