import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runScheduler } from '../../src/cli/scheduler.js';

// scheduler 用真实 loadState 读 .awf/state.json；dispatcher/waitAnyDone 为注入接口。
// waitAnyDone 的 mock 在每次返回前把「已完成任务」标 done 落盘，模拟真实落账 → 池刷新。

function writeState(root, tasks) {
  fs.mkdirSync(path.join(root, '.awf'), { recursive: true });
  fs.writeFileSync(path.join(root, '.awf', 'state.json'), JSON.stringify({ mode: 'run', currentState: 'CODE', tasks }, null, 2));
}

describe('runScheduler — 滑动窗口核心（纯逻辑）', () => {
  let tmpDir;
  let sent;
  let dispatcher;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-scheduler-'));
    sent = [];
    dispatcher = { send: async (task) => { sent.push(task.id); } };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 构造 waitAnyDone：按脚本顺序返回完成任务，返回前落盘标 done（模拟落账 → 池刷新） */
  function makeWaitAnyDone(completionScript) {
    return async (running) => { // running 由调度器传入（轮询用），测试忽略
      const done = completionScript.shift();
      if (!done) return [];
      const s = JSON.parse(fs.readFileSync(path.join(tmpDir, '.awf', 'state.json'), 'utf-8'));
      for (const id of done) {
        const t = s.tasks.find((x) => x.id === id);
        if (t) t.status = 'done';
      }
      fs.writeFileSync(path.join(tmpDir, '.awf', 'state.json'), JSON.stringify(s));
      return done;
    };
  }

  const CFG = (agents) => ({ agents: { max: 9, maxModules: 3, maxPerModule: 9, maxPerFeature: 9, ...agents } });

  it('TC-S1: 滑动窗口补位——任务完成立即补位，保持配额满', async () => {
    writeState(tmpDir, [
      { id: 'T1', kind: 'dev', plannedFiles: ['a.js'], status: 'pending', deps: [] },
      { id: 'T2', kind: 'dev', plannedFiles: ['b.js'], status: 'pending', deps: [] },
      { id: 'T3', kind: 'dev', plannedFiles: ['c.js'], status: 'pending', deps: [] },
      { id: 'T4', kind: 'dev', plannedFiles: ['d.js'], status: 'pending', deps: [] },
      { id: 'T5', kind: 'dev', plannedFiles: ['e.js'], status: 'pending', deps: [] },
    ]);

    const { dispatched } = await runScheduler({
      projectRoot: tmpDir,
      cfg: CFG({ max: 3 }),
      dispatcher,
      waitAnyDone: makeWaitAnyDone([['T1'], ['T2'], ['T3'], ['T4'], ['T5']]),
    });

    expect(dispatched).toBe(5);
    expect(sent).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
  });

  it('TC-S2: 功能级配额——同功能一次只派 1 个，完成补下一个', async () => {
    writeState(tmpDir, [
      { id: 'T1', kind: 'dev', plannedFiles: ['a.js'], status: 'pending', deps: [] },
      { id: 'T2', kind: 'dev', plannedFiles: ['b.js'], status: 'pending', deps: [] },
      { id: 'T3', kind: 'dev', plannedFiles: ['c.js'], status: 'pending', deps: [] },
      { id: 'R1', kind: 'review', plannedFiles: [], status: 'pending', deps: ['T1', 'T2', 'T3'] },
    ]);

    const { dispatched } = await runScheduler({
      projectRoot: tmpDir,
      cfg: CFG({ maxPerFeature: 1 }),
      dispatcher,
      waitAnyDone: makeWaitAnyDone([['T1'], ['T2'], ['T3'], ['R1']]),
    });

    expect(dispatched).toBe(4);
    expect(sent).toEqual(['T1', 'T2', 'T3', 'R1']); // 同功能串行；dev 全完 → review gate 进池
  });

  it('TC-S3: 门禁转换——dev 完成后 review gate 就绪进池', async () => {
    writeState(tmpDir, [
      { id: 'T1', kind: 'dev', plannedFiles: ['a.js'], status: 'pending', deps: [] },
      { id: 'R1', kind: 'review', plannedFiles: [], status: 'pending', deps: ['T1'] },
    ]);

    const { dispatched } = await runScheduler({
      projectRoot: tmpDir,
      cfg: CFG({ max: 2 }),
      dispatcher,
      waitAnyDone: makeWaitAnyDone([['T1'], ['R1']]),
    });

    expect(dispatched).toBe(2);
    expect(sent).toEqual(['T1', 'R1']); // 池刷新把 review 补进来
  });

  it('TC-S4: plannedFiles 动态冲突——冲突任务等先发者完成再派', async () => {
    writeState(tmpDir, [
      { id: 'T1', kind: 'dev', plannedFiles: ['src/x.js'], status: 'pending', deps: [] },
      { id: 'T2', kind: 'dev', plannedFiles: ['src/x.js'], status: 'pending', deps: [] },
    ]);

    const { dispatched } = await runScheduler({
      projectRoot: tmpDir,
      cfg: CFG({ max: 2 }),
      dispatcher,
      waitAnyDone: makeWaitAnyDone([['T1'], ['T2']]),
    });

    expect(dispatched).toBe(2);
    expect(sent).toEqual(['T1', 'T2']); // 同文件冲突 → 串行
  });

  it('TC-S5: doc 独占——不与任何任务并行', async () => {
    writeState(tmpDir, [
      { id: 'T1', kind: 'dev', plannedFiles: ['a.js'], status: 'pending', deps: [] },
      { id: 'D1', kind: 'doc', plannedFiles: ['README.md'], status: 'pending', deps: [] },
    ]);

    const { dispatched } = await runScheduler({
      projectRoot: tmpDir,
      cfg: CFG({ max: 2 }),
      dispatcher,
      waitAnyDone: makeWaitAnyDone([['T1'], ['D1']]),
    });

    expect(dispatched).toBe(2);
    expect(sent).toEqual(['T1', 'D1']); // D1 单独（T1 完成后）
  });

  it('TC-S6: 缺失 plannedFiles 保守串行——一次一个', async () => {
    writeState(tmpDir, [
      { id: 'T1', kind: 'dev', status: 'pending', deps: [] }, // 无 plannedFiles
      { id: 'T2', kind: 'dev', status: 'pending', deps: [] },
    ]);

    const { dispatched } = await runScheduler({
      projectRoot: tmpDir,
      cfg: CFG({ max: 2 }),
      dispatcher,
      waitAnyDone: makeWaitAnyDone([['T1'], ['T2']]),
    });

    expect(dispatched).toBe(2);
    expect(sent).toEqual(['T1', 'T2']); // 保守串行
  });
});
