// src/cli/run-batch.js — 多 agent 批次执行循环（与单任务 runLoop 完全隔离）
//
// 仅在 run.agents.max > 1 时由 runCommand 动态 import 加载；max:1 走原 runLoop，
// 本文件不参与 → 切换回单 agent 模式零风险（现有代码路径不变）。
//
// 职责边界：
// - CLI（本模块）拥有调度权：选批 / 配额 / 认领(active+batchId) / reconcile
// - 主 Agent 只做执行适配器：按 CLI 清单并行派生子 Agent，聚合后经 MCP 落账
// - 子 Agent 只执行：不写 state、不选任务、不直接 AskUserQuestion

import { httpPostJson, waitForReady, SERVER_PORT } from '../lib/session/client.js';
import { createSpinner } from '../lib/ui/spinner.js';
import { logStep } from '../lib/ui/log.js';
import { GREEN, RESET } from '../lib/ui/colors.js';
import { loadState, saveState, selectReadyBatch, isMilestoneDone, backupState } from '../lib/state.js';
import { batchDispatch, batchReconcile } from '../lib/plugin-bridge.js';
import {
  maybeCompactContext, handleDecision, sendPrompt,
  markTaskBlocked, getTaskStatus,
  logBanner, logPrompt,
} from './run.js';

/**
 * 多 agent 主循环：批次屏障 —— 选一批 → 派发 → 等主 Stop → reconcile → 下一批。
 * @param {string} projectRoot
 * @param {{ agents: { max: number, maxModules: number, maxPerModule: number, maxPerFeature: number } }} cfg
 */
export async function runBatchLoop(projectRoot, cfg) {
  let currentState = loadState(projectRoot);
  let batchIndex = 0;

  while (currentState && currentState.currentState !== 'FINISH') {
    const batch = selectReadyBatch(currentState, cfg);
    if (batch.length === 0) {
      if (!isMilestoneDone(currentState)) {
        logStep('', 'warn', '无可调度的 ready 批次（任务依赖未满足或已 blocked），停止');
      }
      break;
    }
    batchIndex++;
    await executeBatch(batch, batchIndex, projectRoot);
    currentState = loadState(projectRoot);
  }

  backupState(projectRoot);
  console.log('');
  console.log(`  ${GREEN}✔ 工作流结束${RESET}\n`);
}

/**
 * 派发一个批次：认领 → 构造批次 prompt（含上下文检查）→ /send → 等主 Stop → reconcile。
 */
async function executeBatch(batch, batchIndex, projectRoot) {
  const batchId = `B${batchIndex}`;
  logBanner(`批次 ${batchId} (${batch.length}): ${batch.map((t) => t.id).join(', ')}`);

  // 认领：派发前置 active + batchId，防重派 / 超时可恢复
  markBatchActive(batch, batchId, projectRoot);

  const rawPrompt = await batchDispatch({
    batchId,
    tasks: batch.map((t) => ({
      taskId: t.id,
      title: t.title || '',
      kind: t.kind || 'dev',
      prompt: t.prompt || t.title || '',
    })),
  });
  // 上下文检查：整批一次（batchIndex 复用任务序号语义，第一个批次跳过）
  const prompt = await maybeCompactContext(rawPrompt, batchIndex, projectRoot);
  logPrompt(prompt);

  const sendResp = await httpPostJson(`http://127.0.0.1:${SERVER_PORT}/send`, { text: prompt });
  if (!sendResp?.ok) {
    logStep('', 'error', `/send 失败: ${sendResp?.error || 'unknown'}`);
    return;
  }

  const spin = createSpinner(`batch ${batchId} executing...`);
  try {
    await waitForReady({ onDecision: handleDecision });
    spin.stop();
  } catch (err) {
    spin.stop();
    logStep('', 'error', `批次 ${batchId} 超时: ${err.message}`);
  }

  await reconcileBatch(batch, batchId, projectRoot);
}

/** 认领：只把仍 pending 的任务置 active + 记 batchId */
function markBatchActive(batch, batchId, projectRoot) {
  const state = loadState(projectRoot);
  let changed = false;
  for (const t of batch) {
    const task = state?.tasks?.find((x) => x.id === t.id);
    if (task && task.status === 'pending') {
      task.status = 'active';
      task.batchId = batchId;
      changed = true;
    }
  }
  if (changed) saveState(projectRoot, state);
}

/**
 * 批次 reconcile：主 Stop 后逐任务核对落账情况。
 * 未 done/blocked 的任务补发一次批次收尾 prompt；仍不落账 → 标 blocked 需人工介入。
 */
async function reconcileBatch(batch, batchId, projectRoot) {
  const unfinished = batch.filter((t) => {
    const st = getTaskStatus(t.id, projectRoot);
    return st !== 'done' && st !== 'blocked';
  });
  if (unfinished.length === 0) {
    console.log(`     ${GREEN}✔ 批次 ${batchId} 全部完成${RESET}`);
    return;
  }

  logStep('', 'warn', `批次 ${batchId} 有 ${unfinished.length} 个任务未落账，补发收尾`);
  await sendPrompt(await batchReconcile(batchId));

  const still = unfinished.filter((t) => {
    const st = getTaskStatus(t.id, projectRoot);
    return st !== 'done' && st !== 'blocked';
  });
  for (const t of still) {
    logStep('', 'error', `任务 ${t.id} 批次收尾后仍未完成，标记 blocked 需人工介入`);
    markTaskBlocked(t.id, projectRoot);
  }
  console.log(`     ${GREEN}✔ 批次 ${batchId} reconcile 完成${RESET}`);
}
