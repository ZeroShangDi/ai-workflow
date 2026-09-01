// src/cli/run-batch.js — 滑动窗口调度集成（CLI 拥有调度权）
//
// 与单任务 runLoop 完全隔离：仅在 run.agents.max > 1 时由 runCommand 动态 import 加载。
//
// CLI 调度：就绪池 + 配额 + 补位循环（runScheduler，见 scheduler.js）
// 派发：经 /send（tmux send-keys）向主会话注入「派生后台子 Agent 执行 task」指令。
//   —— 首选是 inbox socket 即时补位（messaging.js），但 2.1.227 的 cross-session messaging
//      内部开关（CLAUDE_CODE_HARBOR_KITE）实测无效（socket 不绑定），暂降级 tmux 回合补位：
//      主会话每回合派后台子 Agent 后立即结束回合，CLI 感知完成 → 下回合补位。后台子 Agent
//      跨回合运行，并发由子 Agent 维持。
// 落账：子 Agent 结束 → SubagentStop hook → server 解析 last_assistant_message 的 RESULT → 写 state
// 完成感知：CLI 轮询 state 检测运行中任务 done/blocked（容忍延迟）
// 补发：hook 落账失败 → 读 subagent-failed.jsonl → SendMessage 恢复子 Agent 补齐 RESULT
// 决策上抛：NEEDS_INPUT → 读 subagent-needs-input.jsonl → 标记挂起，暂停补位等主 Agent 问用户

import path from 'node:path';
import fs from 'node:fs';
import { loadState, backupState, markTaskActive } from '../lib/state.js';
import { runScheduler } from './scheduler.js';
import { handleGateCompletion } from './gate-fix.js';
import { subagentDispatch } from '../lib/plugin-bridge.js';
import { httpPostJson, sleep, SERVER_PORT, getStatus } from '../lib/session/client.js';
import { handleDecision } from './run.js';
import { logStep, logTask } from '../lib/ui/log.js';
import { waitWhilePaused } from '../lib/pause.js';
import { GREEN, RESET } from '../lib/ui/colors.js';

const POLL_MS = 2000;
const WAIT_TIMEOUT_MS = 15 * 60 * 1000; // 单轮等待上限 15min，超时中断暴露问题
const RESEND_MAX = 2; // 单个子 Agent 落账补发上限

/** 读取日志中已有记录的最大 ts（毫秒）；文件不存在/空 → 0。起始游标取此值，
 *  跳过历史残留（此前 run 未清干净 / server 未清空），避免整段重放触发伪补发。 */
function maxTsFromLog(logPath) {
  let max = 0;
  let raw;
  try { raw = fs.readFileSync(logPath, 'utf-8'); } catch { return 0; }
  for (const line of raw.trim().split('\n').filter(Boolean)) {
    try {
      const t = new Date(JSON.parse(line).ts).getTime();
      if (Number.isFinite(t) && t > max) max = t;
    } catch { /* 跳过坏行 */ }
  }
  return max;
}

/** 轮询 state 检测完成 + 落账失败补发 + 决策上抛挂起（NEEDS_INPUT 未解决 → suspended） */
function makeWaitAnyDone(projectRoot, dispatcher) {
  const failedLog = path.join(projectRoot, '.awf', 'logs', 'subagent-failed.jsonl');
  const needsLog = path.join(projectRoot, '.awf', 'logs', 'subagent-needs-input.jsonl');
  let lastFailedTs = maxTsFromLog(failedLog); // 上次处理的失败记录时间（毫秒游标）
  let lastNeedsTs = maxTsFromLog(needsLog);   // 上次处理的决策上抛记录时间（毫秒游标）
  const resendCount = new Map(); // agentId -> 已补发次数
  const pendingNeeds = new Map(); // taskId -> true（决策挂起中）
  let resending = false;

  async function resendPending() {
    if (resending) return; // 防重入
    resending = true;
    try {
      let raw;
      try { raw = fs.readFileSync(failedLog, 'utf-8'); } catch { return; }
      for (const line of raw.trim().split('\n').filter(Boolean)) {
        const rec = JSON.parse(line);
        const recTs = rec.ts ? new Date(rec.ts).getTime() : NaN;
        if (!Number.isFinite(recTs) || recTs <= lastFailedTs) continue;
        lastFailedTs = recTs;
        const agentId = rec.agentId;
        const count = resendCount.get(agentId) || 0;
        if (count >= RESEND_MAX) {
          logStep('', 'error', `子 Agent ${agentId} 落账补发超限（${RESEND_MAX} 次），跳过`);
          continue;
        }
        resendCount.set(agentId, count + 1);
        logStep('', 'warn', `子 Agent ${agentId} 落账失败（${rec.reason}），补发要求补齐 RESULT`);
        const prompt = `子 Agent ${agentId} 的 RESULT 输出无效（${rec.reason}）。请用 SendMessage（to=该子 Agent）恢复它，要求它重新以最后一行 \`RESULT: {...}\` 输出正确结果，taskId 必须是派发给它的任务 ID。不要自己执行任务。`;
        await dispatcher.sendRaw(prompt);
      }
    } catch (e) {
      logStep('', 'error', `补发检测失败: ${e.message}`);
    } finally {
      resending = false;
    }
  }

  /** 检测决策上抛记录（NEEDS_INPUT），标记挂起任务 */
  async function checkNeedsInput() {
    let raw;
    try { raw = fs.readFileSync(needsLog, 'utf-8'); } catch { return; }
    for (const line of raw.trim().split('\n').filter(Boolean)) {
      const rec = JSON.parse(line);
      const recTs = rec.ts ? new Date(rec.ts).getTime() : NaN;
      if (!Number.isFinite(recTs) || recTs <= lastNeedsTs) continue;
      lastNeedsTs = recTs;
      if (rec.taskId) {
        pendingNeeds.set(rec.taskId, true);
        logStep('', 'warn', `任务 ${rec.taskId} 需决策（${rec.question.slice(0, 40)}...），暂停补位等待主 Agent 提问`);
      }
    }
  }

  return async (running) => {
    let deadline = Date.now() + WAIT_TIMEOUT_MS;
    for (;;) {
      // 暂停期间不处理完成落账、决策或补发，避免恢复修复尚未验证时继续推进编排。
      const pauseStarted = Date.now();
      await waitWhilePaused(projectRoot);
      deadline += Date.now() - pauseStarted;
      // 响应主 Agent 决策（AskUserQuestion 原生上抛）：hook → server decisionPending → 本层处理 → /respond。
      // 决策处理期间阻塞 = 调度器不返回 = 暂停补位；处理完（AskUserQuestion 结束）恢复。
      const status = await getStatus(SERVER_PORT);
      const dp = status?.decisionPending;
      if (dp && !dp.answered) {
        await handleDecision(dp);
        continue;
      }

      const state = loadState(projectRoot);
      const done = running.taskIds().filter((id) => {
        const t = state?.tasks?.find((x) => x.id === id);
        return t && (t.status === 'done' || t.status === 'blocked');
      });
      await checkNeedsInput();
      // 决策挂起：有待解决 NEEDS_INPUT 且主 Agent 正 AskUserQuestion（进行中）→ 不补位
      const suspended = pendingNeeds.size > 0 && !!dp && !dp.answered;
      if (done.length > 0 || suspended) return { done, suspended };
      await resendPending();
      if (Date.now() > deadline) throw new Error(`等待任务完成超时（${WAIT_TIMEOUT_MS / 60000}min）`);
      await sleep(POLL_MS);
    }
  };
}

/**
 * 滑动窗口执行入口（max>1 时由 runCommand 调用）。
 * @param {string} projectRoot
 * @param {{ agents: object }} cfg
 */
export async function runBatchLoop(projectRoot, cfg) {
  const dispatcher = {
    async send(task) {
      await waitWhilePaused(projectRoot);
      const prompt = await subagentDispatch({
        taskId: task.id,
        taskTitle: task.title || '',
        taskPrompt: task.prompt || task.title || '',
      });
      // 经 Session Server /send（tmux）注入：主会话收到指令 → 派生后台子 Agent → 回合结束
      const resp = await httpPostJson(`http://127.0.0.1:${SERVER_PORT}/send`, { text: prompt });
      if (!resp?.ok) throw new Error(`派发 ${task.id} 失败: ${resp?.error || 'unknown'}`);
      markTaskActive(projectRoot, task.id);
      logTask(task.id, task.title, 'active');
    },
    async sendRaw(text) {
      await waitWhilePaused(projectRoot);
      const resp = await httpPostJson(`http://127.0.0.1:${SERVER_PORT}/send`, { text });
      if (!resp?.ok) throw new Error(`补发失败: ${resp?.error || 'unknown'}`);
    },
  };

  const { dispatched } = await runScheduler({
    projectRoot,
    cfg,
    dispatcher,
    waitAnyDone: makeWaitAnyDone(projectRoot, dispatcher),
    // 门禁闭环：门禁任务（review/test）blocked + verdict 非 pass → 派生修复任务 + 回退复审
    onTaskComplete: async (id, task) => {
      const settled = loadState(projectRoot)?.tasks?.find((item) => item.id === id);
      const title = settled?.title || task.title || '未命名任务';
      const status = settled?.status || task.status;
      logTask(id, title, status === 'done' ? 'done' : 'blocked');
      await handleGateCompletion(projectRoot, id, settled || task);
    },
  });

  backupState(projectRoot);
  console.log('');
  console.log(`  ${GREEN}✔ 工作流结束（${dispatched} 任务）${RESET}\n`);
}
