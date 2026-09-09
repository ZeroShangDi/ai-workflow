import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

import {
  loadState, saveState, markTaskActive, findNextTask, setWorkflowMode,
} from '../../src/lib/state.js';
import { handleGateCompletion } from '../../src/server/gate-fix.js';
import { runScheduler } from '../../src/server/run-scheduler.js';
import runDriver from '../../src/server/run-driver.cjs';

const require = createRequire(import.meta.url);
const { createRunHost } = require('../../src/server/run-host.cjs');

// run-host 编排核心（T1-105）：真实 state/run-driver/gateCompletionHook/runScheduler 注入，
// per-task 模型通道用 fake executor 替代（真实通道待 T1-058 组装）。tmp .awf/state.json 作真源。

function writeState(root, tasks, extra = {}) {
  fs.mkdirSync(path.join(root, '.awf'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.awf', 'state.json'),
    JSON.stringify({ mode: 'run', currentState: 'CODE', tasks, ...extra }, null, 2),
  );
}

function readState(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.awf', 'state.json'), 'utf-8'));
}

const stateApi = { loadState, saveState, markTaskActive, findNextTask, setWorkflowMode };
const CFG_SINGLE = { agents: { max: 1, maxModules: 1, maxPerModule: 1, maxPerFeature: 1 } };

describe('createRunHost — 生命周期 + 提交守卫', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-runhost-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('start/stop/reset 生命周期 + hostState 迁移', () => {
    const host = createRunHost({ projectRoot: tmp, cfg: CFG_SINGLE, state: stateApi, chain: runDriver });
    expect(host.hostState).toBe('idle');
    expect(host.start().state).toBe('running');
    expect(host.start().state).toBe('running'); // 幂等
    expect(host.stop().state).toBe('stopped');
    // stopped 后 submit 拒绝
    writeState(tmp, [{ id: 'T1', kind: 'dev', status: 'pending', deps: [] }]);
    const r = host.submitRun();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('已停止');
    host.start();
    expect(host.reset().ok).toBe(true);
  });

  it('host 初始未接线 executor 时，单 agent 提交以 error 收场（可读信息）', async () => {
    writeState(tmp, [{ id: 'T1', kind: 'dev', status: 'pending', deps: [] }]);
    const host = createRunHost({ projectRoot: tmp, cfg: CFG_SINGLE, state: stateApi, chain: runDriver });
    host.start();
    expect(host.singleReady).toBe(false);
    const r = host.submitRun();
    expect(r.ok).toBe(true);
    await waitDone(host, r.runId);
    const snap = host.snapshot(r.runId).run;
    expect(snap.status).toBe('error');
    expect(snap.error).toContain('未接线 executor');
  });

  it('host 同时只驱动一个 run：二次 submit → 409', async () => {
    writeState(tmp, [{ id: 'T1', kind: 'dev', status: 'pending', deps: [] }]);
    // 执行器延迟结算，制造「a 仍在 running」窗口
    const executor = {
      runTask: async ({ projectRoot, taskId }) => {
        await new Promise((r) => setTimeout(r, 50));
        const s = readState(projectRoot);
        const t = s.tasks.find((x) => x.id === taskId);
        t.status = 'done'; t.exec = { result: 'ok' };
        saveState(projectRoot, s);
        return { status: 'done' };
      },
    };
    const host = createRunHost({
      projectRoot: tmp, cfg: CFG_SINGLE, state: stateApi, chain: runDriver, executor,
    });
    host.start();
    const r1 = host.submitRun({ runId: 'a' });
    expect(r1.ok).toBe(true);
    const r2 = host.submitRun({ runId: 'b' });
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('单槽');
    await waitDone(host, 'a');
    expect(host.snapshot('a').run.status).toBe('done');
  });
});

describe('createRunHost — 单 agent 编排（经 run-driver 链标注 + executor 结算 + 门禁锚点）', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-runhost-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function makeExecutor(settleFn) {
    return {
      runTask: async (ctx) => {
        settleFn(ctx);
        return { status: readState(ctx.projectRoot).tasks.find((t) => t.id === ctx.taskId)?.status };
      },
    };
  }

  /** 顺序执行：findNextTask 的 T1 → T2（T2 deps T1） */
  it('单 agent happy path：顺序选任务 + executor 结算 + run 收尾 done', async () => {
    writeState(tmp, [
      { id: 'T1', kind: 'dev', plannedFiles: ['a.js'], status: 'pending', deps: [] },
      { id: 'T2', kind: 'dev', plannedFiles: ['b.js'], status: 'pending', deps: ['T1'] },
    ]);
    const doneOrder = [];
    const executor = makeExecutor(({ taskId }) => {
      doneOrder.push(taskId);
      const s = readState(tmp);
      const t = s.tasks.find((x) => x.id === taskId);
      t.status = 'done';
      t.exec = { result: 'ok', files: [taskId === 'T1' ? 'a.js' : 'b.js'] };
      saveState(tmp, s);
    });
    const events = [];
    const host = createRunHost({
      projectRoot: tmp, cfg: CFG_SINGLE, state: stateApi, chain: runDriver,
      executor, onEvent: (e) => events.push(e),
    });
    host.start();
    const r = host.submitRun();
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('single');
    await waitDone(host, r.runId);

    const snap = host.snapshot(r.runId).run;
    expect(snap.status).toBe('done');
    expect(snap.counts).toMatchObject({ total: 2, done: 2, blocked: 0 });
    expect(doneOrder).toEqual(['T1', 'T2']); // deps 有序：T2 在 T1 后
    // 真实 state 落账
    const s = readState(tmp);
    expect(s.tasks.map((t) => t.status)).toEqual(['done', 'done']);

    // 事件序
    const types = events.map((e) => e.type);
    expect(types).toContain('run.submitted');
    expect(types).toContain('run.started');
    expect(types).toContain('run.stopped');
    const taskIds = events.filter((e) => e.type === 'task.started').map((e) => e.payload.taskId);
    expect(taskIds).toEqual(['T1', 'T2']);
    expect(events.filter((e) => e.type === 'task.started').every((e) => Array.isArray(e.payload.chain) && e.payload.chain.length > 0)).toBe(true);
  });

  it('run-driver.decideChain 被真实消费：gate/doc 任务走保守链（不触发复杂分级）', async () => {
    writeState(tmp, [
      { id: 'G1', kind: 'review', title: '审查', status: 'pending', deps: [], plannedFiles: [] },
    ]);
    const seenChains = [];
    const executor = makeExecutor(({ taskId }) => {
      const s = readState(tmp);
      const t = s.tasks.find((x) => x.id === taskId);
      t.status = 'done'; t.exec = { verdict: { level: 'pass' } };
      saveState(tmp, s);
    });
    const host = createRunHost({
      projectRoot: tmp, cfg: CFG_SINGLE, state: stateApi, chain: runDriver, executor,
      onEvent: (e) => { if (e.type === 'task.started') seenChains.push(e.payload.chain); },
    });
    host.start();
    const r = host.submitRun();
    await waitDone(host, r.runId);
    // review 门禁 → 保守链 simple → [DEV, COMMIT]
    expect(seenChains).toEqual([['DEV', 'COMMIT']]);
    expect(host.snapshot(r.runId).run.status).toBe('done');
  });

  it('单 agent 门禁闭环：review blocked+verdict fail → gateCompletionHook 派生修复 → 复审 pass → done', async () => {
    writeState(tmp, [
      { id: 'T1', kind: 'dev', plannedFiles: ['a.js'], status: 'pending', deps: [] },
      { id: 'R1', kind: 'review', title: '审查 T1', plannedFiles: [], status: 'pending', deps: ['T1'] },
    ]);
    // 模拟单 agent 会话落账：T1 done；R1 首次 blocked+verdict fail；修复 R1-F1 done；R1 复审 done
    const executor = {
      runTask: async ({ taskId }) => {
        const s = readState(tmp);
        const t = s.tasks.find((x) => x.id === taskId);
        if (taskId === 'R1') {
          const isFinal = (t.exec?.recheck || 0) >= 1;
          t.status = isFinal ? 'done' : 'blocked';
          t.exec = t.exec || {};
          t.exec.verdict = isFinal ? { level: 'pass', conclusion: '复审通过' } : { level: 'fail', conclusion: '方向性错误' };
          t.exec.files = ['.awf/reports/review/review-r1.md'];
        } else {
          t.status = 'done'; t.exec = { result: 'ok' };
        }
        saveState(tmp, s);
        return { status: readState(tmp).tasks.find((x) => x.id === taskId)?.status };
      },
    };
    const host = createRunHost({
      projectRoot: tmp, cfg: CFG_SINGLE, state: stateApi, chain: runDriver,
      handleGateCompletion, executor,
    });
    host.start();
    const r = host.submitRun();
    await waitDone(host, r.runId);

    const snap = host.snapshot(r.runId).run;
    expect(snap.status).toBe('done');
    // 闭环：T1 → R1(fail→派生) → R1-F1 → R1(pass)；R1 复审仍同一任务 → 共 3 个任务
    expect(snap.counts).toMatchObject({ total: 3, done: 3 });
    const final = readState(tmp);
    expect(final.tasks.find((t) => t.id === 'R1').status).toBe('done');
    expect(final.tasks.find((t) => t.id === 'R1').exec.recheck).toBe(1);
    expect(final.tasks.some((t) => t.id === 'R1-F1')).toBe(true); // 修复任务真实派生
  });
});

describe('createRunHost — 多 agent 经 runScheduler + 事件轮询', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-runhost-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function waitDoneAndEvents(host, runId) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function tick() {
        const snap = host.snapshot(runId).run;
        if (snap && (snap.status === 'done' || snap.status === 'error' || snap.status === 'stopped')) return resolve(snap);
        if (Date.now() - t0 > 5000) return reject(new Error(`waitDone timeout: ${JSON.stringify(snap)}`));
        setTimeout(tick, 5);
      })();
    });
  }

  it('batch：runScheduler 滑动窗口经宿主驱动，事件/快照收敛 done', async () => {
    writeState(tmp, [
      { id: 'T1', kind: 'dev', plannedFiles: ['a.js'], status: 'pending', deps: [] },
      { id: 'T2', kind: 'dev', plannedFiles: ['b.js'], status: 'pending', deps: [] },
    ]);
    const sent = [];
    const batch = {
      dispatch: async (task) => { sent.push(task.id); },
      waitAnyDone: async (running) => {
        const s = readState(tmp);
        for (const id of running.taskIds()) {
          const t = s.tasks.find((x) => x.id === id);
          if (t) { t.status = 'done'; t.exec = { result: 'ok' }; }
        }
        saveState(tmp, s);
        return { done: running.taskIds(), suspended: false };
      },
    };
    const events = [];
    const host = createRunHost({
      projectRoot: tmp,
      cfg: { agents: { max: 2, maxModules: 2, maxPerModule: 2, maxPerFeature: 2 } },
      state: stateApi, chain: runDriver, scheduler: runScheduler, batch,
      onEvent: (e) => events.push(e),
    });
    host.start();
    const r = host.submitRun();
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('batch');
    await waitDoneAndEvents(host, r.runId);

    const snap = host.snapshot(r.runId).run;
    expect(snap.status).toBe('done');
    expect(snap.counts).toMatchObject({ done: 2 });
    expect(sent.sort()).toEqual(['T1', 'T2']);
    expect(events.filter((e) => e.type === 'task.done')).toHaveLength(2);

    // 事件轮询：afterSeq 增量游标
    const first = host.pollEvents({ runId: r.runId, afterSeq: 0 });
    expect(first.events.length).toBeGreaterThan(0);
    expect(first.events.every((e) => e.seq > 0 && e.runId === r.runId)).toBe(true);
    const after = host.pollEvents({ runId: r.runId, afterSeq: first.afterSeq });
    expect(after.events).toEqual([]);
    expect(after.tailSeq).toBe(first.tailSeq);
  });

  it('snapshot 无 runId 时列出全部 run 摘要；未知 runId → error', async () => {
    writeState(tmp, [{ id: 'T1', kind: 'dev', status: 'pending', deps: [] }]);
    const host = createRunHost({ projectRoot: tmp, cfg: CFG_SINGLE, state: stateApi, chain: runDriver, executor: { runTask: async () => ({}) } });
    host.start();
    const r = host.submitRun({ runId: 'x' });
    await waitDoneAndEvents(host, r.runId);
    const all = host.snapshot();
    expect(all.ok).toBe(true);
    expect(all.runs.length).toBe(1);
    expect(all.runs[0].runId).toBe('x');
    expect(host.snapshot('nope').ok).toBe(false);
  });
});

describe('createRunHost — 事件订阅/外部发布（T1-091）', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-runhost-sub-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('subscribe：emit 实时收到事件；unsubscribe 后不再收', async () => {
    writeState(tmp, [{ id: 'T1', kind: 'dev', status: 'pending', deps: [] }]);
    const host = createRunHost({
      projectRoot: tmp, cfg: CFG_SINGLE, state: stateApi, chain: runDriver,
      executor: { runTask: async ({ projectRoot }) => {
        const s = readState(projectRoot);
        const t = s.tasks[0];
        if (t) { t.status = 'done'; t.exec = { result: 'ok' }; saveState(projectRoot, s); }
        return { status: 'done' };
      } },
    });
    const got = [];
    const unsub = host.subscribe((e) => got.push(e.type));
    host.start();
    const r = host.submitRun({ runId: 'sub1' });
    await waitDone(host, r.runId);
    expect(got).toContain('run.submitted');
    expect(got).toContain('task.done');
    expect(got).toContain('run.stopped');
    const n = got.length;
    unsub();
    host.publish('decision.required', { question: 'q' });
    expect(got).toHaveLength(n); // 退订后不再收到
  });

  it('publish：写入事件环并扇出订阅（runId 缺省取 active，可显式指定）', () => {
    const host = createRunHost({ projectRoot: tmp, cfg: CFG_SINGLE, state: stateApi, chain: runDriver });
    const got = [];
    host.subscribe((e) => got.push(e));
    host.publish('decision.required', { question: 'x?', options: ['A'] });
    host.publish('run.phase', { phase: 'REVIEW' }, { runId: 'r9' });

    expect(got.map((e) => e.type)).toEqual(['decision.required', 'run.phase']);
    expect(got[0].runId).toBe(null); // 无 active run → runId null
    expect(got[1].runId).toBe('r9'); // 显式指定 runId

    const evs = host.pollEvents().events.map((e) => e.type);
    expect(evs).toEqual(['decision.required', 'run.phase']);
  });

  it('subscribe 非函数 → 抛错', () => {
    const host = createRunHost({ projectRoot: tmp, cfg: CFG_SINGLE, state: stateApi, chain: runDriver });
    expect(() => host.subscribe('nope')).toThrow(/fn 须为函数/);
  });
});

// ── helpers ──

/** 轮询直到 run 到终态 */
function waitDone(host, runId) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tick() {
      const snap = host.snapshot(runId).run;
      if (snap && (snap.status === 'done' || snap.status === 'error' || snap.status === 'stopped')) return resolve(snap);
      if (Date.now() - t0 > 5000) return reject(new Error(`waitDone timeout: ${JSON.stringify(snap)}`));
      setTimeout(tick, 5);
    })();
  });
}
