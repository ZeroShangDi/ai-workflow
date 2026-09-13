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

// ── 负向判据：**不该并行**的真被拦住（讨论稿 §五 的「多 agent 负向验证」）──
// 只测「派了什么」不够 —— 要证明「该拦的拦住了」。窗口内被派发的任务 = 一轮补位的结果。

describe('server · 滑动窗口的负向判据（该拦住的真拦住）', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-server-sched-neg-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  /** 跑一个滑动窗口，收集这一轮补位派发出去的任务；waitAnyDone 前 rounds 次不返回完成，之后抛 __stop__ 收口 */
  async function dispatchedInOneWindow(cfg, tasks, rounds = 2) {
    writeState(root, tasks);
    const sent = [];
    let waits = 0;
    try {
      await runScheduler({
        projectRoot: root,
        cfg,
        dispatcher: { send: async (t) => { sent.push(t.id); return true; } },
        waitAnyDone: async () => {
          if (++waits >= rounds) throw new Error('__stop__');
          return { done: [], suspended: false };
        },
      });
    } catch (e) {
      if (e.message !== '__stop__') throw e;
    }
    return sent;
  }

  it('max=1：两个就绪任务也只派一个（配额硬上限）', async () => {
    const sent = await dispatchedInOneWindow(CFG({ max: 1 }), [
      { id: 'T1', kind: 'dev', plannedFiles: ['a.js'], status: 'pending', deps: [] },
      { id: 'T2', kind: 'dev', plannedFiles: ['b.js'], status: 'pending', deps: [] },
    ]);
    expect(sent).toEqual(['T1']);
  });

  it('max=2 且文件不冲突：两个并行派出（对照，证明确实是配额在拦而不是别的）', async () => {
    const sent = await dispatchedInOneWindow(CFG({ max: 2 }), [
      { id: 'T1', kind: 'dev', plannedFiles: ['a.js'], status: 'pending', deps: [] },
      { id: 'T2', kind: 'dev', plannedFiles: ['b.js'], status: 'pending', deps: [] },
    ]);
    expect(sent).toEqual(['T1', 'T2']);
  });

  it('plannedFiles 相同 → 不并行（配额够也不派）', async () => {
    const sent = await dispatchedInOneWindow(CFG({ max: 9 }), [
      { id: 'T1', kind: 'dev', plannedFiles: ['src/a.js'], status: 'pending', deps: [] },
      { id: 'T2', kind: 'dev', plannedFiles: ['src/a.js'], status: 'pending', deps: [] },
    ]);
    expect(sent).toEqual(['T1']);
  });

  it('plannedFiles 目录包含 → 也算冲突（src/ 与 src/a.js）', async () => {
    const sent = await dispatchedInOneWindow(CFG({ max: 9 }), [
      { id: 'T1', kind: 'dev', plannedFiles: ['src/a.js'], status: 'pending', deps: [] },
      { id: 'T2', kind: 'dev', plannedFiles: ['src'], status: 'pending', deps: [] },
    ]);
    expect(sent).toEqual(['T1']);
  });

  it('独占任务（commit）运行中 → 不派发任何其他任务', async () => {
    const sent = await dispatchedInOneWindow(CFG({ max: 9 }), [
      { id: 'C1', kind: 'commit', plannedFiles: [], status: 'pending', deps: [] },
      { id: 'T1', kind: 'dev', plannedFiles: ['a.js'], status: 'pending', deps: [] },
    ]);
    expect(sent).toEqual(['C1']);
  });
});

describe('server · 缺 plannedFiles 的保守串行（应双向生效）', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-server-sched-nofiles-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  async function window(cfg, tasks, rounds = 2) {
    writeState(root, tasks);
    const sent = [];
    let waits = 0;
    try {
      await runScheduler({
        projectRoot: root,
        cfg,
        dispatcher: { send: async (t) => { sent.push(t.id); return true; } },
        waitAnyDone: async () => { if (++waits >= rounds) throw new Error('__stop__'); return { done: [], suspended: false }; },
      });
    } catch (e) { if (e.message !== '__stop__') throw e; }
    return sent;
  }

  it('无 plannedFiles 的任务在跑时，别的任务也不得并行进入（无法判定冲突面 → 保守串行）', async () => {
    const sent = await window(CFG({ max: 9 }), [
      { id: 'N1', kind: 'dev', plannedFiles: [], status: 'pending', deps: [] },
      { id: 'T1', kind: 'dev', plannedFiles: ['a.js'], status: 'pending', deps: [] },
    ]);
    // 语义：N1 无文件声明 → 冲突面未知 → 不许与任何任务并行。
    // 实现若只拦「N1 入池」而放行「别人与它并行」，这里会得到 ['N1','T1']。
    expect(sent).toEqual(['N1']);
  });
});
