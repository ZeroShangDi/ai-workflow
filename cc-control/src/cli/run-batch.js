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
// 补发：hook 落账失败（缺字段）→ 预留 SendMessage 恢复子 Agent 补齐（后续实现）

import path from 'node:path';
import fs from 'node:fs';
import { loadState, backupState } from '../lib/state.js';
import { runScheduler } from './scheduler.js';
import { subagentDispatch } from '../lib/plugin-bridge.js';
import { httpPostJson, sleep, SERVER_PORT } from '../lib/session/client.js';
import { logStep } from '../lib/ui/log.js';
import { GREEN, RESET } from '../lib/ui/colors.js';

const POLL_MS = 2000;
const WAIT_TIMEOUT_MS = 15 * 60 * 1000; // 单轮等待上限 15min，超时中断暴露问题
const RESEND_MAX = 2; // 单个子 Agent 落账补发上限

/** 轮询 state 检测运行中任务完成 + 检测落账失败并补发（SendMessage 恢复子 Agent 补齐 RESULT） */
function makeWaitAnyDone(projectRoot, dispatcher) {
  const failedLog = path.join(projectRoot, '.awf', 'logs', 'subagent-failed.jsonl');
  let lastFailedTs = 0; // 上次处理的失败记录时间
  const resendCount = new Map(); // agentId -> 已补发次数
  let resending = false;

  async function resendPending() {
    if (resending) return; // 防重入
    resending = true;
    try {
      let raw;
      try { raw = fs.readFileSync(failedLog, 'utf-8'); } catch { return; }
      for (const line of raw.trim().split('\n').filter(Boolean)) {
        const rec = JSON.parse(line);
        if (!rec.ts || rec.ts <= lastFailedTs) continue;
        lastFailedTs = rec.ts;
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

  return async (running) => {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    for (;;) {
      const state = loadState(projectRoot);
      const done = running.taskIds().filter((id) => {
        const t = state?.tasks?.find((x) => x.id === id);
        return t && (t.status === 'done' || t.status === 'blocked');
      });
      if (done.length > 0) return done;
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
      const prompt = await subagentDispatch({
        taskId: task.id,
        taskPrompt: task.prompt || task.title || '',
      });
      // 经 Session Server /send（tmux）注入：主会话收到指令 → 派生后台子 Agent → 回合结束
      const resp = await httpPostJson(`http://127.0.0.1:${SERVER_PORT}/send`, { text: prompt });
      if (!resp?.ok) throw new Error(`派发 ${task.id} 失败: ${resp?.error || 'unknown'}`);
      logStep('', 'ok', `派发 ${task.id}`);
    },
    async sendRaw(text) {
      const resp = await httpPostJson(`http://127.0.0.1:${SERVER_PORT}/send`, { text });
      if (!resp?.ok) throw new Error(`补发失败: ${resp?.error || 'unknown'}`);
    },
  };

  const { dispatched } = await runScheduler({
    projectRoot,
    cfg,
    dispatcher,
    waitAnyDone: makeWaitAnyDone(projectRoot, dispatcher),
  });

  backupState(projectRoot);
  console.log('');
  console.log(`  ${GREEN}✔ 工作流结束（${dispatched} 任务）${RESET}\n`);
}
