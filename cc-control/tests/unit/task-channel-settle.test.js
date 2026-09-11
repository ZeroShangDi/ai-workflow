import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionChannel, MAX_SETTLE_ROUNDS, SETTLE_MAX_TOTAL_ROUNDS, SETTLE_MIN_TURN_BYTES } =
  require('../../src/server/task-channel.cjs');

// 收尾协商的判据（2026-09-10 真 run 现场）：不是「问了几轮」，而是「CC 是否还在产出」。
// T1-098 那次它一直在跑 harness 产出，却被固定轮数判死 → 标 blocked。

/**
 * 造一个通道：send 每次推进 turns 增量；status 由 statusSeq 驱动。
 * @param {{ statusSeq: string[], bytesPerSend?: number|null, awaiting?: Function }} opts
 *   statusSeq: 每次 send 后读到的任务状态（不足则沿用最后一个）
 *   bytesPerSend: 每次 send 造成的 transcript 增量（null = 不可测）
 *   awaiting: 是否正在等人工决策应答
 */
function makeChannel({ statusSeq, bytesPerSend = 0, awaiting = () => false }) {
  const sends = [];
  let statusIdx = 0;
  let bytes = 1000;
  const channel = createSessionChannel({
    send: async (text) => {
      sends.push(text);
      if (bytesPerSend != null) bytes += bytesPerSend;
    },
    readTaskStatus: () => statusSeq[Math.min(statusIdx++, statusSeq.length - 1)],
    markBlocked: () => { channel.blocked = true; },
    prompts: {
      wrapup: async (id) => `WRAPUP ${id}`,
      settle: async (id) => `SETTLE ${id}`,
      contextCheck: async () => 'CTX',
    },
    readUsagePct: async () => null,
    readHandoffSnapshot: async () => null,
    consumeContextReady: () => false,
    clearSession: async () => {},
    readTurnBytes: () => (bytesPerSend == null ? null : bytes),
    isAwaitingHuman: awaiting,
    sleepFn: async () => {},
    log: () => {},
  });
  channel.sends = sends;
  channel.blocked = false;
  return channel;
}

describe('task-channel.settleTask — 按「有无产出」判定，不按轮数', () => {
  it('任务已 done → 直接返回，不发任何 prompt', async () => {
    const c = makeChannel({ statusSeq: ['done'] });
    expect(await c.settleTask('T1')).toBe('done');
    expect(c.sends).toHaveLength(0);
  });

  it('CC 每轮都在产出 → 不判死，直到任务结算', async () => {
    // 前 4 轮仍未 done（每轮产出远超阈值），第 5 轮 done
    const c = makeChannel({
      statusSeq: ['pending', 'pending', 'pending', 'pending', 'pending', 'done'],
      bytesPerSend: SETTLE_MIN_TURN_BYTES * 2,
    });
    expect(await c.settleTask('T1')).toBe('done');
    expect(c.blocked).toBe(false);
    // 首轮 wrapup + 后续追问，全部是 settle（因为一直有产出不计数）
    expect(c.sends[0]).toBe('WRAPUP T1');
    expect(c.sends.filter((s) => s.startsWith('SETTLE'))).toHaveLength(4);
  });

  it('CC 毫无产出 → 连续 MAX_SETTLE_ROUNDS 轮后标 blocked（wrapup + 3 轮追问）', async () => {
    const c = makeChannel({ statusSeq: ['pending'], bytesPerSend: 0 });
    expect(await c.settleTask('T1')).toBe('blocked');
    expect(c.blocked).toBe(true);
    expect(c.sends[0]).toBe('WRAPUP T1');
    expect(c.sends.filter((s) => s.startsWith('SETTLE'))).toHaveLength(MAX_SETTLE_ROUNDS);
  });

  it('产出增量低于阈值（不构成推进）也计数', async () => {
    const c = makeChannel({ statusSeq: ['pending'], bytesPerSend: SETTLE_MIN_TURN_BYTES - 1 });
    expect(await c.settleTask('T1')).toBe('blocked');
    expect(c.sends).toHaveLength(MAX_SETTLE_ROUNDS + 1);
  });

  it('不可测产出（无 transcript）→ 退化为按轮数判定', async () => {
    const c = makeChannel({ statusSeq: ['pending'], bytesPerSend: null });
    expect(await c.settleTask('T1')).toBe('blocked');
    expect(c.sends).toHaveLength(MAX_SETTLE_ROUNDS + 1);
  });

  it('保险丝：一直产出但永不结算 → 到 SETTLE_MAX_TOTAL_ROUNDS 后 blocked（不死循环）', async () => {
    const c = makeChannel({ statusSeq: ['pending'], bytesPerSend: SETTLE_MIN_TURN_BYTES * 2 });
    expect(await c.settleTask('T1')).toBe('blocked');
    expect(c.blocked).toBe(true);
    expect(c.sends).toHaveLength(SETTLE_MAX_TOTAL_ROUNDS);
  });

  it('CC 自己标了 blocked → 尊重它，不再追问', async () => {
    const c = makeChannel({ statusSeq: ['pending', 'blocked'], bytesPerSend: 0 });
    expect(await c.settleTask('T1')).toBe('blocked');
    expect(c.sends).toHaveLength(1); // 只发了 wrapup
  });
});

// 2026-09-10 现场：CC 调 awf_await_choice 后结束回合（该工具立即返回，CC 并不等），
// 编排器不知情 → 8 分钟后把任务判 blocked → 用户的回答喂给了已经结束的 run。
describe('task-channel.settleTask — 等人工决策期间不判死', () => {
  it('等人工应答期间不介入、不计轮；应答后正常结算', async () => {
    let polls = 0;
    let sendsWhenAnswered = null;
    const c = makeChannel({
      statusSeq: ['pending', 'pending', 'done'],
      bytesPerSend: 0,
      awaiting: () => {
        polls += 1;
        if (polls === 6) sendsWhenAnswered = c.sends.length; // 第 6 次起不再等人工
        return polls <= 5;
      },
    });
    expect(await c.settleTask('T1')).toBe('done');
    expect(c.blocked).toBe(false);
    expect(sendsWhenAnswered).toBe(0); // 等人工期间一轮介入都没发
    expect(c.sends[0]).toBe('WRAPUP T1');
  });

  it('等人工期间即使毫无产出也不会累计到 blocked', async () => {
    let polls = 0;
    const c = makeChannel({
      statusSeq: ['pending', 'done'],
      bytesPerSend: 0,
      awaiting: () => (polls += 1) <= 100, // 远超 MAX_SETTLE_ROUNDS 的轮询次数
    });
    expect(await c.settleTask('T1')).toBe('done');
    expect(c.blocked).toBe(false);
  });
});

/**
 * T1-111：pause 闩锁期间「目标任务已结算 → 立即放行」。
 *
 * 事故形态（2026-09-10）：宿主在 settleTask 的 send() 里被闩锁无限期挂住，期间任务早已 done，
 * 而宿主卡在 send 里回不到状态轮询，看不见 —— run 静默停摆 4 小时。
 * 修法：收尾协商自己拿闩锁（带 isSettled 谓词），已结算就返回，不注入收尾 prompt。
 */
describe('task-channel.settleTask — pause 闩锁期间目标已结算即放行（T1-111）', () => {
  function makePausedChannel({ gateResult, statusDuringWait }) {
    const sends = [];
    const gateCalls = [];
    let status = 'active';
    const channel = createSessionChannel({
      send: async (text) => { sends.push(text); },
      readTaskStatus: () => status,
      markBlocked: () => { status = 'blocked'; },
      prompts: {
        wrapup: async (id) => `WRAPUP ${id}`,
        settle: async (id) => `SETTLE ${id}`,
        contextCheck: async () => 'CTX',
      },
      readUsagePct: async () => null,
      readHandoffSnapshot: async () => null,
      consumeContextReady: () => false,
      clearSession: async () => {},
      readTurnBytes: () => 1000,
      isAwaitingHuman: () => false,
      sleepFn: async () => {},
      waitWhilePaused: async (opts) => {
        // 谓词是活闭包：调用当时的取值才有意义，事后调用读到的是最终态
        gateCalls.push({ ...opts, settledAtCallTime: opts.isSettled ? opts.isSettled() : null });
        if (statusDuringWait) status = statusDuringWait; // 等待期间任务被别处结算
        return gateResult;
      },
    });
    return { channel, sends, gateCalls, statusOf: () => status };
  }

  it('闩锁返回 settled（任务已 done）→ 不注入收尾 prompt，直接返回 done', async () => {
    const c = makePausedChannel({ gateResult: { releasedBy: 'settled', waited: true }, statusDuringWait: 'done' });
    expect(await c.channel.settleTask('T1')).toBe('done');
    expect(c.sends).toEqual([]); // 一条收尾 prompt 都没发
  });

  it('闩锁返回 settled 且任务为 blocked → 返回 blocked', async () => {
    const c = makePausedChannel({ gateResult: { releasedBy: 'settled', waited: true }, statusDuringWait: 'blocked' });
    expect(await c.channel.settleTask('T1')).toBe('blocked');
    expect(c.sends).toEqual([]);
  });

  it('闩锁正常恢复（resumed）→ 照常补发收尾 prompt（语义不放松）', async () => {
    const c = makePausedChannel({ gateResult: { releasedBy: 'resumed', waited: true }, statusDuringWait: 'done' });
    expect(await c.channel.settleTask('T1')).toBe('done');
    expect(c.sends).toEqual(['WRAPUP T1']); // 恢复了就照常收尾（读完状态发现 done 即返回）
  });

  it('闩锁拿到的是真实谓词与阶段标签（不是空转）', async () => {
    const c = makePausedChannel({ gateResult: { releasedBy: 'resumed', waited: true } });
    await c.channel.settleTask('T1');
    expect(c.gateCalls.length).toBeGreaterThanOrEqual(1); // 每轮介入前都过一次闩锁
    for (const opts of c.gateCalls) {
      expect(opts.label).toBe('settle:T1');
      expect(typeof opts.isSettled).toBe('function');
    }
    // 首轮调用时任务还是 active → 谓词必须为假（不能无脑放行）
    expect(c.gateCalls[0].settledAtCallTime).toBe(false);
  });

  it('isSettled 谓词认 done / blocked（驱动放行判据）', async () => {
    const c = makePausedChannel({ gateResult: { releasedBy: 'settled', waited: true }, statusDuringWait: 'done' });
    await c.channel.settleTask('T1');
    const pred = c.gateCalls[0].isSettled;
    expect(pred()).toBe(true); // 等待期间被置 done
  });
});
