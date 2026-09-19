import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// 必须在 require 之前设：server/config.cjs 的常量是**装配期快照**，模块加载后再改 env 不生效
process.env.CC_EXECUTOR_POLL_MS = '5';
process.env.CC_ENTER_DELAY_MS = '0';
const { createSingleExecutor } = require('../../server/runtime/executor.cjs');

/**
 * 执行器的「等任务自我结算」循环 —— 回归护栏（2026-09-19）。
 *
 * 为什么单独立这个用例：T-P1-02 把 `enterDelay` 下沉进 host 端口时，顺手删掉了 executor 顶部的
 * `sleep` 助手，而**结算循环里还在用它**。当时的测试全绿 —— 因为集成用例要么覆盖 `__CC_RUN_HOST_DEPS__`
 * 的假执行器、要么不走真实 executor。这个 bug 一直活到 P2-6b 的 DSH 单任务 run 才被真运行打出来
 * （run.error = "sleep is not defined"）。
 *
 * 所以这里**直接驱动真实 executor**：让它至少跑完一轮结算轮询，把「循环体能不能执行」钉住。
 * 平台无关（ctx.host 是替身），CC 与 DSH 共用同一条路径。
 */

/** 极简替身：host / stores / logger / session / channel / observability */
function makeDeps({ settleAfterReads = 2 } = {}) {
  let reads = 0;
  const state = { version: '0.2.0', tasks: [{ id: 'T1', title: 't', prompt: 'p', status: 'pending' }] };
  const sent = [];
  const ctx = {
    projectRoot: '/proj',
    host: {
      sessionName: 'cc-1',
      hasSession: () => true,
      sendPrompt: async (text) => { sent.push(text); },
    },
    stores: {
      state: {
        readSync: () => {
          reads += 1;
          // 第 N 次读取后「模型落账完成」→ 循环应当以 done 收尾
          if (reads >= settleAfterReads) state.tasks[0].status = 'done';
          return JSON.parse(JSON.stringify(state));
        },
        updateSync: () => true,
      },
    },
    logger: { captureFromTranscript: () => {}, logPrompt: () => {} },
  };
  const session = {
    state: 'ready',
    decisionPending: null,
    waitReady: async () => true,
    setBusy: () => { session.state = 'busy'; },
    setReady: () => { session.state = 'ready'; },
  };
  const channel = async () => ({ maybeCompact: async (text) => text });
  const observability = { notice: () => {}, pauseNoticeLog: () => () => {} };
  return { ctx, session, channel, observability, sent, readsNow: () => reads };
}

afterEach(() => {
  delete process.env.CC_EXECUTOR_POLL_MS;
  delete process.env.CC_ENTER_DELAY_MS;
});

describe('单 agent 执行器：等任务自我结算的循环', () => {
  it('派发后轮询 state，任务落账为 done → 返回该状态（循环体可执行）', async () => {
    const { ctx, session, channel, observability, sent } = makeDeps({ settleAfterReads: 2 });
    const executor = createSingleExecutor({ ctx, session, channel, observability });

    const r = await executor.runTask({ taskId: 'T1', task: { id: 'T1', prompt: '做 T1' }, taskIndex: 1 });

    expect(r).toEqual({ status: 'done' });
    expect(sent).toEqual(['做 T1']);          // 确实经 host.sendPrompt 派发（平台差异在适配器里）
    expect(session.state).toBe('busy');       // 派发时置忙；就绪由平台事件驱动
  });

  it('任务落账为 blocked → 同样以状态收尾（不当成成功）', async () => {
    const { ctx, session, channel, observability } = makeDeps({ settleAfterReads: 1 });
    ctx.stores.state.readSync = () => ({ tasks: [{ id: 'T1', status: 'blocked' }] });
    const executor = createSingleExecutor({ ctx, session, channel, observability });
    await expect(executor.runTask({ taskId: 'T1', task: { id: 'T1', prompt: 'p' }, taskIndex: 1 }))
      .resolves.toEqual({ status: 'blocked' });
  });

  it('没有会话 → 派发前就明确失败（不静默什么都不做）', async () => {
    const { ctx, session, channel, observability, sent } = makeDeps();
    ctx.host.hasSession = () => false;
    const executor = createSingleExecutor({ ctx, session, channel, observability });
    await expect(executor.runTask({ taskId: 'T1', task: { id: 'T1', prompt: 'p' }, taskIndex: 1 }))
      .rejects.toThrow(/not found/);
    expect(sent).toEqual([]);
  });
});
