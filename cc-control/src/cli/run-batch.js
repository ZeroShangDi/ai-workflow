// src/cli/run-batch.js — 滑动窗口调度集成（CLI 拥有调度权）
//
// 与单任务 runLoop 完全隔离：仅在 run.agents.max > 1 时由 runCommand 动态 import 加载。
//
// CLI 调度：就绪池 + 配额 + 补位循环（runScheduler，见 scheduler.js）
// 派发：经 inbox socket 注入「派生后台子 Agent 执行 task」指令（主会话回合中读到，不打断运行工具）
// 落账：子 Agent 结束 → SubagentStop hook → server 解析 last_assistant_message 的 RESULT → 写 state
// 完成感知：CLI 轮询 state 检测运行中任务 done/blocked（容忍延迟）
// 补发：hook 落账失败（缺字段）→ 预留 SendMessage 恢复子 Agent 补齐（后续实现）

import path from 'node:path';
import { loadState, backupState } from '../lib/state.js';
import { runScheduler } from './scheduler.js';
import { injectText } from '../lib/messaging.js';
import { subagentDispatch } from '../lib/plugin-bridge.js';
import { sleep } from '../lib/session/client.js';
import { logStep } from '../lib/ui/log.js';
import { GREEN, RESET } from '../lib/ui/colors.js';

const POLL_MS = 2000;
const WAIT_TIMEOUT_MS = 15 * 60 * 1000; // 单轮等待上限 15min，超时中断暴露问题

/** 轮询 state，检测运行中任务完成（done/blocked），容忍延迟 */
function makeWaitAnyDone(projectRoot) {
  return async (running) => {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    for (;;) {
      const state = loadState(projectRoot);
      const done = running.taskIds().filter((id) => {
        const t = state?.tasks?.find((x) => x.id === id);
        return t && (t.status === 'done' || t.status === 'blocked');
      });
      if (done.length > 0) return done;
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
  const socketPath = path.join(projectRoot, '.awf', 'messaging.sock');
  const dispatcher = {
    async send(task) {
      const prompt = await subagentDispatch({
        taskId: task.id,
        taskPrompt: task.prompt || task.title || '',
      });
      await injectText(socketPath, prompt);
      logStep('', 'ok', `派发 ${task.id} → socket`);
    },
  };

  const { dispatched } = await runScheduler({
    projectRoot,
    cfg,
    dispatcher,
    waitAnyDone: makeWaitAnyDone(projectRoot),
  });

  backupState(projectRoot);
  console.log('');
  console.log(`  ${GREEN}✔ 工作流结束（${dispatched} 任务）${RESET}\n`);
}
