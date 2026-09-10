'use strict';
/**
 * task-channel.cjs — 单 agent 任务的「会话内协商」两段：任务前上下文压缩检查 + 收尾协商。
 *
 * 迁自 v0.2.0 重构前的 cli/run.js（settleTask / maybeCompactContext）。重构把编排从 CLI
 * 迁进 server run host 时这两段没跟着迁，宿主执行器退化成「只等 CC 自我结算」——
 * CC 跑完回合却没落账就直接判超时，真 run 的健壮性低于重构前。本模块把两段提成纯端口模块，
 * 宿主（server.cjs 的 defaultSingleExecutor）与测试用同一实现，避免再次漂移。
 *
 * 端口全注入（prompts / state / pause / usage / 会话命令），本模块不做 IO 决策：
 *   - send(text)              —— 发一条 prompt 并等会话回到 ready（含 pause 闩锁）
 *   - readTaskStatus(id)      —— 读任务当前状态（pending/active/done/blocked）
 *   - markBlocked(id)         —— 编排仲裁：多轮追问仍不结算 → 标 blocked 使编排跳过
 *   - prompts                 —— 插件声明的模板（wrapup / settle / contextCheck），经 plugin-bridge
 *   - readUsagePct()          —— statusline 实测上下文占用（null = 无实测，交 AI 自估算）
 *   - readHandoffSnapshot()   —— .awf/context/handoff.md 快照
 *   - consumeContextReady()   —— 一次性读 contextReady 标记（AI 已写快照并通知）
 *   - clearSession()          —— /clear 清空对话（压缩后注入快照）
 */

/** 连续「CC 无产出」的最大轮数，超过则标 blocked 跳过 */
const MAX_SETTLE_ROUNDS = 3;
/** 介入总轮数保险丝（防「一直在产出但永不结算」的死循环） */
const SETTLE_MAX_TOTAL_ROUNDS = 12;
/** 等待人工决策应答的轮询间隔（等人工期间不计入任何轮数） */
const AWAIT_HUMAN_POLL_MS = 2000;
/**
 * 单轮产出的判定阈值（session transcript 增量，字节）。
 * 我们注入的收尾/追问提示词本身只占几百字节且基本固定，故用「明显超过提示词体量」的增量
 * 判定「这一轮 CC 真在干活」——干活中不计数、不计死，只有连续多轮毫无产出才判 blocked。
 */
const SETTLE_MIN_TURN_BYTES = 4096;

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
 * @param {object} ports 见文件头；prompts 三方法均为 async (arg) => string
 * @returns {{ settleTask(taskId): Promise<'done'|'blocked'>, maybeCompactContext(taskPrompt, taskIndex): Promise<string> }}
 */
function createSessionChannel({
  send,
  readTaskStatus,
  markBlocked,
  prompts,
  readUsagePct,
  readHandoffSnapshot,
  consumeContextReady,
  clearSession,
  readTurnBytes = () => null,
  isAwaitingHuman = () => false,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
  waitWhilePaused = async () => {},
  log = () => {},
} = {}) {
  for (const [name, fn] of Object.entries({ send, readTaskStatus, markBlocked, readUsagePct, readHandoffSnapshot, consumeContextReady, clearSession })) {
    if (typeof fn !== 'function') throw new Error(`task-channel: 端口 ${name} 必填`);
  }
  for (const name of ['wrapup', 'settle', 'contextCheck']) {
    if (typeof prompts?.[name] !== 'function') throw new Error(`task-channel: prompts.${name} 必填`);
  }
  if (typeof readTurnBytes !== 'function') throw new Error('task-channel: 端口 readTurnBytes 须为函数');

  /**
   * 收尾协商 — 校验任务是否 done，未 done 则补发收尾 prompt 再追问。
   *
   * 判据不是「问了几轮」，而是「CC 是否还在产出」（对齐
   * docs/bugs/timeout-must-confirm-no-cc-change.md：确认无变化才算失败）：
   * 每轮记 session transcript 增量，明显超过提示词体量 → 这一轮它在真干活 → 连续无产出计数清零；
   * 只有连续 MAX_SETTLE_ROUNDS 轮毫无产出且仍未结算，才标 blocked 跳过。
   * SETTLE_MAX_TOTAL_ROUNDS 为绝对保险丝（防「一直产出又永不结算」）。
   *
   * @param {string} taskId
   */
  async function settleTask(taskId) {
    if (readTaskStatus(taskId) === 'done') return 'done';

    const turnBytes = readTurnBytes;
    let noWorkRounds = 0; // 连续「CC 无产出」轮数
    let rounds = 0;       // 已介入轮数（含首轮 wrapup）

    for (;;) {
      // 正在等人工决策应答：人类思考时间无上限，绝不能计入轮数、更不能判死
      // （2026-09-10 现场：CC 调 awf_await_choice 后结束回合，编排器不知情，8 分钟内把任务判 blocked，
      //  用户的回答喂给了已经结束的 run）
      if (isAwaitingHuman()) {
        noWorkRounds = 0;
        log('info', `任务 ${taskId} 正在等待人工决策应答，暂停收尾协商计时`);
        await sleepFn(AWAIT_HUMAN_POLL_MS);
        continue;
      }

      if (rounds >= SETTLE_MAX_TOTAL_ROUNDS) {
        log('error', `任务 ${taskId} 介入 ${rounds} 轮仍在产出但未结算（保险丝），标记 blocked 并跳过`);
        markBlocked(taskId);
        return 'blocked';
      }
      rounds += 1;

      const before = turnBytes();
      if (rounds === 1) log('warn', `任务 ${taskId} 未标记 done，补发收尾 prompt`);
      else log('warn', `任务 ${taskId} 仍未 done，追问（连续无产出 ${noWorkRounds}/${MAX_SETTLE_ROUNDS} 轮）`);
      await send(rounds === 1 ? await prompts.wrapup(taskId) : await prompts.settle(taskId));

      const status = readTaskStatus(taskId);
      if (status === 'done') {
        log('ok', rounds === 1 ? '收尾 prompt 已生效' : `任务 ${taskId} 已完成`);
        return 'done';
      }
      if (status === 'blocked') {
        log('warn', `任务 ${taskId} 已标记 blocked，暂停等待人工介入`);
        return 'blocked';
      }

      const after = turnBytes();
      if (before != null && after != null && after - before >= SETTLE_MIN_TURN_BYTES) {
        noWorkRounds = 0; // 本轮确实在推进 → 不计数
        log('info', `任务 ${taskId} 本轮仍在产出（+${after - before}B），继续等待`);
        continue;
      }
      noWorkRounds += 1;
      if (noWorkRounds > MAX_SETTLE_ROUNDS) {
        log('error', `任务 ${taskId} 连续 ${noWorkRounds - 1} 轮无产出且未结算，标记 blocked 并跳过`);
        markBlocked(taskId);
        return 'blocked';
      }
    }
  }

  /**
   * 任务前上下文压缩检查（跳过前 skipFirstCount 个任务），两层：
   *   第一层（宿主）：实测占用低于阈值 → 直接放行，零额外往返
   *   第二层（AI）  ：占用 ≥ 阈值或无实测 → 发 context-check prompt 让 AI 精确判断
   *     不需压缩 → 原样返回任务 prompt
   *     需要压缩 → AI 写快照 + awf_context_ready → 读快照 + /clear + 前缀注入
   */
  async function maybeCompactContext(taskPrompt, taskIndex) {
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

  return { settleTask, maybeCompactContext };
}

module.exports = {
  createSessionChannel, formatContextUsage,
  MAX_SETTLE_ROUNDS, SETTLE_MAX_TOTAL_ROUNDS, SETTLE_MIN_TURN_BYTES, COMPACTION,
};
