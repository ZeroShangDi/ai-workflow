import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// 指向**新树**：cli/awf.cjs → server/run/*（旧树 src/server/ 待退役，其 batch-transport 已无调用方）
const { createBatchTransport } = require('../../server/run/transport.cjs');

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

/** 造一个传输：默认单任务 T1（pending），send 记录文本并在 eventsPath 落一条 SubagentStart
 *  （现实里健康的派发必然在数秒内产生 SubagentStart —— 派发生效确认靠它判断，见下方 ack 用例），
 *  prompts 用固定模板 */
function makeTransport(overrides = {}) {
  const sent = [];
  const active = [];
  const tasks = overrides.tasks || [{ id: 'T1', title: '做 A', status: 'pending' }];
  const t = createBatchTransport({
    send: async (text) => {
      sent.push(text);
      fs.appendFileSync(eventsPath, `${JSON.stringify({ ts: new Date().toISOString(), event: 'SubagentStart', body: {} })}\n`);
    },
    prompts: {
      subagentDispatch: async ({ taskId }) => `DISPATCH ${taskId}`,
      subagentRedispatch: async ({ taskId }) => `REDISPATCH ${taskId}`,
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
        prompts: { subagentDispatch: prompt, subagentRedispatch: prompt, resend: async () => '' },
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

// 派发未生效导致的卡死：.awf/bugs/dispatch-without-subagent-hangs-run.md
// （现场 sandbox/e2e/multi-agent-parallel-2026-09-13T10-56-01：主会话收下派发提示词、回合正常结束，
// 却回了句「T3 未派发——被 hook 拦截」，而项目里并不存在该 hook。）
// 旧行为只认 send 是否抛错，于是任务被留在 active、waitAnyDone 干等 15min 后整轮报错 —— 卡死。
// 现在：send 返回后确认「本回合确实起了子 Agent」，没起就换重派提示词再派一次，仍无则释放占用 + 标 blocked。
describe('batch-transport — 派发生效确认', () => {
  /** 时钟桩：每次读前进 1s，配合 no-op sleep 让 ack 窗口迅速到期（不真等） */
  const tickingClock = () => { let t = 0; return () => (t += 1000); };

  it('主会话收下提示词却没派子 Agent → 回滚占用后换重派提示词再派一次', async () => {
    const released = [];
    const { t, sent } = makeTransport({
      deps: {
        // 第一次静默（模型只回文字、不调 Agent 工具），第二次正常派生
        send: async (text) => {
          sent.push(text);
          if (sent.length === 2) {
            fs.appendFileSync(eventsPath, `${JSON.stringify({ ts: new Date().toISOString(), event: 'SubagentStart', body: {} })}\n`);
          }
        },
        releaseActive: (id) => { released.push(id); return true; },
        now: tickingClock(),
        dispatchAckMs: 3000,
        ackPollMs: 1,
      },
    });
    await expect(t.dispatch({ id: 'T1', title: '做 A' })).resolves.toBe(true);
    expect(sent).toEqual(['DISPATCH T1', 'REDISPATCH T1']);
    expect(released).toEqual(['T1']); // 只有第一次失败时回滚；重派成功后占用保留
  });

  it('重派仍无子 Agent → 每次失败回滚占用，终态标 blocked（不再挂死）', async () => {
    const released = [];
    const blocked = [];
    const { t, sent, tasks } = makeTransport({
      deps: {
        send: async (text) => { sent.push(text); }, // 全程静默：模型始终不派子 Agent
        releaseActive: (id) => released.push(id),
        markBlocked: (id) => blocked.push(id),
        now: tickingClock(),
        dispatchAckMs: 3000,
        ackPollMs: 1,
      },
    });
    await expect(t.dispatch({ id: 'T1', title: '做 A' })).resolves.toBe(false);
    expect(sent).toEqual(['DISPATCH T1', 'REDISPATCH T1']);
    expect(released).toEqual(['T1', 'T1']);
    expect(blocked).toEqual(['T1']);
  });

  it('等待生效期间任务已被别处结算 → 视为已生效，不重派', async () => {
    const { t, sent, tasks } = makeTransport({
      deps: {
        send: async (text) => { sent.push(text); }, // 无 SubagentStart，但任务已 done
        readTasks: () => { tasks[0].status = 'done'; return tasks; },
        now: tickingClock(),
        dispatchAckMs: 3000,
        ackPollMs: 1,
      },
    });
    await expect(t.dispatch({ id: 'T1', title: '做 A' })).resolves.toBe(true);
    expect(sent).toEqual(['DISPATCH T1']);
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
