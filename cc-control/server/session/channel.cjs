'use strict';
/**
 * session/channel.cjs — 会话通道（上下文压缩检查 / 收尾协商）的装配
 *
 * 把 run/channel.cjs（task-channel 原语）接到本项目现场：prompts 走插件模板（plugin-bridge 边界唯一模块）、
 * state 走本项目 store、pause 走 lib/pause.js、上下文占用读本项目 usage.json。
 *
 * 同时承载两个**会话注入原语**（原在 server.cjs）：
 *   - sendPromptAndWait：注入 prompt 并等本回合收尾（/send 的 busy 语义 + 等回 ready）
 *   - sendLocalCmd：注入本地 slash 命令（/clear）并起兜底定时器（本地命令不产生 Stop hook）
 */

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { READY_TIMEOUT_MS, LOCAL_CMD_FALLBACK_MS } = require('../config.cjs');
const { mainTranscriptPath } = require('../observability/metrics.cjs');
const { submitText } = require('./executor.cjs');

/**
 * @param {object} deps
 * @param {object} deps.ctx           项目上下文（stores / logger / projectRoot）
 * @param {object} deps.session       会话态
 * @param {object} deps.observability 观测面（notice / pauseNoticeLog）
 * @returns {Function} channel() → Promise<SessionChannel>（每项目惰性单例）；
 *                     该函数上还挂 sendPromptAndWait / sendLocalCmd 两个注入原语
 */
function createSessionChannelFactory({ ctx, session, observability }) {
  const { notice, pauseNoticeLog } = observability;
  let cached = null; // 惰性单例的 promise（装配失败会清空以便重试）

  /** 注入 prompt 并等本回合收尾；超时返回 false（不抛 —— 由上层回查 state 决定下一步） */
  async function sendPromptAndWait(text) {
    const ok = await session.waitReady(READY_TIMEOUT_MS);
    if (!ok) return false;
    ctx.logger.captureFromTranscript();
    session.setBusy();
    ctx.logger.logPrompt(text);
    await submitText(ctx, text);
    return session.waitReady(READY_TIMEOUT_MS); // 等回合收尾（Stop hook 放回 ready）
  }

  /** 注入本地 slash 命令：等就绪 → 标 busy → 注入 → 起兜底（本地命令无 Stop hook） */
  async function sendLocalCmd(cmd) {
    const ok = await session.waitReady(READY_TIMEOUT_MS);
    if (!ok) return false;
    session.setBusy();
    await submitText(ctx, cmd);
    // 本地命令不触发 Stop hook，会话态会一直 busy —— 必须起兜底把它放回 ready
    session.clearFallbackTimer();
    session.setFallbackTimer(setTimeout(() => {
      if (session.state === 'busy') session.setReady();
    }, LOCAL_CMD_FALLBACK_MS));
    return true;
  }

  /** 每项目惰性单例：channel() 取「会话内两段协商」的合并面 */
  async function channel() {
    if (cached) return cached;
    // cached 存的是 promise（不是结果），并发调用共享同一次装配；装配失败清缓存以便下次重试
    cached = (async () => {
      const bridge = await import('../core/prompts.js');
      const { waitWhilePaused } = await import('../core/pause.js');
      const { createSessionChannel } = require('../run/channel.cjs');        // 收尾协商（run）
      const { createContextCompactor } = require('../context/compaction.cjs'); // 上下文压缩（context）

      /** 发 prompt 并等会话回 ready（超时由上层状态回查兜底） */
      const send = async (text, label = 'session-channel') => {
        await waitWhilePaused(ctx.projectRoot, { label, log: pauseNoticeLog() }); // 暂停期不打扰会话
        return sendPromptAndWait(text);
      };

      /** 读本项目 .awf/context/usage.json 的上下文占用百分比；缺失/异常 → null（视为无实测） */
      const readUsagePct = async () => {
        try {
          const pct = JSON.parse(
            await fsp.readFile(path.join(ctx.projectRoot, '.awf', 'context', 'usage.json'), 'utf-8'),
          ).used_percentage;
          return typeof pct === 'number' ? pct : null;
        } catch { return null; }
      };
      /** 读上次上下文压缩留下的 handoff 快照；缺失 → null */
      const readHandoffSnapshot = async () => {
        try {
          return await fsp.readFile(path.join(ctx.projectRoot, '.awf', 'context', 'handoff.md'), 'utf-8');
        } catch { return null; }
      };

      // 上下文压缩（横切）：只依赖「读占用 / 读快照 / 清会话 / 发提示词」
      // 5 个端口都是函数，压缩逻辑本身不 import 任何本项目模块 —— 可独立测试
      const compactor = createContextCompactor({
        send,
        prompts: { contextCheck: bridge.contextCheck },
        readUsagePct,
        readHandoffSnapshot,
        consumeContextReady: () => session.consumeContextReady(),
        clearSession: () => sendLocalCmd('/clear'),
        log: (level, msg) => notice('context', level, msg),
      });

      // 收尾协商（编排）：结算等待 → 追问 → blocked
      const settle = createSessionChannel({
        send,
        readTaskStatus: (id) => (ctx.stores.state.readSync()?.tasks || []).find((t) => t.id === id)?.status || null,
        markBlocked: (id) => ctx.stores.state.updateSync((s) => {
          const t = (s?.tasks || []).find((x) => x.id === id);
          if (!t) return false;
          t.status = 'blocked';
          return true;
        }),
        prompts: { wrapup: bridge.taskWrapup, settle: bridge.taskSettle },
        // 本轮有无产出：主会话 transcript 字节数（拿不到会话 id/文件 → null，退化按轮数判定）
        readTurnBytes: () => {
          const file = mainTranscriptPath(ctx.projectRoot, session.mainSessionId);
          if (!file) return null;
          try { return fs.statSync(file).size; } catch { return null; }
        },
        // 是否正在等人工决策应答
        isAwaitingHuman: () => !!session.decisionPending && !session.decisionPending.answered,
        // 收尾协商自己拿这个闩锁等（带「目标任务已结算就放行」谓词）：事故就是在 send 里被闩住看不见
        waitWhilePaused: (opts = {}) => waitWhilePaused(ctx.projectRoot, { log: pauseNoticeLog(), ...opts }),
        log: (level, msg) => notice('settle', level, msg),
      });

      // 合并面：执行器按「任务前压缩 → 派发 → 等结算 → 收尾协商」顺序使用
      return { maybeCompact: compactor.maybeCompact, settleTask: settle.settleTask };
    })().catch((err) => {
      cached = null; // 装配失败不缓存失败结果，下次调用重新装配
      throw err;
    });
    return cached;
  }

  // 注入原语挂在工厂上：批传输 / 路由直接要用（不必先取 channel 实例）
  channel.sendPromptAndWait = sendPromptAndWait;
  channel.sendLocalCmd = sendLocalCmd;
  return channel;
}

module.exports = { createSessionChannelFactory };
