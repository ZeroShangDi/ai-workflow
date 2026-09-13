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
 * @returns {{ runTask: Function }} 单 agent 执行器；runTask 驱动一个任务从派发到结算
 */
function createSingleExecutor({ ctx, session, channel, observability }) {
  const { notice, pauseNoticeLog } = observability;

  /** 读本项目 state 里某任务的当前状态；找不到 → null */
  function currentTaskStatus(taskId) {
    return (ctx.stores.state.readSync()?.tasks || []).find((t) => t.id === taskId)?.status || null;
  }

  return {
    /**
     * 派发并跟进一个任务（单 agent 顺序路径）。
     * @param {{ taskId: string, task: object, taskIndex?: number }} p
     *   taskId    任务 id（用于查 state）
     *   task      任务对象（取其 prompt/title 作为注入文本）
     *   taskIndex 序号（首个任务跳过上下文压缩检查）
     * @returns {{ status: string }} 结算后的任务状态（done / blocked）
     */
    runTask: async ({ taskId, task, taskIndex = 1 }) => {
      const text = task.prompt || task.title || task.id; // 注入文本：优先 prompt，退化到 title/id
      if (!ctx.tmux.hasSession()) {
        throw new Error(`tmux session '${ctx.tmux.sessionName}' not found; run bootstrap.sh`);
      }

      // 派发闩锁：暂停期间不派发新任务；但若这个任务已被别处结算（done/blocked），不必再等
      const { waitWhilePaused } = await import('../features/pause/index.js');
      const gate = await waitWhilePaused(ctx.projectRoot, {
        label: `dispatch:${taskId}`,
        log: pauseNoticeLog(),
        isSettled: () => {
          const st = currentTaskStatus(taskId);
          return st === 'done' || st === 'blocked';
        },
      });
      // 因「已结算」放行：说明别的路径（如子 agent、人工）把它做完了，这里不再派发，直接回状态
      if (gate.releasedBy === 'settled') {
        const st = currentTaskStatus(taskId);
        notice('pause', 'ok', `任务 ${taskId} 在暂停期间已结算（${st}），不再派发`);
        return { status: st };
      }

      const ready = await session.waitReady(READY_TIMEOUT_MS);
      if (!ready) throw new Error('still busy (ready timeout)'); // 等不到就绪 → 抛给宿主处理

      // 任务前上下文压缩检查（跳过首个任务；实测 ≥ 阈值或无实测才打扰 AI）
      const ch = await channel();
      const prompt = await ch.maybeCompact(text, taskIndex);

      ctx.logger.captureFromTranscript(); // 派发前抓一次 transcript 基线（用于后续判定产出）
      session.setBusy();
      ctx.logger.logPrompt(prompt);
      await submitText(ctx, prompt);

      // 等任务自我结算：CC 仍在推进 → 重置无变化窗口；仅当 CC 已 idle 且仍无结算，才累计窗口
      let idleSince = null; // 记录「CC 变为 idle 且无结算」的起始时刻；非 null 表示正在累计
      for (;;) {
        await sleep(500); // 轮询间隔：state 由 CC 的 MCP 工具异步落账，500ms 足够且不空转
        const t = (ctx.stores.state.readSync()?.tasks || []).find((x) => x.id === taskId);
        if (t && (t.status === 'done' || t.status === 'blocked')) return { status: t.status };
        // 等人工决策应答：人类思考无上限，不计时也不进收尾协商
        if (session.decisionPending && !session.decisionPending.answered) { idleSince = null; continue; }
        if (session.state === 'busy') { idleSince = null; continue; } // CC 仍忙 → 永不误判超时
        const now = Date.now();
        if (idleSince == null) idleSince = now;                        // 首次发现 idle：起累计
        else if (now - idleSince >= READY_TIMEOUT_MS) break;           // 窗口已满：交收尾协商
      }

      // 收尾协商：wrapup → 最多 3 轮 settle → 标 blocked。CC 忘记落账是常态，编排要能自愈继续推进
      const settled = await ch.settleTask(taskId);
      return { status: settled === 'done' ? 'done' : 'blocked' };
    },
  };
}

module.exports = { createSingleExecutor, submitText };
