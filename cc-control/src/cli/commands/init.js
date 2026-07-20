import { exec } from 'node:child_process';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getPaths } from '../utils/paths.js';

const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const LABEL_W = 16;

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

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

function execAsync(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, opts, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

/**
 * awf init — 初始化项目工作流环境
 */
export async function initCommand(options) {
  const { force } = options;
  const paths = getPaths();

  console.log(`${CYAN}⚡ AI Workflow 初始化${RESET}\n`);

  // ── 1. 前置依赖检查 ──
  logSection('检查前置依赖');
  const depResults = checkPrerequisites();
  for (const r of depResults) {
    logStep(r.label, r.status, r.msg);
  }
  if (depResults.some((r) => r.status === 'error')) {
    console.log(`\n${RED}  缺少必要依赖，请安装后再 awf init${RESET}\n`);
    process.exit(1);
  }

  // ── 2. 安装插件 ──
  logSection('安装插件');
  const extraPlugins = await loadExtraPlugins(paths);
  await installAllPlugins(paths, extraPlugins);

  // ── 3. 初始化项目 ──
  logSection('初始化项目');
  await initWorkspace(paths, force);

  // ── 4. Claude Code 项目初始化 ──
  // TODO: claude -p "/init" 在非交互模式下无法正确触发 skill，待修复
  // logSection('初始化 Claude Code 上下文');
  // await initClaudeProject();

  // ── 引导 ──
  console.log('');
  console.log(`${CYAN}  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`${CYAN}  ✔ 初始化完成${RESET}`);
  console.log(`${CYAN}  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log('');
  console.log('  ▸ awf plan "你的需求描述"    开始规划');
  console.log('  ▸ awf run                     启动工作流');
  console.log('');
}

function checkPrerequisites() {
  const results = [];

  try {
    execSync('command -v tmux', { stdio: 'ignore' });
    results.push({ label: 'tmux', status: 'ok', msg: '已安装' });
  } catch {
    results.push({ label: 'tmux', status: 'warn', msg: '未安装 — brew install tmux' });
  }

  try {
    execSync('command -v claude', { stdio: 'ignore' });
    results.push({ label: 'claude', status: 'ok', msg: '已安装' });
  } catch {
    results.push({ label: 'claude', status: 'error', msg: '未安装 — npm install -g @anthropic-ai/claude-code' });
  }

  return results;
}

async function loadExtraPlugins(paths) {
  const configPath = path.join(paths.projectRoot, '.awf-plugins.json');
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(raw);
    return config.plugins || [];
  } catch {
    return [];
  }
}

async function installAllPlugins(paths, extraPlugins) {
  const sourceDir = paths.projectRoot;
  const installedJson = path.join(paths.claudePlugins, 'installed_plugins.json');

  // 清理旧版 symlink 残留
  const oldSymlink = `${paths.claudePlugins}/ai-workflow`;
  const oldLink = await fs.lstat(oldSymlink).catch(() => null);
  if (oldLink?.isSymbolicLink()) {
    await fs.unlink(oldSymlink);
  }

  // 检查插件是否已安装
  const isInstalled = (spec) => {
    try {
      const raw = execSync(`cat "${installedJson}"`, { stdio: 'pipe' }).toString();
      const data = JSON.parse(raw);
      return !!data.plugins?.[spec];
    } catch {
      return false;
    }
  };

  // 注册本地 marketplace（幂等）
  try {
    execSync(`claude plugin marketplace add "${sourceDir}"`, { stdio: 'pipe' });
  } catch {}

  // 合并默认插件 + 配置文件中的额外插件
  const plugins = ['ai-workflow@ai-workflow-dev', ...extraPlugins];

  for (const spec of plugins) {
    const label = spec.split('@')[0];

    if (isInstalled(spec)) {
      logStep(label, 'skip', '已安装');
      continue;
    }

    const spin = createSpinner(`installing ${spec} ...`);
    try {
      await execAsync(`claude plugin install ${spec}`);
      spin.stop();
      logStep(label, 'ok', '已安装');
    } catch (err) {
      spin.stop();
      logStep(label, 'error', `安装失败 — ${err.message}`);
    }
  }
}

async function initWorkspace(paths, force) {
  const awfDir = path.join(process.cwd(), '.awf');
  const exists = await fs.stat(awfDir).catch(() => null);

  if (exists && !force) {
    logStep('.awf/', 'warn', '已存在，使用 --force 覆盖');
    return;
  }

  if (exists) {
    await fs.rm(awfDir, { recursive: true, force: true });
  }
  await fs.mkdir(awfDir, { recursive: true });

  const stateJson = {
    currentState: 'IDLE',
    version: '0.1.0',
    milestones: [],
    tasks: [],
    wbs: null,
    lastUpdated: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(awfDir, 'state.json'),
    JSON.stringify(stateJson, null, 2),
  );
  logStep('.awf/', 'ok', '已创建');
}

async function initClaudeProject() {
  const spin = createSpinner('正在执行 /init ...');
  try {
    await execAsync('claude -p "/init"', {
      cwd: process.cwd(),
      timeout: 300000, // 5 min
    });
    spin.stop();
    logStep('/init', 'ok', '项目上下文已初始化');
  } catch (err) {
    spin.stop();
    logStep('/init', 'warn', `初始化失败: ${err.message}`);
  }
}
