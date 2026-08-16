import { spawn, execSync } from 'child_process';
import { getPaths } from '../lib/paths.js';
import { taskWrapup, taskSettle } from '../lib/plugin-bridge.js';
import { loadState, findNextTask, backupState, saveState } from '../lib/state.js';
import { httpPost, httpPostJson, autoSelect, waitForReady, getStatus, sleep, SERVER_PORT } from '../lib/session/client.js';
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
    try { execSync(`lsof -ti:${SERVER_PORT} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' }); } catch {}
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

  // 2. 任务循环
  try {
    await runLoop(projectRoot);
  } finally {
    doCleanup();
  }
}

// ── Session 环境管理 ──

/** 启动 Session Server + tmux session 两个基础设施 */
async function startSession({ serverScript, bootstrapScript, projectRoot, workDir, sessionName = 'cc' }) {
  await ensureServer(serverScript, projectRoot, workDir);
  await ensureSession(bootstrapScript, workDir, sessionName);
}

/** 确保 Session Server 已启动，先释放旧端口再 spawn */
async function ensureServer(serverScript, projectRoot, workDir) {
  try { execSync(`lsof -ti:${SERVER_PORT} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' }); } catch {}
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

    const result = await executeTask(nextTask.prompt || nextTask.title || '', nextTask.id, projectRoot);
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
async function sendPrompt(text) {
  await httpPostJson(`http://127.0.0.1:${SERVER_PORT}/send`, { text });
  try { await waitForReady({ onDecision: handleDecision }); } catch { /* 超时忽略 */ }
}

/** 从 state.json 中检查指定任务是否已标记 done */
function checkTaskDone(taskId, projectRoot) {
  const state = loadState(projectRoot);
  const tasks = state?.tasks || [];
  return tasks.find(t => t.id === taskId)?.status === 'done';
}

/** 读取指定任务的 status（pending/active/done/blocked） */
function getTaskStatus(taskId, projectRoot) {
  const state = loadState(projectRoot);
  const tasks = state?.tasks || [];
  return tasks.find(t => t.id === taskId)?.status || null;
}

/** 编排器仲裁：将任务标记为 blocked（使 findNextTask 跳过，避免死循环） */
function markTaskBlocked(taskId, projectRoot) {
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
async function handleDecision(d) {
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
function logPrompt(prompt) {
  const lines = prompt.split('\n');
  console.log(`     ${DIM}prompt (${lines.length} 行 · ${prompt.length} 字符)${RESET}`);
  for (const line of lines) {
    console.log(`       ${line}`);
  }
}

/** 打印任务分隔横幅 */
function logBanner(text) { console.log(`${CYAN}  ── ${text} ──${RESET}`); }
