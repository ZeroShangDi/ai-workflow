import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBatchTransport } = require('../../src/server/batch-transport.cjs');

// 多 agent 传输层（宿主侧）：dispatch 注入 subagentDispatch 提示词 + 标记 active；
// waitAnyDone 轮询结算 + 落账失败补发 + NEEDS_INPUT 挂起 + 「无变化窗口」超时（非墙钟）。

let TMP;
let failedPath;
let needsPath;
let eventsPath;

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-batch-'));
  failedPath = path.join(TMP, 'subagent-failed.jsonl');
  needsPath = path.join(TMP, 'subagent-needs-input.jsonl');
  eventsPath = path.join(TMP, 'subagent-events.jsonl');
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** 造一个传输：默认单任务 T1（pending），send 记录文本，prompts 用固定模板 */
function makeTransport(overrides = {}) {
  const sent = [];
  const active = [];
  const tasks = overrides.tasks || [{ id: 'T1', title: '做 A', status: 'pending' }];
  const t = createBatchTransport({
    send: async (text) => { sent.push(text); },
    prompts: {
      subagentDispatch: async ({ taskId }) => `DISPATCH ${taskId}`,
      resend: async ({ agentId, reason }) => `RESEND ${agentId} ${reason}`,
    },
    markActive: (id) => { active.push(id); },
    readTasks: () => tasks,
    isBusy: () => false,
    decisionPending: () => null,
    failedPath,
    needsPath,
    eventsPath,
    sleep: async () => {},          // 不真等
    now: () => Date.now(),
    pollMs: 1,
    idleTimeoutMs: overrides.idleTimeoutMs ?? 60_000,
    log: () => {},
    ...overrides.deps,
  });
  return { t, sent, active, tasks };
}

/** 运行中集合桩（对齐 runScheduler 的 makeRunning 消费面） */
const runningOf = (...ids) => ({ taskIds: () => ids });

describe('batch-transport — dispatch', () => {
  it('先占用 active，再注入 subagentDispatch 提示词', async () => {
    const { t, sent, active } = makeTransport();
    await t.dispatch({ id: 'T1', title: '做 A', prompt: '做事' });
    expect(sent).toEqual(['DISPATCH T1']);
    expect(active).toEqual(['T1']);
  });

  it('原子占用失败时不生成提示词、不派发', async () => {
    const prompt = vi.fn(async () => 'DISPATCH T1');
    const { t, sent } = makeTransport({
      deps: {
        markActive: () => false,
        prompts: { subagentDispatch: prompt, resend: async () => '' },
      },
    });
    await expect(t.dispatch({ id: 'T1', title: '做 A' })).resolves.toBe(false);
    expect(prompt).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('通道发送失败时释放 active 占用', async () => {
    const released = [];
    const { t } = makeTransport({
      deps: {
        send: async () => { throw new Error('channel down'); },
        releaseActive: (id) => released.push(id),
      },
    });
    await expect(t.dispatch({ id: 'T1', title: '做 A' })).rejects.toThrow('channel down');
    expect(released).toEqual(['T1']);
  });
});

describe('batch-transport — waitAnyDone', () => {
  it('运行中任务结算为 done → 返回该 taskId', async () => {
    const { t, tasks } = makeTransport();
    tasks[0].status = 'done';
    const r = await t.waitAnyDone(runningOf('T1'));
    expect(r).toEqual({ done: ['T1'], suspended: false });
  });

  it('blocked 也算结算（不重派）', async () => {
    const { t, tasks } = makeTransport();
    tasks[0].status = 'blocked';
    const r = await t.waitAnyDone(runningOf('T1'));
    expect(r.done).toEqual(['T1']);
  });

  it('NEEDS_INPUT 上抛 → suspended 且不返回 done（暂停补位等决策）', async () => {
    const { t } = makeTransport();
    fs.writeFileSync(needsPath, JSON.stringify({ ts: new Date().toISOString(), taskId: 'T1', question: '选哪个？' }) + '\n');
    const r = await t.waitAnyDone(runningOf('T1'));
    expect(r).toEqual({ done: [], suspended: true });
  });

  it('落账失败日志新增记录 → 补发要求补齐 RESULT（不重做任务）', async () => {
    const { t, tasks, sent } = makeTransport();
    fs.writeFileSync(failedPath, JSON.stringify({ ts: new Date().toISOString(), agentId: 'a1', reason: 'no valid RESULT' }) + '\n');
    tasks[0].status = 'done';
    await t.waitAnyDone(runningOf('T1'));
    expect(sent).toEqual(['RESEND a1 no valid RESULT']);
  });

  it('单个子 Agent 补发超限（默认 2 次）后不再补发', async () => {
    const { t, tasks, sent } = makeTransport();
    tasks[0].status = 'done';
    const at = (ms) => new Date(Date.now() + ms).toISOString();
    for (let i = 0; i < 3; i++) {
      fs.appendFileSync(failedPath, JSON.stringify({ ts: at(i), agentId: 'a1', reason: `r${i}` }) + '\n');
      await t.waitAnyDone(runningOf('T1'));
    }
    // 第 1、2 次补发（RESEND_MAX=2），第 3 次超限 → 不再补发
    expect(sent).toEqual(['RESEND a1 r0', 'RESEND a1 r1']);
  });

  it('无变化窗口内不超时：任务一直 busy/事件增长 → 继续等，事件停止后才抛超时', async () => {
    let busy = true;
    let evSize = 0;
    const { t } = makeTransport({
      idleTimeoutMs: 300,
      deps: {
        isBusy: () => busy,
        sleep: async () => { await new Promise((r) => setTimeout(r, 20)); },
        now: () => Date.now(),
      },
    });
    // 事件持续增长 → 推进中，永不超时
    const grow = setInterval(() => { evSize += 10; fs.writeFileSync(eventsPath, 'x'.repeat(evSize)); }, 10);
    setTimeout(() => { busy = false; clearInterval(grow); }, 500);

    const p = t.waitAnyDone(runningOf('T1'));
    await expect(p).rejects.toThrow(/无变化/);
  }, 5000);

  it('决策挂起（未应答）期间不计时、不补位', async () => {
    let answered = false;
    const { t, tasks } = makeTransport({
      idleTimeoutMs: 200,
      deps: {
        decisionPending: () => ({ answered }),
        sleep: async () => { await new Promise((r) => setTimeout(r, 20)); },
      },
    });
    tasks[0].status = 'done';
    setTimeout(() => { answered = true; }, 400);
    const r = await t.waitAnyDone(runningOf('T1'));
    expect(r.done).toEqual(['T1']);
  }, 5000);
});
