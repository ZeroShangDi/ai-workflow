'use strict';
/**
 * batch-transport.cjs — 多 agent 的「派发 + 完成感知」传输层（宿主侧）。
 *
 * 多 agent 的调度权已归 run-host（driveBatch → runScheduler），但宿主只认传输接口
 * `{ dispatch(task), waitAnyDone(running) }`；本模块把这两个函数接到真实现场：
 * dispatch(task)   —— 经会话注入 subagentDispatch 提示词 + 标记 active + **确认本回合确实起了子 Agent**
 *                     （未生效 → 换重派提示词再派；连续未生效 → 回滚占用并标 blocked，不让 run 干等）
 *   waitAnyDone(r)   —— 轮询 state 感知完成 + 落账失败补发 + NEEDS_INPUT 决策挂起 + 无变化超时
 *
 * 迁自重构前 cli/run-batch.js（CLI 拥有调度权时代的同一套语义），差异只在「谁在跑」：
 * 调度在宿主进程内，不再经 HTTP 回环到 CLI。IO/prompts/时钟全部注入，便于单测。
 *
 * 超时判据（.awf/bugs/timeout-must-confirm-no-cc-change.md）：不看墙钟总量，只看「无变化窗口」——
 * 主会话仍在推进、任务状态有变、子 Agent 事件有增，任一发生即重置窗口；窗口内无任何变化才判超时。
 */

const fs = require('fs');

/** 轮询间隔 */
const POLL_MS = 2000;
/** 无变化窗口上限（默认 15min，env 覆盖）；不是任务总时长上限 */
const IDLE_TIMEOUT_MS = Number(process.env.CC_BATCH_IDLE_TIMEOUT_MS || 15 * 60 * 1000);
/** 单个子 Agent 落账补发上限 */
const RESEND_MAX = 2;
/** 单任务派发尝试次数上限（首次 + 重派一次）；超限标 blocked，不把 run 挂死 */
const DISPATCH_MAX = 2;
/** 派发生效确认窗口（send 返回后等「本回合确实起了子 Agent」）；env 覆盖 */
const DISPATCH_ACK_MS = Number(process.env.CC_BATCH_DISPATCH_ACK_MS || 15 * 1000);
/** 生效确认的轮询间隔 */
const ACK_POLL_MS = 1000;

/** 读取 jsonl 日志内的最大 ts（毫秒）；文件不存在/空 → 0。作为「已处理游标」，避免历史残留重放触发伪补发。 */
function maxTsFromLog(logPath) {
  let raw;
  try { raw = fs.readFileSync(logPath, 'utf-8'); } catch { return 0; }
  let max = 0;
  for (const line of raw.trim().split('\n').filter(Boolean)) {
    try {
      const t = new Date(JSON.parse(line).ts).getTime();
      if (Number.isFinite(t) && t > max) max = t;
    } catch { /* 跳过坏行 */ }
  }
  return max;
}

/** 子 Agent Start 事件条数（派发生效的唯一直接证据）；文件不存在 → 0。 */
function countSubagentStarts(eventsPath) {
  let raw;
  try { raw = fs.readFileSync(eventsPath, 'utf-8'); } catch { return 0; }
  let n = 0;
  for (const line of raw.trim().split('\n').filter(Boolean)) {
    try {
      if (JSON.parse(line).event === 'SubagentStart') n += 1;
    } catch { /* 跳过坏行 */ }
  }
  return n;
}

/**
 * @param {object} ports
 *   - send(text)              注入一条 prompt 到主会话（含 waitReady / pause 闩锁）
 *   - prompts                 { subagentDispatch({taskId,taskTitle,taskPrompt}), subagentRedispatch({taskId,taskPrompt}), resend({agentId,reason}) }
 *   - markActive(taskId)      调度标记 active（state 单写者，与 dynamic-planning hold 共用 state.lock）
 *   - releaseActive(taskId)   回滚 active 占用（send 失败 / 派发未生效时调用，避免任务卡在 active）
 *   - markBlocked(taskId)     连续派发未生效时标 blocked（可选；与收尾协商「多轮无产出 → blocked」同语义）
 *   - readTasks()             读本项目 state.tasks
 *   - isBusy()                主会话是否仍在推进
 *   - decisionPending()       当前决策槽（{answered} 或 null）
 *   - failedPath/needsPath    落账失败 / 决策上抛日志（per-project）
 *   - eventsPath              子 Agent 事件日志（推进探测 + 派发生效确认）
 *   - waitWhilePaused()       pause 闩锁
 *   - log(level,msg) / sleep / now（测试注入）
 */
function createBatchTransport({
  send,
  prompts,
  markActive,
  releaseActive = () => false,
  markBlocked = () => false,
  readTasks,
  isBusy = () => false,
  decisionPending = () => null,
  failedPath,
  needsPath,
  eventsPath,
  waitWhilePaused = async () => {},
  log = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  pollMs = POLL_MS,
  idleTimeoutMs = IDLE_TIMEOUT_MS,
  resendMax = RESEND_MAX,
  dispatchMax = DISPATCH_MAX,
  dispatchAckMs = DISPATCH_ACK_MS,
  ackPollMs = ACK_POLL_MS,
} = {}) {
  for (const [name, fn] of Object.entries({ send, markActive, readTasks })) {
    if (typeof fn !== 'function') throw new Error(`batch-transport: 端口 ${name} 必填`);
  }
  for (const name of ['subagentDispatch', 'subagentRedispatch', 'resend']) {
    if (typeof prompts?.[name] !== 'function') throw new Error(`batch-transport: prompts.${name} 必填`);
  }

  let lastFailedTs = maxTsFromLog(failedPath); // 已处理的失败记录游标
  let lastNeedsTs = maxTsFromLog(needsPath);   // 已处理的决策上抛游标
  const resendCount = new Map();               // agentId → 已补发次数
  let pendingNeeds = new Set();                // 决策挂起中的 taskId
  let resending = false;

  /** 落账失败补发：读 subagent-failed.jsonl 新增记录 → 要求主会话用 SendMessage 恢复子 Agent 补齐 RESULT */
  async function resendPending() {
    if (resending) return; // 防重入
    resending = true;
    try {
      let raw;
      try { raw = fs.readFileSync(failedPath, 'utf-8'); } catch { return; }
      for (const line of raw.trim().split('\n').filter(Boolean)) {
        const rec = JSON.parse(line);
        const recTs = rec.ts ? new Date(rec.ts).getTime() : NaN;
        if (!Number.isFinite(recTs) || recTs <= lastFailedTs) continue;
        lastFailedTs = recTs;
        const agentId = rec.agentId;
        const count = resendCount.get(agentId) || 0;
        if (count >= resendMax) {
          log('error', `子 Agent ${agentId} 落账补发超限（${resendMax} 次），跳过`);
          continue;
        }
        resendCount.set(agentId, count + 1);
        log('warn', `子 Agent ${agentId} 落账失败（${rec.reason}），补发要求补齐 RESULT`);
        await send(await prompts.resend({ agentId, reason: rec.reason }));
      }
    } catch (e) {
      log('error', `补发检测失败: ${e.message}`);
    } finally {
      resending = false;
    }
  }

  /** 决策上抛（NEEDS_INPUT）新增记录 → 标记挂起任务（不补位，等主 Agent 向用户提问） */
  function checkNeedsInput() {
    let raw;
    try { raw = fs.readFileSync(needsPath, 'utf-8'); } catch { return; }
    for (const line of raw.trim().split('\n').filter(Boolean)) {
      const rec = JSON.parse(line);
      const recTs = rec.ts ? new Date(rec.ts).getTime() : NaN;
      if (!Number.isFinite(recTs) || recTs <= lastNeedsTs) continue;
      lastNeedsTs = recTs;
      if (rec.taskId) {
        pendingNeeds.add(rec.taskId);
        log('warn', `任务 ${rec.taskId} 需决策（${String(rec.question).slice(0, 40)}…），暂停补位等待主 Agent 提问`);
      }
    }
  }

  /** 子 Agent 事件日志体积（推进探测：有增 = 仍在跑） */
  function eventsSize() {
    try { return fs.statSync(eventsPath).size; } catch { return 0; }
  }

  /** 运行中任务的状态指纹（'' 表示任务已从 state 消失） */
  function statusesOf(ids) {
    const tasks = readTasks();
    return ids.map((id) => tasks.find((t) => t.id === id)?.status || '').join(',');
  }

  return {
    /**
     * 派发一个任务：先原子占用再注入提示词，**并确认本回合确实起了子 Agent**；发送失败或未生效则回滚占用。
     *
     * 为什么要确认「生效」：主会话收下提示词、回合正常结束，却什么子 Agent 都没派生，是真实发生过的
     * 故障形态（.awf/bugs/dispatch-without-subagent-hangs-run.md：模型凭空回了句「派发被 hook 拦截」，
     * 而项目里根本没有那个 hook）。只认 send 是否抛错的话，任务会留在 active，waitAnyDone 干等整个
     * 无变化窗口后整轮报错 —— 表现为 run 卡死。
     * 生效判据取子 Agent Start 事件（SubagentStart）：本回合起了子 Agent 才是真派发；任务已被别处结算
     * 也算无需再派。未生效 → 换重派提示词再派一次；连续 dispatchMax 次未生效 → 标 blocked 跳过。
     *
     * @returns {Promise<boolean>} true=已派发放出；false=跳过（暂停期间已被别处结算、被动态规划 hold、
     *   或连续多次派发均未生效已标 blocked）
     * @throws 透传 send 的异常（此时已 releaseActive，调用方/调度器不会误计入 running）
     */
    async dispatch(task) {
      /** 等「派发生效」：起了子 Agent → 'subagent'；任务被别处结算 → 'settled'；窗口耗尽 → null */
      async function waitDispatchAck(startsBefore) {
        const deadline = now() + dispatchAckMs;
        for (;;) {
          if (countSubagentStarts(eventsPath) > startsBefore) return 'subagent';
          const t = readTasks().find((x) => x.id === task.id);
          if (!t || t.status === 'done' || t.status === 'blocked') return 'settled';
          if (now() >= deadline) return null;
          await sleep(ackPollMs);
        }
      }

      for (let attempt = 1; attempt <= dispatchMax; attempt += 1) {
        // pause 闩锁 + 「已被别处结算就不必派」：暂停期间不能让派发路径挂死看不到结算
        const gate = await waitWhilePaused({
          label: `dispatch:${task.id}`,
          isSettled: () => {
            const t = readTasks().find((x) => x.id === task.id);
            return !!t && (t.status === 'done' || t.status === 'blocked');
          },
        });
        if (gate?.releasedBy === 'settled') {
          log('info', `任务 ${task.id} 在暂停期间已结算，跳过派发`);
          return false;
        }
        // 占用与 dynamic-planning hold 共用 state.lock：审批前 hold 一旦落盘，
        // 此处必然失败，从而堵住「先发送、后 active」的竞态窗口。重派时上一轮已回滚成 pending，可重新占用。
        if (markActive(task.id) === false) {
          log('info', `任务 ${task.id} 已非可派状态或被动态规划挂起，跳过派发`);
          return false;
        }
        const startsBefore = countSubagentStarts(eventsPath);
        const text = attempt === 1
          ? await prompts.subagentDispatch({
            taskId: task.id,
            taskTitle: task.title || '',
            taskPrompt: task.prompt || task.title || '',
          })
          : await prompts.subagentRedispatch({
            taskId: task.id,
            taskPrompt: task.prompt || task.title || '',
          });
        try {
          await send(text);
        } catch (err) {
          releaseActive(task.id);
          throw err;
        }
        const ack = await waitDispatchAck(startsBefore);
        if (ack) return true;
        log('warn', `任务 ${task.id} 第 ${attempt} 次派发未生效（主会话收下提示词但未派生任何子 Agent），回滚占用${attempt < dispatchMax ? '后重派' : ''}`);
        if (releaseActive(task.id) === false) {
          // 回滚不动说明占用已不归本流程（被别处结算/接管）——交回调用方，不越权标 blocked
          log('warn', `任务 ${task.id} 回滚占用失败，交回调用方处理`);
          return false;
        }
      }
      // 连续派发都没让主会话动起来：标 blocked 使编排不再干等（与收尾协商「多轮无产出 → blocked」同一语义）
      log('error', `任务 ${task.id} 连续 ${dispatchMax} 次派发均未生效，标记 blocked 并跳过`);
      markBlocked(task.id);
      return false;
    },

    /**
     * 等运行中集合里至少一个任务结算（done/blocked）。轮询循环每轮：
     *   pause 期间不计时 → 决策挂起(未应答)不计时不补位 → 补发落账失败的子 Agent → 收 NEEDS_INPUT →
     *   做「推进探测」：busy/状态指纹/事件日志体积任一有变即重置无变化窗口 → 判定完成。
     * 超时用「无变化窗口」而非墙钟总时长（见文件头 + .awf/bugs/timeout-must-confirm-no-cc-change.md）。
     * @param {{ taskIds(): string[] }} running 运行中集合
     * @returns {Promise<{ done: string[], suspended: boolean }>}
     *   suspended=true 表示有任务上抛 NEEDS_INPUT 且尚未解决 → 调度器应暂停补位
     * @throws 无变化窗口耗尽时抛错（保留现场待 w-monitor）
     */
    async waitAnyDone(running) {
      const ids = running.taskIds();
      pendingNeeds = new Set([...pendingNeeds].filter((id) => ids.includes(id)));
      let lastChangeAt = now();
      let lastStatuses = statusesOf(ids);
      let lastEvents = eventsSize();

      for (;;) {
        await sleep(pollMs);

        // pause 期间不计时、不推进（恢复后从恢复点续算窗口）
        const before = now();
        await waitWhilePaused();
        lastChangeAt += now() - before;

        // 决策挂起：主 Agent 正在向用户提问（answered 前）→ 不补位、不计时，等 CLI 应答
        const dp = decisionPending();
        if (dp && !dp.answered) { lastChangeAt = now(); continue; }

        await resendPending();
        checkNeedsInput();

        // 推进探测：主会话 busy / 任务状态有变 / 子 Agent 事件有增，任一发生即重置无变化窗口
        const statuses = statusesOf(ids);
        const events = eventsSize();
        if (isBusy() || statuses !== lastStatuses || events !== lastEvents) lastChangeAt = now();
        lastStatuses = statuses;
        lastEvents = events;

        const tasks = readTasks();
        const done = ids.filter((id) => {
          const t = tasks.find((x) => x.id === id);
          return t && (t.status === 'done' || t.status === 'blocked');
        });
        // 决策挂起：有任务上抛 NEEDS_INPUT 且尚未解决 → 不补位
        const suspended = pendingNeeds.size > 0;
        if (done.length > 0 || suspended) {
          for (const id of done) pendingNeeds.delete(id);
          // 有完成就先处理完成（顺带把已完成的从挂起集摘掉）；只有「本轮无完成且确实挂起」才回报
          // suspended，否则会把已跑完的任务也一起憋住不落账。
          return { done, suspended: suspended && done.length === 0 };
        }

        if (now() - lastChangeAt >= idleTimeoutMs) {
          throw new Error(`等待子 Agent 完成超时（${Math.round(idleTimeoutMs / 60000)}min 无变化）；保留现场待 w-monitor`);
        }
      }
    },
  };
}

module.exports = {
  createBatchTransport, maxTsFromLog, countSubagentStarts,
  POLL_MS, IDLE_TIMEOUT_MS, RESEND_MAX, DISPATCH_MAX, DISPATCH_ACK_MS, ACK_POLL_MS,
};
