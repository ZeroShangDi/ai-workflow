'use strict';
/**
 * session/executor.cjs — 单 agent 任务执行器（真实模型通道 v1）
 *
 * 派发任务 prompt 到本项目的交互会话 → 等任务自我结算 → 收尾协商。
 * 从 server.cjs 的 `defaultSingleExecutor` 提取，并把「会话态 / 通知 / 通道」改为显式注入 ——
 * 它不再伸手改 pcx，而是调 `session.setBusy()` 这样的**会话接口**。
 *
 * 两条等待语义（都别改）：
 *   - **pause 派发闩锁**：暂停期间不派发新任务；但目标任务若已被别处结算，立刻放行（不干等）。
 *   - **自结算等待**：CC 仍 busy（`session.state === 'busy'`）→ 不计时，永不误判超时；
 *     只有 CC 已 idle 且任务仍未结算时，才累计「无变化窗口」，超窗交收尾协商。
 */

const { READY_TIMEOUT_MS, ENTER_DELAY_MS } = require('../config.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 注文本 → 稍等 → 回车（tmux 注入节奏） */
async function submitText(ctx, text) {
  ctx.tmux.sendText(text);
  await sleep(ENTER_DELAY_MS);
  ctx.tmux.sendEnter();
}

/**
 * @param {object} deps
 * @param {object} deps.ctx           项目上下文（tmux / stores / logger / projectRoot）
 * @param {object} deps.session       会话态（waitReady / setBusy / state / decisionPending）
 * @param {Function} deps.channel     会话通道工厂（惰性取 task-channel 实例）
 * @param {object} deps.observability 观测面（notice / pauseNoticeLog）
 */
function createSingleExecutor({ ctx, session, channel, observability }) {
  const { notice, pauseNoticeLog } = observability;

  function currentTaskStatus(taskId) {
    return (ctx.stores.state.readSync()?.tasks || []).find((t) => t.id === taskId)?.status || null;
  }

  return {
    runTask: async ({ taskId, task, taskIndex = 1 }) => {
      const text = task.prompt || task.title || task.id;
      if (!ctx.tmux.hasSession()) {
        throw new Error(`tmux session '${ctx.tmux.SESSION}' not found; run bootstrap.sh`);
      }

      // 派发闩锁：暂停期间不派发新任务；但若这个任务已被别处结算（done/blocked），不必再等
      const { waitWhilePaused } = await import('../core/pause.js');
      const gate = await waitWhilePaused(ctx.projectRoot, {
        label: `dispatch:${taskId}`,
        log: pauseNoticeLog(),
        isSettled: () => {
          const st = currentTaskStatus(taskId);
          return st === 'done' || st === 'blocked';
        },
      });
      if (gate.releasedBy === 'settled') {
        const st = currentTaskStatus(taskId);
        notice('pause', 'ok', `任务 ${taskId} 在暂停期间已结算（${st}），不再派发`);
        return { status: st };
      }

      const ready = await session.waitReady(READY_TIMEOUT_MS);
      if (!ready) throw new Error('still busy (ready timeout)');

      // 任务前上下文压缩检查（跳过首个任务；实测 ≥ 阈值或无实测才打扰 AI）
      const ch = await channel();
      const prompt = await ch.maybeCompact(text, taskIndex);

      ctx.logger.captureFromTranscript();
      session.setBusy();
      ctx.logger.logPrompt(prompt);
      await submitText(ctx, prompt);

      // 等任务自我结算：CC 仍在推进 → 重置无变化窗口；仅当 CC 已 idle 且仍无结算，才累计窗口
      let idleSince = null;
      for (;;) {
        await sleep(500);
        const t = (ctx.stores.state.readSync()?.tasks || []).find((x) => x.id === taskId);
        if (t && (t.status === 'done' || t.status === 'blocked')) return { status: t.status };
        // 等人工决策应答：人类思考无上限，不计时也不进收尾协商
        if (session.decisionPending && !session.decisionPending.answered) { idleSince = null; continue; }
        if (session.state === 'busy') { idleSince = null; continue; }
        const now = Date.now();
        if (idleSince == null) idleSince = now;
        else if (now - idleSince >= READY_TIMEOUT_MS) break;
      }

      // 收尾协商：wrapup → 最多 3 轮 settle → 标 blocked。CC 忘记落账是常态，编排要能自愈继续推进
      const settled = await ch.settleTask(taskId);
      return { status: settled === 'done' ? 'done' : 'blocked' };
    },
  };
}

module.exports = { createSingleExecutor, submitText };
