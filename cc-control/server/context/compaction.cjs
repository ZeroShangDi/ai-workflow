'use strict';
/**
 * context/compaction.cjs — 任务前上下文压缩检查（横切能力）
 *
 * 从 `run/channel.cjs`（原 task-channel）拆出：那里混了**两件不同的事** ——
 *   ① 任务前**上下文压缩检查**（本文件）—— 上下文接力，与"任务跑多久"无关；
 *   ② **收尾协商**（留在 run/channel.cjs）—— 任务结算与会话推进，属编排。
 * 两者只是恰好共用 `send`（都要往会话里注入），不该因此同处一个模块。
 *
 * 语义（保持原实现，别改）：
 *   - 跳过前 N 个任务（首个任务上下文必然干净）；
 *   - 有实测占用且低于阈值 → 不打扰 AI；
 *   - 越过阈值才让 AI 做第二层精确判断（写快照 → 通知 → /clear → 注入快照）；
 *   - **快照不可读时保守跳过**（清空却不注入，比保留旧上下文更糟）。
 *
 * 端口全注入，本模块不做 IO 决策。
 */

/**
 * 上下文压缩检查配置（未来配置源的接缝）。
 * checkThreshold 高于旧压缩触发点(65%)：只把「真接近上限」的场景交给 AI 第二层精确判断。
 */
const COMPACTION = { enabled: true, skipFirstCount: 1, checkThreshold: 80 };

/** 格式化上下文占用描述：有实测 → 带百分比；无 → 提示 AI 自行估算 */
function formatContextUsage(pct) {
  return pct !== null ? `已用约 ${pct}%（statusline 实测）` : '未知（statusline 未配置，请自行估算）';
}

/**
 * @param {object} ports
 * @param {Function} ports.send                 发一条 prompt 并等会话回 ready（含 pause 闩锁）
 * @param {object}   ports.prompts              { contextCheck }
 * @param {Function} ports.readUsagePct         实测上下文占用（null = 无实测）
 * @param {Function} ports.readHandoffSnapshot  读 .awf/context/handoff.md
 * @param {Function} ports.consumeContextReady  一次性读 contextReady 标记
 * @param {Function} ports.clearSession         /clear 清空对话
 * @param {Function} [ports.log]                通知出口（默认 console）
 * @returns {{ maybeCompact(taskPrompt, taskIndex): Promise<string> }}
 */
function createContextCompactor({
  send, prompts, readUsagePct, readHandoffSnapshot, consumeContextReady, clearSession,
  log = (level, msg) => console.log(`[context][${level}] ${msg}`),
} = {}) {
  async function maybeCompact(taskPrompt, taskIndex) {
    if (!COMPACTION.enabled) return taskPrompt;
    if (taskIndex <= COMPACTION.skipFirstCount) return taskPrompt;

    const pct = await readUsagePct();
    if (pct !== null && pct < COMPACTION.checkThreshold) return taskPrompt;

    await send(await prompts.contextCheck(formatContextUsage(pct)));

    if (!consumeContextReady()) return taskPrompt;

    // 快照不可读时保守跳过（清空却不注入比保留旧上下文更糟）
    const snapshot = await readHandoffSnapshot();
    if (!snapshot) {
      log('warn', '快照不可读 (.awf/context/handoff.md)，跳过压缩');
      return taskPrompt;
    }
    await clearSession();
    log('ok', '已注入上下文快照 (.awf/context/handoff.md)');
    return `【上下文快照】按 code-context-onboard 生成，接手前先读\n${snapshot}\n\n${taskPrompt}`;
  }

  return { maybeCompact };
}

module.exports = { createContextCompactor, formatContextUsage, COMPACTION };
