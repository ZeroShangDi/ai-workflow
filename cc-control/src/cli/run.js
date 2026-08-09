import { spawn, execSync } from 'child_process';
import { getPaths } from '../lib/paths.js';
import { loadState, findNextTask, backupState } from '../lib/state.js';
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
  const allTasks = currentState?.plan?.tasks || currentState?.tasks || [];
  const total = allTasks.length;
  let consecutiveTimeouts = 0;

  while (currentState && currentState.currentState !== 'FINISH') {
    const nextTask = findNextTask(currentState);
    if (!nextTask) break;

    const idx = allTasks.findIndex(t => t.id === nextTask.id) + 1;
    logBanner(`任务 ${idx}/${total}: ${nextTask.desc}`);
    logPrompt(nextTask.prompt || nextTask.desc || '');

    const result = await executeTask(nextTask.prompt || nextTask.desc || '', nextTask.id, projectRoot);
    currentState = loadState(projectRoot);

    if (result === 'timeout') {
      consecutiveTimeouts++;
      const taskStillPending = findNextTask(currentState);
      if (taskStillPending && taskStillPending.id === nextTask.id) {
        logStep('', 'warn', `任务 ${nextTask.id} 仍为 pending，即将重试`);
        if (consecutiveTimeouts >= 2) {
          logStep('', 'error', `连续 ${consecutiveTimeouts} 次超时，跳过任务 ${nextTask.id}（需人工介入）`);
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
 * 发送 prompt 到 Session Server → 等待就绪 → 确认任务完成 → 收尾
 * @returns {'ok' | 'timeout'}
 */
async function executeTask(prompt, taskId, projectRoot) {
  const sendResp = await httpPostJson(`http://127.0.0.1:${SERVER_PORT}/send`, { text: prompt });
  if (!sendResp?.ok) { logStep('', 'error', `/send 失败: ${sendResp?.error || 'unknown'}`); return 'timeout'; }

  const spin = createSpinner('executing...');
  try {
    await waitForReady({ onDecision: handleDecision });
    await waitForReady({ onDecision: handleDecision });

    if (taskId) await ensureTaskDone(taskId, projectRoot);

    spin.stop();
    console.log(`     ${GREEN}✔ done${RESET}`);
    return 'ok';
  } catch (err) {
    spin.stop();
    if (taskId && checkTaskDone(taskId, projectRoot)) {
      logStep('', 'warn', `超时但任务 ${taskId} 已完成（Stop hook 未触发）`);
      return 'ok';
    }
    logStep('', 'error', `超时: ${err.message}`);
    return 'timeout';
  }
}

/** 如果任务未标记 done，补发收尾 prompt 强制标记 */
async function ensureTaskDone(taskId, projectRoot) {
  if (checkTaskDone(taskId, projectRoot)) return;
  logStep('', 'warn', `任务 ${taskId} 未标记 done，补发收尾 prompt`);

  const wrapup = `用 awf_task_status 标记 ${taskId} done。用 awf_task_result 记录 ${taskId} 的执行结果。只做这两步。`;
  await httpPostJson(`http://127.0.0.1:${SERVER_PORT}/send`, { text: wrapup });
  await waitForReady({ onDecision: handleDecision });

  if (checkTaskDone(taskId, projectRoot)) { logStep('', 'ok', `收尾 prompt 已生效`); }
  else { logStep('', 'warn', `收尾 prompt 未生效，任务 ${taskId} 仍为 pending`); }
}

/** 从 state.json 中检查指定任务是否已标记 done */
function checkTaskDone(taskId, projectRoot) {
  const state = loadState(projectRoot);
  const tasks = state?.plan?.tasks || state?.tasks || [];
  return tasks.find(t => t.id === taskId)?.status === 'done';
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

/** 截断显示 prompt 首行 + 总字符数 */
function logPrompt(prompt) {
  const MAX = 120;
  const firstLine = prompt.split('\n')[0];
  if (firstLine.length <= MAX) console.log(`     ${DIM}prompt${RESET}  ${firstLine}`);
  else console.log(`     ${DIM}prompt${RESET}  ${firstLine.slice(0, MAX)}...`);
  const total = prompt.length;
  if (total > firstLine.length) console.log(`     ${DIM}(${total.toLocaleString()} chars)${RESET}`);
}

/** 打印任务分隔横幅 */
function logBanner(text) { console.log(`${CYAN}  ── ${text} ──${RESET}`); }
