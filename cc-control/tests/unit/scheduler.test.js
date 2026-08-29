import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runScheduler } from '../../src/cli/scheduler.js';
import { handleGateCompletion } from '../../src/cli/gate-fix.js';
import { MAX_RECHECK } from '../../src/lib/state.js';

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

  /** 构造 waitAnyDone：按脚本顺序返回完成任务；元素可为数组（done）或 { done, suspended } */
  function makeWaitAnyDone(completionScript) {
    return async (running) => { // running 由调度器传入（轮询用），测试忽略
      const step = completionScript.shift();
      if (!step) return { done: [], suspended: false };
      const done = Array.isArray(step) ? step : (step.done || []);
      const s = JSON.parse(fs.readFileSync(path.join(tmpDir, '.awf', 'state.json'), 'utf-8'));
      for (const id of done) {
        const t = s.tasks.find((x) => x.id === id);
        if (t) t.status = 'done';
      }
      fs.writeFileSync(path.join(tmpDir, '.awf', 'state.json'), JSON.stringify(s));
      return { done, suspended: !Array.isArray(step) && !!step.suspended };
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

  it('TC-F: 决策挂起（suspended）→ 不补位，决策解决后恢复补位', async () => {
    writeState(tmpDir, [
      { id: 'T1', kind: 'dev', plannedFiles: ['a.js'], status: 'pending', deps: [] },      // 会 needs_input 挂起
      { id: 'T3', kind: 'dev', plannedFiles: ['c.js'], status: 'pending', deps: [] },      // 正常完成
      { id: 'T2', kind: 'dev', plannedFiles: ['b.js'], status: 'pending', deps: ['T3'] },  // T3 完成后就绪
    ]);

    const { dispatched } = await runScheduler({
      projectRoot: tmpDir,
      cfg: CFG({ max: 3 }),
      dispatcher,
      waitAnyDone: makeWaitAnyDone([
        { done: ['T3'], suspended: true },  // T3 完成但 T1 决策挂起 → T2 就绪但不补位
        { done: [], suspended: true },       // 仍挂起
        { done: ['T1'], suspended: false },  // T1 决策解决 → 恢复补位 → T2 派发
        { done: ['T2'], suspended: false },
      ]),
    });

    expect(dispatched).toBe(3);
    expect(sent).toEqual(['T1', 'T3', 'T2']); // 挂起期间 T2 未被派发（暂停补位），解决后才派
  });

  it('TC-S7: 门禁闭环——门禁 fail 落账 → 派生修复任务自动补位 → 复审 pass → done', async () => {
    writeState(tmpDir, [
      { id: 'T1', kind: 'dev', plannedFiles: ['a.js'], status: 'pending', deps: [] },
      { id: 'R1', kind: 'review', title: '审查 T1', plannedFiles: [], status: 'pending', deps: ['T1'] },
    ]);

    // 模拟子 Agent 真实落账：T1 done；R1 首次执行 → blocked + verdict fail；
    // 复审（exec.recheck>=1）→ done + verdict pass；R1-F1（派生修复）→ done
    const completionSteps = [['T1'], ['R1'], ['R1-F1'], ['R1']];
    const waitAnyDone = async () => {
      const done = completionSteps.shift() || [];
      const s = JSON.parse(fs.readFileSync(path.join(tmpDir, '.awf', 'state.json'), 'utf-8'));
      for (const id of done) {
        const t = s.tasks.find((x) => x.id === id);
        if (!t) continue;
        if (id === 'R1') {
          const isFinal = (t.exec?.recheck || 0) >= 1; // 有 recheck → 修复已派发过 → 本轮是复审
          t.status = isFinal ? 'done' : 'blocked';
          t.exec = t.exec || {};
          t.exec.verdict = isFinal ? { level: 'pass', conclusion: '复审通过' } : { level: 'fail', conclusion: '方向性错误' };
          t.exec.files = ['.awf/reports/review/review-r1.md'];
        } else {
          t.status = 'done';
        }
      }
      fs.writeFileSync(path.join(tmpDir, '.awf', 'state.json'), JSON.stringify(s));
      return { done, suspended: false };
    };

    const { dispatched } = await runScheduler({
      projectRoot: tmpDir,
      cfg: CFG({ max: 1 }),
      dispatcher,
      waitAnyDone,
      // 真实门禁闭环钩子（非 mock）：blocked + verdict fail → 派生修复 + 回退复审
      onTaskComplete: async (id, task) => { await handleGateCompletion(tmpDir, id, task); },
    });

    // 完整闭环派发序列：产物 → 门禁 → 自动派生修复 → 修复完成 → 门禁复审
    expect(sent).toEqual(['T1', 'R1', 'R1-F1', 'R1']);
    expect(dispatched).toBe(4);

    const final = JSON.parse(fs.readFileSync(path.join(tmpDir, '.awf', 'state.json'), 'utf-8'));
    expect(final.tasks.find((t) => t.id === 'R1').status).toBe('done'); // 复审通过，闭环收敛
    expect(final.tasks.some((t) => t.id === 'R1-F1')).toBe(true);      // 修复任务真实派生
    expect(final.tasks.find((t) => t.id === 'R1').exec.recheck).toBe(1);
  });

  it('TC-S8: 门禁闭环达轮次上限——修复任务持续派生到 MAX_RECHECK 后停', async () => {
    writeState(tmpDir, [
      { id: 'T1', kind: 'dev', plannedFiles: ['a.js'], status: 'pending', deps: [] },
      { id: 'R1', kind: 'review', title: '审查 T1', plannedFiles: [], status: 'pending', deps: ['T1'] },
    ]);

    // 每次门禁执行都 fail（复审也 fail）→ 调度器不断派生修复 → 第 4 次门禁执行达上限 → 停。
    // 完成序列（8 步）：T1, R1(blocked)→F1, F1, R1(blocked)→F2, F2, R1(blocked)→F3, F3, R1(blocked→上限)
    const steps = [
      ['T1'], ['R1'], ['R1-F1'], ['R1'], ['R1-F2'], ['R1'], ['R1-F3'], ['R1'],
    ];

    let i = 0;
    const stepWait = async () => {
      if (i >= steps.length) throw new Error('completion steps exhausted — 调度序列与预期不符');
      const done = steps[i];
      i++;
      const s = JSON.parse(fs.readFileSync(path.join(tmpDir, '.awf', 'state.json'), 'utf-8'));
      for (const id of done) {
        const t = s.tasks.find((x) => x.id === id);
        if (!t) continue;
        if (id === 'R1') {
          t.status = 'blocked'; // 门禁每次执行都 fail
          t.exec = t.exec || {};
          t.exec.verdict = { level: 'fail', conclusion: '仍失败' };
          t.exec.files = ['.awf/reports/review/review-r1.md'];
        } else {
          t.status = 'done'; // 产物 / 修复任务正常完成
        }
      }
      fs.writeFileSync(path.join(tmpDir, '.awf', 'state.json'), JSON.stringify(s));
      return { done, suspended: false };
    };

    const { dispatched } = await runScheduler({
      projectRoot: tmpDir,
      cfg: CFG({ max: 1 }),
      dispatcher,
      waitAnyDone: stepWait,
      onTaskComplete: async (id, task) => { await handleGateCompletion(tmpDir, id, task); },
    });

    // T1 + R1×4 + F1/F2/F3 = 8 次派发；第 4 次 R1 达上限不再派生
    expect(dispatched).toBe(8);
    const final = JSON.parse(fs.readFileSync(path.join(tmpDir, '.awf', 'state.json'), 'utf-8'));
    expect(final.tasks.filter((t) => t.id.startsWith('R1-F'))).toHaveLength(MAX_RECHECK);
    expect(final.tasks.find((t) => t.id === 'R1').status).toBe('blocked'); // 达上限保持 blocked
  });
});
