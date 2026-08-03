import { spawn, execSync } from 'child_process';
import http from 'http';
import { getPaths } from './paths.js';
import { loadState, findNextTask } from './state.js';
import { autoSelect } from './auto-selector.js';
import { createRunLog } from './utils/log-writer.cjs';

const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const LABEL_W = 18;

const SERVER_PORT = 8787;
const POLL_INTERVAL = 2000;
const READY_TIMEOUT = 300000;

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const seenAnswers = new Set();

// ── 输出辅助 ──

function logSection(title) {
  console.log(`${DIM}  ▸ ${title}${RESET}`);
}

function logStep(label, status, msg) {
  const prefix = `     ${DIM}${label.padEnd(LABEL_W)}${RESET}`;
  switch (status) {
    case 'ok':
      console.log(`${prefix}${GREEN}✔ ${msg}${RESET}`);
      break;
    case 'warn':
      console.log(`${prefix}${YELLOW}⚠ ${msg}${RESET}`);
      break;
    case 'skip':
      console.log(`${prefix}${DIM}• ${msg}${RESET}`);
      break;
    case 'error':
      console.log(`${prefix}${RED}✘ ${msg}${RESET}`);
      break;
  }
}

function createSpinner(label) {
  let i = 0;
  let active = true;
  const timer = setInterval(() => {
    if (active) {
      process.stdout.write(
        `\r     ${DIM}${SPINNER[i++ % SPINNER.length]} ${label}${RESET}`,
      );
    }
  }, 80);
  return {
    stop() {
      active = false;
      clearInterval(timer);
      process.stdout.write('\r\x1b[K');
    },
  };
}

function logPrompt(prompt) {
  const MAX = 120;
  const firstLine = prompt.split('\n')[0];
  if (firstLine.length <= MAX) {
    console.log(`     ${DIM}prompt${RESET}  ${firstLine}`);
  } else {
    console.log(`     ${DIM}prompt${RESET}  ${firstLine.slice(0, MAX)}...`);
  }
  const total = prompt.length;
  if (total > firstLine.length) {
    console.log(`     ${DIM}(${total.toLocaleString()} chars)${RESET}`);
  }
}

function logBanner(text) {
  console.log(`${CYAN}  ── ${text} ──${RESET}`);
}

// ── 主命令 ──

export async function runCommand(task, options) {
  const paths = getPaths();
  const projectRoot = process.cwd();

  const state = loadState(projectRoot);
  if (!state) {
    console.log(`${RED}  未找到 .awf/state.json，请先执行 awf plan${RESET}\n`);
    process.exit(1);
  }

  const version = state.version || 'unknown';
  const logPath = createRunLog(projectRoot, version);
  logStep('log', 'ok', logPath);

  // Ctrl-C 清理
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

  // ── 1. 启动环境 ──
  logSection('启动环境');
  await ensureServer(paths, projectRoot, logPath);
  await ensureSession(paths, projectRoot);

  spawn('open', [`http://localhost:${SERVER_PORT}`], { stdio: 'ignore', detached: true }).unref();
  logStep('dashboard', 'ok', `http://localhost:${SERVER_PORT}`);

  console.log('');

  try {
    await runLoop(projectRoot);
  } finally {
    doCleanup();
  }
}

// ── 任务循环 ──

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

    const prompt = nextTask.prompt || nextTask.desc || '';
    logPrompt(prompt);

    const result = await executeTask(prompt, nextTask.id);

    // 重新读取 state，检查任务是否已被标记完成
    currentState = loadState(projectRoot);

    if (result === 'timeout') {
      consecutiveTimeouts++;
      // 检查重读后的 state 中该任务是否已完成
      const taskStillPending = findNextTask(currentState);
      if (taskStillPending && taskStillPending.id === nextTask.id) {
        logStep('', 'warn', `任务 ${nextTask.id} 仍为 pending，即将重试`);
        if (consecutiveTimeouts >= 2) {
          logStep('', 'error', `连续 ${consecutiveTimeouts} 次超时，跳过任务 ${nextTask.id}（需人工介入）`);
          // 标记为 blocked 避免死循环
          consecutiveTimeouts = 0;
          continue;
        }
      } else {
        // 任务已完成（可能是回查发现 done，或 Stop hook 延迟触发）
        consecutiveTimeouts = 0;
      }
    } else {
      consecutiveTimeouts = 0;
    }
  }

  console.log('');
  console.log(`${GREEN}  ✔ 工作流结束${RESET}\n`);
}

// ── 单任务执行 ──

async function executeTask(prompt, taskId) {
  await httpPost(`http://127.0.0.1:${SERVER_PORT}/send`, { text: prompt });

  const spin = createSpinner('executing...');
  try {
    await waitForReady();
    if (taskId) {
      const taskDone = await waitForTaskDone(taskId);
      if (!taskDone) logStep('', 'warn', `任务 ${taskId} 未在 state.json 中标记 done`);
    }
    // 等待 auto-continue 完成（CC 可能在 Stop 后自动调用 MCP tools）
    await waitForReady();
    spin.stop();
    console.log(`     ${GREEN}✔ done${RESET}`);
    return 'ok';
  } catch (err) {
    spin.stop();
    // 超时后回查 state：任务可能已完成但 Stop hook 未触发（如 AI 长时间诊断）
    if (taskId) {
      const taskDone = await checkTaskDone(taskId);
      if (taskDone) {
        logStep('', 'warn', `超时但任务 ${taskId} 已完成（Stop hook 未触发）`);
        return 'ok';
      }
    }
    logStep('', 'error', `超时: ${err.message}`);
    return 'timeout';
  }
}

async function checkTaskDone(taskId) {
  const state = loadState(process.cwd());
  const tasks = state?.plan?.tasks || state?.tasks || [];
  const task = tasks.find(t => t.id === taskId);
  return task?.status === 'done';
}

async function waitForTaskDone(taskId) {
  const start = Date.now();
  while (Date.now() - start < 60000) {
    const state = loadState(process.cwd());
    const tasks = state?.plan?.tasks || state?.tasks || [];
    const task = tasks.find(t => t.id === taskId);
    if (task?.status === 'done') return true;
    await sleep(POLL_INTERVAL);
  }
  return false;
}

// ── tmux-http 通信 ──

async function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: READY_TIMEOUT,
    }, (res) => {
      let resp = '';
      res.on('data', (c) => (resp += c));
      res.on('end', () => resolve(resp));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function httpPostJson(url, body) {
  const raw = await httpPost(url, body);
  try { return JSON.parse(raw); } catch { return null; }
}

async function getStatus() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${SERVER_PORT}/status`, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

async function handleDecision(d) {
  if (d.source === 'AskUserQuestion') {
    if (d.answered) {
      if (!seenAnswers.has(d.question)) {
        console.log(`     ${GREEN}✔ 已选择: ${d.answer}${RESET}`);
        seenAnswers.add(d.question);
      }
      return;
    }
    console.log(`\n${YELLOW}  ⚡ AI 提问:${RESET} ${CYAN}${d.question}${RESET}${d.multiSelect ? ` ${DIM}(多选)${RESET}` : ''}`);
    if (d.options?.length) d.options.forEach((o, i) => console.log(`     ${DIM}${i + 1}.${RESET} ${o}`));
    const sel = await autoSelect(d);
    if (sel) {
      if (sel.multiSelect) {
        await httpPost(`http://127.0.0.1:${SERVER_PORT}/respond`, { value: sel.selected.join(',') });
      } else if (sel.index > 0) {
        await httpPost(`http://127.0.0.1:${SERVER_PORT}/respond`, { value: String(sel.index) });
      } else if (sel.customInput) {
        await httpPost(`http://127.0.0.1:${SERVER_PORT}/respond`, { value: sel.customInput });
      }

    }
    return;
  }

  console.log(`\n${YELLOW}  ⚡ AI 需要决策...${RESET}`);
  const { createInterface } = await import('readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  if (d.type === 'choice') {
    console.log(`  ${CYAN}${d.question}${RESET}`);
    d.options.forEach((o, i) => console.log(`     ${DIM}${i + 1}.${RESET} ${o}`));
    const answer = await new Promise((resolve) => {
      rl.question(`  ${DIM}选择 (1-${d.options.length}): ${RESET}`, (a) => {
        rl.close();
        resolve(a.trim());
      });
    });
    const idx = parseInt(answer, 10) - 1;
    const value = d.options[idx] || answer;
    await httpPost(`http://127.0.0.1:${SERVER_PORT}/respond`, JSON.stringify({ value }));
    console.log(`     ${GREEN}✔ 已选择: ${value}${RESET}\n`);
    appendLog(currentLogPath, { type: 'CHOICE', question: d.question, answer: value });
    return;
  }

  console.log(`  ${CYAN}${d.question}${RESET}`);
  const answer = await new Promise((resolve) => {
    rl.question(`  ${DIM}输入: ${RESET}`, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
  if (answer) {
    await httpPost(`http://127.0.0.1:${SERVER_PORT}/respond`, JSON.stringify({ value: answer }));
    console.log(`     ${GREEN}✔ 已发送${RESET}\n`);
    appendLog(currentLogPath, { type: 'CHOICE', question: d.question, answer });
  }
}

async function waitForReady() {
  const start = Date.now();
  let lastDecision = null;
  while (Date.now() - start < READY_TIMEOUT) {
    const status = await getStatus();
    if (status.decisionPending) {
      const key = JSON.stringify(status.decisionPending);
      if (key !== lastDecision) {
        await handleDecision(status.decisionPending);
        lastDecision = key;
      }
      await sleep(POLL_INTERVAL);
      continue;
    }
    if (status?.state === 'ready') {
      return;
    }
    await sleep(POLL_INTERVAL);
  }
  throw new Error('等待 Claude Code 就绪超时');
}

async function checkServer() {
  const status = await getStatus();
  return status?.state === 'ready';
}

// ── 环境管理 ──

async function ensureServer(paths, projectRoot, logPath) {
  try { execSync(`lsof -ti:${SERVER_PORT} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' }); } catch {}
  await sleep(300);

  const spin = createSpinner('starting tmux-http ...');
  const proc = spawn('node', [paths.tmuxServer], {
    stdio: 'ignore', detached: true,
    cwd: paths.projectRoot,
    env: { ...process.env, CC_PORT: String(SERVER_PORT), CC_PROJECT: projectRoot, AWF_LOG_PATH: logPath || '' },
  });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (await checkServer()) {
      spin.stop();
      logStep('tmux-http', 'ok', '已启动');
      return;
    }
  }
  spin.stop();
  throw new Error('tmux-http 启动超时');
}

async function ensureSession(paths, projectRoot) {
  const sessionName = process.env.CC_SESSION || 'cc';

  try {
    execSync(`tmux kill-session -t ${sessionName} 2>/dev/null`, { stdio: 'ignore' });
  } catch {}

  execSync(`bash "${paths.bootstrapScript}"`, {
    stdio: 'ignore',
    cwd: projectRoot,
    env: { ...process.env, CC_WORKDIR: projectRoot },
  });
  logStep('session', 'ok', `${sessionName} → ${projectRoot}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
