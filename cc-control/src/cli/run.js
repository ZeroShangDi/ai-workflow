import { spawn, execSync } from 'child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getPaths } from '../lib/paths.js';
import { taskWrapup, taskSettle, contextCheck } from '../lib/plugin-bridge.js';
import { installProjectMcp } from '../lib/profile.js';
import { loadState, findNextTask, backupState, saveState } from '../lib/state.js';
import { loadRunConfig } from '../lib/run-config.js';
import { httpPost, httpPostJson, autoSelect, waitForReady, getStatus, sleep, sendCmd, getContextReady, SERVER_PORT } from '../lib/session/client.js';
import { createSpinner } from '../lib/ui/spinner.js';
import { logSection, logStep } from '../lib/ui/log.js';
import { CYAN, GREEN, YELLOW, RED, DIM, RESET } from '../lib/ui/colors.js';

/**
 * awf run — 启动自治开发工作流
 *
 * 流程：
 *   1. 启动 Session Server + tmux session
 *   2. 遍历 tasks，逐任务发送 prompt → waitForReady
 *   3. 自动处理 AI 的决策请求
 *   4. 全部完成后备份 state → .awf/versions/
 */
export async function runCommand(task, options) {
  const paths = getPaths();
  const projectRoot = process.cwd();

  // 验证 state
  const state = loadState(projectRoot);
  if (!state) {
    console.log(`${RED}  未找到 .awf/state.json，请先执行 awf plan${RESET}\n`);
    process.exit(1);
  }

  // 信号清理
  let cleaned = false;
  const doCleanup = () => {
    if (cleaned) return;
    cleaned = true;
    const session = process.env.CC_SESSION || 'cc';
    try { execSync(`tmux kill-session -t ${session} 2>/dev/null`, { stdio: 'ignore' }); } catch {}
    // 只杀监听端口的 server，避免误杀自己——client 与 server 有 keep-alive 连接，
    // 若不带 -sTCP:LISTEN，lsof 会把本进程也算进去，kill -9 后 run 以被 SIGKILL 结束（exit 非 0）
    try { execSync(`lsof -ti:${SERVER_PORT} -sTCP:LISTEN | xargs kill -9 2>/dev/null`, { stdio: 'ignore' }); } catch {}
    console.log(`${DIM}  服务已关闭${RESET}`);
  };
  process.on('SIGINT', () => { doCleanup(); process.exit(0); });
  process.on('SIGTERM', () => { doCleanup(); process.exit(0); });

  // Header
  const summary = state.plan?.summary || task || '';
  console.log(`${CYAN}⚡ AI Workflow 运行${RESET}`);
  console.log(`  ${DIM}工作流:${RESET} ${summary}\n`);

  // 1. 启动环境
  logSection('启动环境');
  await startSession({
    serverScript: paths.tmuxServer,
    bootstrapScript: paths.bootstrapScript,
    projectRoot: paths.projectRoot,
    workDir: projectRoot,
  });

  spawn('open', [`http://localhost:${SERVER_PORT}`], { stdio: 'ignore', detached: true }).unref();
  logStep('dashboard', 'ok', `http://localhost:${SERVER_PORT}`);
  console.log('');

  // 2. 任务循环（单/多 agent 分流）
  //    单 agent（run.agents.max === 1，默认）→ 原 runLoop，多 agent 代码不参与，切换零风险
  try {
    const cfg = loadRunConfig(projectRoot);
    if (cfg.agents.max > 1) {
      const { runBatchLoop } = await import('./run-batch.js');
      await runBatchLoop(projectRoot, cfg);
    } else {
      await runLoop(projectRoot);
    }
  } finally {
    doCleanup();
  }
}

// ── Session 环境管理 ──

/** 启动 Session Server + tmux session 两个基础设施 */
async function startSession({ serverScript, bootstrapScript, projectRoot, workDir, sessionName = 'cc' }) {
  // 项目级 .mcp.json 是 MCP 工具可用的必要条件（enabled-only 插件注册下插件 .mcp.json 不暴露工具）
  // 幂等合并：只刷新 awf-* server 的绝对路径，保留项目已有 server
  const m = installProjectMcp(workDir, projectRoot, SERVER_PORT);
  if (m.written) logStep('.mcp.json', 'ok', `已确保项目 MCP 注册 → ${m.servers.join(', ')}`);
  await ensureServer(serverScript, projectRoot, workDir);
  await writeRunSettings(workDir, projectRoot);
  await ensureSession(bootstrapScript, workDir, sessionName);
}

/** 确保 Session Server 已启动，先释放旧端口再 spawn */
async function ensureServer(serverScript, projectRoot, workDir) {
  try { execSync(`lsof -ti:${SERVER_PORT} -sTCP:LISTEN | xargs kill -9 2>/dev/null`, { stdio: 'ignore' }); } catch {}
  await sleep(300);

  const spin = createSpinner('starting tmux-http ...');
  const proc = spawn('node', [serverScript], {
    stdio: 'ignore', detached: true, cwd: projectRoot,
    env: { ...process.env, CC_PORT: String(SERVER_PORT), CC_PROJECT: workDir },
  });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const st = await getStatus(SERVER_PORT);
    if (st && st.state) { spin.stop(); logStep('tmux-http', 'ok', '已启动'); return; }
  }
  spin.stop();
  throw new Error('Session Server 启动超时');
}

/** 确保 tmux session 存在，先杀旧再 bootstrap 重建 */
async function ensureSession(bootstrapScript, workDir, sessionName) {
  try { execSync(`tmux kill-session -t ${sessionName} 2>/dev/null`, { stdio: 'ignore' }); } catch {}
  execSync(`bash "${bootstrapScript}"`, {
    stdio: 'ignore', cwd: workDir,
    env: { ...process.env, CC_WORKDIR: workDir, CC_SESSION: sessionName },
  });
  logStep('session', 'ok', `${sessionName} → ${workDir}`);
}

/**
 * 写 run-session 专属 settings（.awf/run-settings.json）— 仅声明 statusLine 上下文占用状态行。
 * bootstrap 以 --settings 注入（合并语义：只覆盖 statusLine 键，不动用户/项目 settings），
 * 使 tmux 会话里状态行每次刷新把 context_window 实测百分比写入 .awf/context/usage.json。
 * 作用域限定在 run 会话，不污染用户在项目里的交互式会话。
 */
async function writeRunSettings(workDir, pkgRoot) {
  await fs.mkdir(path.join(workDir, '.awf'), { recursive: true });
  await fs.writeFile(
    path.join(workDir, '.awf', 'run-settings.json'),
    JSON.stringify(
      {
        statusLine: {
          type: 'command',
          command: `node "${path.join(pkgRoot, 'scripts', 'context-usage.mjs')}" "${workDir}"`,
          refreshInterval: 30,
        },
      },
      null,
      2,
    ),
  );
}

// ── 任务循环 ──

/**
 * 主任务循环：遍历 state 中的所有 pending 任务，依次执行直到 FINISH
 * 包含重试机制：连续 2 次超时则跳过该任务
 */
async function runLoop(projectRoot) {
  let currentState = loadState(projectRoot);
  const allTasks = currentState?.tasks || [];
  const total = allTasks.length;
  let consecutiveTimeouts = 0;

  while (currentState && currentState.currentState !== 'FINISH') {
    const nextTask = findNextTask(currentState);
    if (!nextTask) break;

    const idx = allTasks.findIndex(t => t.id === nextTask.id) + 1;
    logBanner(`任务 ${idx}/${total}: ${nextTask.title}`);
    logPrompt(nextTask.prompt || nextTask.title || '');

    // 任务前上下文检查：AI 按 code-context-onboard 判断是否需压缩，需要则 /clear 后注入快照
    const taskPrompt = nextTask.prompt || nextTask.title || '';
    const prompt = await maybeCompactContext(taskPrompt, idx, projectRoot);
    const result = await executeTask(prompt, nextTask.id, projectRoot);
    currentState = loadState(projectRoot);

    if (result === 'timeout') {
      consecutiveTimeouts++;
      const taskStillPending = findNextTask(currentState);
      if (taskStillPending && taskStillPending.id === nextTask.id) {
        logStep('', 'warn', `任务 ${nextTask.id} 仍为 pending，即将重试`);
        if (consecutiveTimeouts >= 2) {
          logStep('', 'error', `连续 ${consecutiveTimeouts} 次超时，跳过任务 ${nextTask.id}（已标 blocked，需人工介入）`);
          markTaskBlocked(nextTask.id, projectRoot);
          consecutiveTimeouts = 0;
        }
      } else {
        consecutiveTimeouts = 0;
      }
    } else {
      consecutiveTimeouts = 0;
    }
  }

  backupState(projectRoot);
  console.log('');
  console.log(`${GREEN}  ✔ 工作流结束${RESET}\n`);
}

/**
 * 发送 prompt 到 Session Server → 等待就绪 → 收尾协商
 * @returns {'done' | 'timeout' | 'blocked' | 'stuck'}
 */
async function executeTask(prompt, taskId, projectRoot) {
  const sendResp = await httpPostJson(`http://127.0.0.1:${SERVER_PORT}/send`, { text: prompt });
  if (!sendResp?.ok) { logStep('', 'error', `/send 失败: ${sendResp?.error || 'unknown'}`); return 'timeout'; }

  const spin = createSpinner('executing...');
  try {
    await waitForReady({ onDecision: handleDecision });
    spin.stop();
    if (!taskId) { console.log(`     ${GREEN}✔ done${RESET}`); return 'done'; }
    return await settleTask(taskId, projectRoot);
  } catch (err) {
    spin.stop();
    if (taskId && checkTaskDone(taskId, projectRoot)) {
      logStep('', 'warn', `超时但任务 ${taskId} 已完成（Stop hook 未触发）`);
      return 'done';
    }
    logStep('', 'error', `超时: ${err.message}`);
    return 'timeout';
  }
}

/** 收尾协商追问的最大轮数，超过则标 blocked 跳过 */
const MAX_SETTLE_ROUNDS = 3;

/**
 * 收尾协商循环 — 校验任务是否 done，未 done 则补发收尾 prompt 再追问，
 * 最多 MAX_SETTLE_ROUNDS 轮，仍未完成则标 blocked 并跳过。
 * @returns {'done' | 'blocked' | 'stuck'}
 */
async function settleTask(taskId, projectRoot) {
  if (checkTaskDone(taskId, projectRoot)) { console.log(`     ${GREEN}✔ done${RESET}`); return 'done'; }

  logStep('', 'warn', `任务 ${taskId} 未标记 done，补发收尾 prompt`);
  await sendPrompt(await taskWrapup(taskId));
  if (checkTaskDone(taskId, projectRoot)) {
    logStep('', 'ok', `收尾 prompt 已生效`);
    console.log(`     ${GREEN}✔ done${RESET}`);
    return 'done';
  }

  for (let round = 1; round <= MAX_SETTLE_ROUNDS; round++) {
    logStep('', 'warn', `任务 ${taskId} 仍为 pending，追问（第 ${round}/${MAX_SETTLE_ROUNDS} 轮）`);
    await sendPrompt(await taskSettle(taskId));
    if (checkTaskDone(taskId, projectRoot)) {
      logStep('', 'ok', `任务 ${taskId} 已完成`);
      console.log(`     ${GREEN}✔ done${RESET}`);
      return 'done';
    }
    if (getTaskStatus(taskId, projectRoot) === 'blocked') {
      logStep('', 'warn', `任务 ${taskId} 已标记 blocked，暂停等待人工介入`);
      return 'blocked';
    }
  }

  logStep('', 'error', `任务 ${taskId} 多轮追问后仍未完成，标记 blocked 并跳过`);
  markTaskBlocked(taskId, projectRoot);
  return 'stuck';
}

/** 发送 prompt 并等待 ready；超时忽略（由上层回查 state 决定下一步） */
export async function sendPrompt(text) {
  await httpPostJson(`http://127.0.0.1:${SERVER_PORT}/send`, { text });
  try { await waitForReady({ onDecision: handleDecision }); } catch { /* 超时忽略 */ }
}

/**
 * 任务前上下文压缩检查 — 每个任务执行前（跳过第一个任务）调一次，分两层：
 *   第一层 CLI：读 statusline 实测占用，低于 checkThreshold → 直接发任务（零额外往返）
 *   第二层 AI ：占用 ≥ 阈值 或 无实测 → 发 context-check prompt，AI 结合下个任务体量精确判断
 *     → 不需压缩 → 原样返回任务 prompt
 *     → 需要压缩 → AI 写快照 + awf_context_ready → CLI 读快照 + /clear + 前缀注入
 *
 * 扩展点（未来可配置的前置处理管道接缝）：启用/跳过/阈值统一从
 * contextCompactionConfig() 读取，后续接 .awf/config.json / awf run flag 等配置源时
 * 只改这一个函数即可，也可在此挂更多任务前处理。
 *
 * @param {string} taskPrompt - 原始任务 prompt
 * @param {number} taskIndex - 1-based 任务序号（第一个任务跳过检查）
 * @param {string} projectRoot - 用户项目根目录（cwd）
 * @returns {Promise<string>} 可能注入快照后的任务 prompt
 */
export async function maybeCompactContext(taskPrompt, taskIndex, projectRoot) {
  const cfg = contextCompactionConfig();
  if (!cfg.enabled) return taskPrompt;
  if (cfg.skipFirst && taskIndex <= (cfg.skipFirstCount || 1)) return taskPrompt;

  const pct = await readContextUsage(projectRoot);

  // 第一层（CLI）：有实测且低于过滤阈值 → 上下文充足，直接执行任务，零额外往返
  if (pct !== null && pct < cfg.checkThreshold) return taskPrompt;

  // 第二层（AI）：占用 ≥ 阈值（上下文接近上限）或无实测（statusline 未配置，回退自估算）
  //   → 注入实测百分比，让 AI 结合对话实际与下个任务体量精确判断
  await sendPrompt(await contextCheck(formatContextUsage(pct)));

  // 查就绪标记（一次性消费）— 未触发 → 原样执行
  const ready = await getContextReady(SERVER_PORT);
  if (!ready) return taskPrompt;

  // 3. 压缩：读快照 → /clear 清空对话 → 快照前缀注入下个任务 prompt
  //    快照不可读时保守跳过（清空却不注入比保留旧上下文更糟）
  logStep('', 'warn', `上下文接近窗口上限，压缩中（/clear 后注入快照）`);
  const snapshot = await readHandoffSnapshot(projectRoot);
  if (!snapshot) {
    logStep('', 'warn', `快照不可读 (.awf/context/handoff.md)，跳过压缩`);
    return taskPrompt;
  }
  await sendCmd('/clear');
  logStep('', 'ok', `已注入上下文快照 (.awf/context/handoff.md)`);
  return `【上下文快照】按 code-context-onboard 生成，接手前先读\n${snapshot}\n\n${taskPrompt}`;
}

/** 上下文压缩检查配置 — 未来配置源的接缝（当前硬编码默认值） */
function contextCompactionConfig() {
  return {
    enabled: true,
    skipFirst: true,
    skipFirstCount: 1,
    // 第一层 CLI 过滤阈值：实测占用低于此值直接放行，不打扰 AI。
    // 高于旧压缩触发点(65%)，只把「真接近上限」的场景交给 AI 第二层精确判断
    checkThreshold: 80,
  };
}

/** 读取 AI 写好的交接快照；不存在或不可读 → null（降级为不注入） */
async function readHandoffSnapshot(projectRoot) {
  try {
    return await fs.readFile(path.join(projectRoot, '.awf', 'context', 'handoff.md'), 'utf-8');
  } catch {
    return null;
  }
}

/** 读取 statusline 写入的 usage.json 中实测百分比；缺省 → null（回退 AI 自估算） */
async function readContextUsage(projectRoot) {
  try {
    const raw = await fs.readFile(path.join(projectRoot, '.awf', 'context', 'usage.json'), 'utf-8');
    const pct = JSON.parse(raw).used_percentage;
    return typeof pct === 'number' ? pct : null;
  } catch {
    return null;
  }
}

/** 格式化上下文占用描述：有实测 → 带百分比；无 → 提示 AI 自行估算 */
function formatContextUsage(pct) {
  return pct !== null ? `已用约 ${pct}%（statusline 实测）` : '未知（statusline 未配置，请自行估算）';
}

/** 从 state.json 中检查指定任务是否已标记 done */
function checkTaskDone(taskId, projectRoot) {
  const state = loadState(projectRoot);
  const tasks = state?.tasks || [];
  return tasks.find(t => t.id === taskId)?.status === 'done';
}

/** 读取指定任务的 status（pending/active/done/blocked） */
export function getTaskStatus(taskId, projectRoot) {
  const state = loadState(projectRoot);
  const tasks = state?.tasks || [];
  return tasks.find(t => t.id === taskId)?.status || null;
}

/** 编排器仲裁：将任务标记为 blocked（使 findNextTask 跳过，避免死循环） */
export function markTaskBlocked(taskId, projectRoot) {
  const state = loadState(projectRoot);
  const task = state?.tasks?.find(t => t.id === taskId);
  if (!task) return;
  task.status = 'blocked';
  saveState(projectRoot, state);
}

// ── 决策处理 ──

/** 已处理过的问题去重 */
const seenAnswers = new Set();

/**
 * 处理 AI 发出的决策请求：
 *   AskUserQuestion → 自动选择（5s 倒计时）
 *   choice          → readline 手动选择
 *   text            → readline 手动输入
 */
export async function handleDecision(d) {
  if (d.source === 'AskUserQuestion') {
    if (d.answered) {
      if (!seenAnswers.has(d.question)) { console.log(`     ${GREEN}✔ 已选择: ${d.answer}${RESET}`); seenAnswers.add(d.question); }
      return;
    }
    console.log(`\n${YELLOW}  ⚡ AI 提问:${RESET} ${CYAN}${d.question}${RESET}${d.multiSelect ? ` ${DIM}(多选)${RESET}` : ''}`);
    if (d.options?.length) d.options.forEach((o, i) => console.log(`     ${DIM}${i + 1}.${RESET} ${o}`));
    const sel = await autoSelect(d);
    if (sel) {
      if (sel.multiSelect) await httpPost(`http://127.0.0.1:${SERVER_PORT}/respond`, { value: sel.selected.join(',') });
      else if (sel.index > 0) await httpPost(`http://127.0.0.1:${SERVER_PORT}/respond`, { value: String(sel.index) });
      else if (sel.customInput) await httpPost(`http://127.0.0.1:${SERVER_PORT}/respond`, { value: sel.customInput });
    }
    return;
  }

  console.log(`\n${YELLOW}  ⚡ AI 需要决策...${RESET}`);
  const { createInterface } = await import('readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  if (d.type === 'choice') {
    console.log(`  ${CYAN}${d.question}${RESET}`);
    d.options.forEach((o, i) => console.log(`     ${DIM}${i + 1}.${RESET} ${o}`));
    const answer = await new Promise((resolve) => rl.question(`  ${DIM}选择 (1-${d.options.length}): ${RESET}`, (a) => { rl.close(); resolve(a.trim()); }));
    const value = d.options[parseInt(answer, 10) - 1] || answer;
    await httpPost(`http://127.0.0.1:${SERVER_PORT}/respond`, JSON.stringify({ value }));
    console.log(`     ${GREEN}✔ 已选择: ${value}${RESET}\n`);
    return;
  }

  console.log(`  ${CYAN}${d.question}${RESET}`);
  const answer = await new Promise((resolve) => rl.question(`  ${DIM}输入: ${RESET}`, (a) => { rl.close(); resolve(a.trim()); }));
  if (answer) {
    await httpPost(`http://127.0.0.1:${SERVER_PORT}/respond`, JSON.stringify({ value: answer }));
    console.log(`     ${GREEN}✔ 已发送${RESET}\n`);
  }
}

// ── 输出辅助 ──

/** 完整显示 prompt（多行，保留 XML 标签结构） */
export function logPrompt(prompt) {
  const lines = prompt.split('\n');
  console.log(`     ${DIM}prompt (${lines.length} 行 · ${prompt.length} 字符)${RESET}`);
  for (const line of lines) {
    console.log(`       ${line}`);
  }
}

/** 打印任务分隔横幅 */
export function logBanner(text) { console.log(`${CYAN}  ── ${text} ──${RESET}`); }
