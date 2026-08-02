import { exec } from 'node:child_process';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getPaths } from './paths.js';
import { promptVersion } from './version-prompt.js';

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

  // ── 0. 版本确认 ──
  const version = await promptVersion(process.cwd());

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
  await initWorkspace(paths, force, version);

  // ── 4. Claude Code 项目初始化 ──
  logSection('初始化 CLAUDE.md');
  await initClaudeMd(paths.projectRoot, process.cwd());

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
  const pluginDir = path.join(paths.projectRoot, 'plugin');
  const installedJson = path.join(paths.claudePlugins, 'installed_plugins.json');
  const symlinkPath = path.join(paths.claudePlugins, 'ai-workflow');

  // 检查 symlink 是否有效（目标目录含 plugin.json）
  let symlinkValid = false;
  try {
    const target = await fs.readlink(symlinkPath);
    await fs.stat(path.join(target, 'plugin.json'));
    symlinkValid = true;
  } catch {}

  // 清理旧版 symlink（指向项目根目录、不含 plugin.json 的残留）
  if (!symlinkValid) {
    await fs.unlink(symlinkPath).catch(() => {});
  }

  // 清理旧的 marketplace 注册（目录变更后可能残留指向根目录的旧注册）
  try {
    execSync(`claude plugin marketplace remove "${paths.projectRoot}"`, { stdio: 'pipe' });
  } catch {}

  // 检查插件是否已安装
  const isInstalled = (spec) => {
    return symlinkValid && (() => {
      try {
        const raw = execSync(`cat "${installedJson}"`, { stdio: 'pipe' }).toString();
        const data = JSON.parse(raw);
        return !!data.plugins?.[spec];
      } catch {
        return false;
      }
    })();
  };

  // 注册本地 marketplace（幂等），指向含 plugin.json 的 plugin/ 目录
  try {
    execSync(`claude plugin marketplace add "${pluginDir}"`, { stdio: 'pipe' });
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

async function initWorkspace(paths, force, version) {
  const awfDir = path.join(process.cwd(), '.awf');
  const templateDir = path.join(paths.projectRoot, 'src', 'templates', 'awf');
  const exists = await fs.stat(awfDir).catch(() => null);

  if (!exists) {
    // 首次创建 → 从模板全量复制
    try {
      await fs.cp(templateDir, awfDir, { recursive: true });
      await copyStateTemplate(paths, awfDir);
      await replaceVersion(awfDir, version);
    } catch {
      await fs.mkdir(awfDir, { recursive: true });
      logStep('.awf/', 'warn', '模板缺失，已创建空目录');
      return;
    }
    logStep('.awf/', 'ok', '已创建');
    return;
  }

  if (!force) {
    logStep('.awf/', 'warn', '已存在，使用 --force 补全缺失文件');
    return;
  }

  // --force：只补缺失，已有文件不动
  await mergeMissing(templateDir, awfDir);
  await copyStateTemplate(paths, awfDir);
  await replaceVersion(awfDir, version);
  logStep('.awf/', 'ok', '已补全缺失文件');
}

async function mergeMissing(src, dest) {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const srcPath = path.join(src, e.name);
    const destPath = path.join(dest, e.name);
    const destExists = await fs.stat(destPath).catch(() => null);

    if (e.isDirectory()) {
      if (!destExists) {
        await fs.mkdir(destPath, { recursive: true });
      }
      await mergeMissing(srcPath, destPath);
    } else {
      if (!destExists) {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }
}

async function copyStateTemplate(paths, awfDir) {
  const src = path.join(paths.projectRoot, 'src', 'mcp', 'awf-state', 'state.template.json');
  const dest = path.join(awfDir, 'state.json');
  if (await fs.stat(dest).catch(() => null)) return; // 已有则跳过
  try {
    await fs.copyFile(src, dest);
    await replaceTimestamp(dest);
  } catch {}
}

async function replaceTimestamp(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    await fs.writeFile(filePath, raw.replace('{{TIMESTAMP}}', new Date().toISOString()));
  } catch {}
}

async function replaceVersion(awfDir, version) {
  if (!version) return;
  try {
    await replaceInDir(awfDir, version);
  } catch {}
}

async function replaceInDir(dir, version) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await replaceInDir(full, version);
    } else {
      try {
        const raw = await fs.readFile(full, 'utf-8');
        if (raw.includes('{{VERSION}}')) {
          await fs.writeFile(full, raw.replace(/\{\{VERSION\}\}/g, version));
        }
      } catch {}
    }
  }
}

/**
 * 初始化项目 CLAUDE.md — 检查、注入 awf 规则
 */
async function initClaudeMd(projectRoot, cwd) {
  const templatePath = path.join(projectRoot, 'src', 'templates', 'CLAUDE.md.template');
  const claudeMdPath = path.join(cwd, 'CLAUDE.md');
  const markerStart = '<!-- awf-rules start -->';

  let awfRules;
  try {
    awfRules = await fs.readFile(templatePath, 'utf-8');
  } catch {
    logStep('CLAUDE.md', 'warn', '模板文件不存在，跳过注入');
    return;
  }

  const claudeMdExists = await fs.stat(claudeMdPath).catch(() => null);

  if (!claudeMdExists) {
    // 不存在 → 直接创建 awf 规则文件
    await fs.writeFile(claudeMdPath, awfRules);
    logStep('CLAUDE.md', 'ok', '已创建（含 awf 规则）');
  } else {
    // 存在 → 检查是否已有 awf 标记
    const content = await fs.readFile(claudeMdPath, 'utf-8');
    if (content.includes(markerStart)) {
      logStep('CLAUDE.md', 'skip', '已包含 awf 规则，跳过注入');
    } else {
      const separator = content.endsWith('\n') ? '\n' : '\n\n';
      await fs.writeFile(claudeMdPath, content + separator + awfRules);
      logStep('CLAUDE.md', 'ok', '已注入 awf 规则');
    }
  }
}
