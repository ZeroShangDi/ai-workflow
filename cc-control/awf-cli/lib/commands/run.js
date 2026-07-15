import { spawn, execSync } from 'child_process';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { getPaths } from '../utils/paths.js';
import { logger } from '../utils/logger.js';
import { loadState, findNextTask } from '../utils/state.js';

const SERVER_PORT = 8787;
const POLL_INTERVAL = 2000;
const READY_TIMEOUT = 300000;

const CHAIN = ['DEV', 'REVIEW', 'TEST', 'COMMIT'];

/**
 * awf run — 自治工作流编排服务
 *
 * Two invocation modes:
 *   Session (tmux-http)  — 持久多轮，执行开发/审查/测试/提交
 *   One-shot (claude -p) — 单次无状态，只为当前阶段生成提示词
 *
 * PLAN/DESIGN 在 run 之外由人工完成。
 */
export async function runCommand(task, options) {
  const { auto } = options;
  const paths = getPaths();
  const projectRoot = process.cwd();

  const state = loadState(projectRoot);
  if (!state) {
    logger.error('未找到 .awf/state.json，请先执行 awf plan');
    process.exit(1);
  }

  logger.info(`工作流: ${state.plan?.summary || task || '(resume)'}`);

  await ensureServer(paths);
  await ensureSession(paths);

  // 注入系统提示词（第一条消息）
  await injectSystemPrompt(paths, projectRoot);

  let currentState = loadState(projectRoot);
  while (currentState && currentState.currentState !== 'FINISH') {
    const nextTask = findNextTask(currentState);

    if (!nextTask) {
      logger.info('所有任务完成，进入 FINISH');
      await executePhase('FINISH', { task: { id: '-', desc: '收尾', prompt: '' } }, projectRoot, paths);
      break;
    }

    logger.info(`任务 [${nextTask.id}] ${nextTask.desc}`);

    for (const phase of CHAIN) {
      await executePhase(phase, { task: nextTask }, projectRoot, paths);

      const updated = loadState(projectRoot);
      if (updated?.currentState === 'DEBUG') {
        logger.warn('DEBUG 中断');
        await executePhase('DEBUG', {
          task: nextTask,
          fromPhase: phase,
          error: { description: '上一阶段触发错误' },
        }, projectRoot, paths);
        break; // DEBUG 完后回到 CHAIN 开头重新走
      }
    }

    currentState = loadState(projectRoot);
  }

  logger.success('工作流结束');
}

// === 阶段执行 ===

async function executePhase(phase, ctx, projectRoot, paths) {
  // 1. 主路径：POST /oneshot 调用 /w-prompt 智能生成
  let prompt = null;
  if (ctx.task?.id && ctx.task.id !== '-') {
    let instruction = `/w-prompt ${phase} ${ctx.task.id}`;
    if (ctx.fromPhase) instruction += ` --from ${ctx.fromPhase}`;
    if (ctx.error?.description) instruction += ` --error "${ctx.error.description}"`;

    const result = await httpPostJson(`http://127.0.0.1:${SERVER_PORT}/oneshot`, {
      prompt: instruction,
      cwd: projectRoot,
    });
    if (result?.ok && result.text) {
      prompt = result.text;
    }
  }

  // 2. 兜底：本地模板填充
  if (!prompt) {
    prompt = buildLocalPrompt(phase, ctx, paths);
  }

  logger.info(`  [${phase}] → ${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}`);

  // 3. 推入 tmux session 执行
  await httpPost(`http://127.0.0.1:${SERVER_PORT}/send`, { text: prompt });
  await waitForReady();
}

// === 提示词：本地模板回退 ===

function buildLocalPrompt(phase, ctx, paths) {
  const file = path.join(paths.prompts, `${phase.toLowerCase()}.md`);
  if (!fs.existsSync(file)) return `/${phase.toLowerCase()}`;

  let template = fs.readFileSync(file, 'utf-8').trim();
  const t = ctx.task || {};
  return template
    .replace(/\{\{task\.id\}\}/g, t.id || '')
    .replace(/\{\{task\.desc\}\}/g, t.desc || '')
    .replace(/\{\{task\.prompt\}\}/g, t.prompt || '')
    .replace(/\{\{task\.wbsRef\}\}/g, t.wbsRef || '')
    .replace(/\{\{fromPhase\}\}/g, ctx.fromPhase || '')
    .replace(/\{\{error\.description\}\}/g, ctx.error?.description || '');
}

// === 系统提示词 ===

async function injectSystemPrompt(paths, projectRoot) {
  const systemFile = path.join(paths.prompts, 'state-machine.md');
  if (!fs.existsSync(systemFile)) return;

  const systemPrompt = fs.readFileSync(systemFile, 'utf-8').trim();
  logger.info('注入系统提示词...');

  await httpPost(`http://127.0.0.1:${SERVER_PORT}/send`, { text: systemPrompt });
  await waitForReady();
}

// === tmux-http 通信 ===

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

// === 环境管理 ===

async function ensureServer(paths) {
  if (await checkServer()) { logger.info('tmux-http 已运行'); return; }

  logger.info('启动 tmux-http ...');
  const proc = spawn('node', [paths.tmuxServer], {
    stdio: 'ignore', detached: true,
    cwd: paths.tmuxHttp,
    env: { ...process.env, CC_PORT: String(SERVER_PORT) },
  });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (await checkServer()) { logger.success('tmux-http 已启动'); return; }
  }
  throw new Error('tmux-http 启动超时');
}

async function ensureSession(paths) {
  const bootstrap = path.join(paths.tmuxHttp, 'bootstrap.sh');
  const sessionName = process.env.CC_SESSION || 'cc';

  try {
    execSync(`tmux has-session -t ${sessionName} 2>/dev/null`, { stdio: 'ignore' });
    logger.info(`tmux session '${sessionName}' 已存在`);
    return;
  } catch { /* create */ }

  logger.info('创建 tmux session...');
  execSync(`bash "${bootstrap}"`, { stdio: 'inherit', cwd: process.cwd() });
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
