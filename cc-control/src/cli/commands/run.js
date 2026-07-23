import { spawn, execSync } from 'child_process';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { getPaths, pluginCmd } from '../utils/paths.js';
import { loadState, findNextTask } from '../utils/state.js';

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

const CHAIN = ['DEV', 'REVIEW', 'TEST', 'COMMIT'];

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

let useLocal = false;

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

function logPhase(phase) {
  // TODO: token 用量统计 — 当前无法从 tmux session 中提取 API token 消耗
  const tokenInfo = `${DIM}tokens  —${RESET}`;
  const phasePad = Math.max(2, 28 - phase.length);
  console.log(`  ${CYAN}▸ ${phase}${RESET}${' '.repeat(phasePad)}${tokenInfo}`);
}

function logBanner(text) {
  console.log(`${CYAN}  ── ${text} ──${RESET}`);
}

// ── 主命令 ──

/**
 * awf run — 自治工作流编排
 */
export async function runCommand(task, options) {
  const { auto, local } = options;
  useLocal = !!local;
  const paths = getPaths();
  const projectRoot = process.cwd();

  const state = loadState(projectRoot);
  if (!state) {
    console.log(`${RED}  未找到 .awf/state.json，请先执行 awf plan${RESET}\n`);
    process.exit(1);
  }

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
  await ensureServer(paths, projectRoot);
  await ensureSession(paths);

  // dashboard
  spawn('open', [`http://localhost:${SERVER_PORT}`], { stdio: 'ignore', detached: true }).unref();
  logStep('dashboard', 'ok', `http://localhost:${SERVER_PORT}`);

  console.log('');

  try {
    await runLoop(projectRoot, paths, task);
  } finally {
    doCleanup();
  }
}

// ── 任务循环 ──

async function runLoop(projectRoot, paths, task) {
  let currentState = loadState(projectRoot);
  const allTasks = currentState?.plan?.tasks || [];
  const total = allTasks.length;

  while (currentState && currentState.currentState !== 'FINISH') {
    const nextTask = findNextTask(currentState);

    if (!nextTask) {
      console.log(`${DIM}  所有任务完成，进入 FINISH${RESET}`);
      await executePhase('FINISH', { task: { id: '-', desc: '收尾', prompt: '' } }, projectRoot, paths);
      break;
    }

    const idx = allTasks.findIndex(t => t.id === nextTask.id) + 1;
    logBanner(`任务 ${idx}/${total}: ${nextTask.desc}`);

    for (const phase of CHAIN) {
      await executePhase(phase, { task: nextTask }, projectRoot, paths);

      const updated = loadState(projectRoot);
      if (updated?.currentState === 'DEBUG') {
        logStep('status', 'warn', '进入 DEBUG');
        await executePhase('DEBUG', {
          task: nextTask,
          fromPhase: phase,
          error: { description: '上一阶段触发错误' },
        }, projectRoot, paths);
        break;
      }
    }

    currentState = loadState(projectRoot);
  }

  console.log('');
  console.log(`${GREEN}  ✔ 工作流结束${RESET}\n`);
}

// ── 阶段执行 ──

async function executePhase(phase, ctx, projectRoot, paths) {
  // 1. 获取提示词
  let prompt = null;
  if (!useLocal && ctx.task?.id && ctx.task.id !== '-') {
    let instruction = `${pluginCmd('w-prompt')} ${phase} ${ctx.task.id}`;
    if (ctx.fromPhase) instruction += ` --from ${ctx.fromPhase}`;
    if (ctx.error?.description) instruction += ` --error "${ctx.error.description}"`;

    // 直接 spawn claude -p，不再依赖 HTTP /oneshot 端点
    const result = await spawnClaudeOneShot(instruction, projectRoot);
    if (result?.ok && result.text) {
      prompt = result.text;
    }
  }

  // 2. 兜底 / --local
  if (!prompt) {
    prompt = buildLocalPrompt(phase, ctx, paths);
  }

  // 3. 显示阶段、prompt、token 占位
  logPhase(phase);
  logPrompt(prompt);

  // 4. 推入 tmux 执行
  await httpPost(`http://127.0.0.1:${SERVER_PORT}/send`, { text: prompt });

  const spin = createSpinner('executing...');
  try {
    await waitForReady();
    spin.stop();
    console.log(`     ${GREEN}✔ done${RESET}`);
  } catch (err) {
    spin.stop();
    logStep('', 'error', `超时: ${err.message}`);
  }
}

// ── 提示词：本地模板回退 ──

function buildLocalPrompt(phase, ctx, paths) {
  const file = path.join(paths.prompts, `${phase.toLowerCase()}.md`);
  if (!fs.existsSync(file)) return `/${phase.toLowerCase()}`;

  let template = fs.readFileSync(file, 'utf-8').trim();
  const t = ctx.task || {};
  const body = template
    .replace(/\{\{task\.id\}\}/g, t.id || '')
    .replace(/\{\{task\.desc\}\}/g, t.desc || '')
    .replace(/\{\{task\.prompt\}\}/g, t.prompt || '')
    .replace(/\{\{task\.wbsRef\}\}/g, t.wbsRef || '')
    .replace(/\{\{fromPhase\}\}/g, ctx.fromPhase || '')
    .replace(/\{\{error\.description\}\}/g, ctx.error?.description || '');

  const tag = t.id ? `[awf ${phase} task ${t.id}]` : `[awf ${phase}]`;
  return `${body}\n${tag} 只做这一步，完成后等待下一步指令。`;
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

async function waitForReady() {
  const start = Date.now();
  while (Date.now() - start < READY_TIMEOUT) {
    if (await checkServer()) return;
    await sleep(POLL_INTERVAL);
  }
  throw new Error('等待 Claude Code 就绪超时');
}

// ── 环境管理 ──

async function ensureServer(paths, projectRoot) {
  if (await checkServer()) {
    logStep('tmux-http', 'skip', '已运行');
    return;
  }

  const spin = createSpinner('starting tmux-http ...');
  const proc = spawn('node', [paths.tmuxServer], {
    stdio: 'ignore', detached: true,
    cwd: paths.projectRoot,
    env: { ...process.env, CC_PORT: String(SERVER_PORT), CC_PROJECT: projectRoot },
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

async function ensureSession(paths) {
  const sessionName = process.env.CC_SESSION || 'cc';

  try {
    execSync(`tmux kill-session -t ${sessionName} 2>/dev/null`, { stdio: 'ignore' });
  } catch {}

  execSync(`bash "${paths.bootstrapScript}"`, { stdio: 'ignore', cwd: process.cwd() });
  logStep('session', 'ok', `${sessionName} → sandbox`);
}

async function checkServer() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${SERVER_PORT}/status`, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data).state === 'ready'); }
        catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── One-shot: 直接 spawn claude -p（不再走 HTTP） ──

function spawnClaudeOneShot(prompt, cwd) {
  return new Promise((resolve) => {
    const proc = spawn('claude', ['-p', prompt], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    let output = '';
    proc.stdout.on('data', (c) => (output += c.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve({ ok: true, text: output.trim() });
      else resolve({ ok: false, error: `claude -p exited ${code}`, text: output.trim() || null });
    });
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}
