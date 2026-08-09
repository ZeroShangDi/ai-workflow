import { exec } from 'node:child_process';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getPaths } from '../lib/paths.js';
import { promptVersion } from '../lib/version.js';
import { CYAN, RED, RESET } from '../lib/ui/colors.js';
import { createSpinner } from '../lib/ui/spinner.js';
import { logSection, logStep } from '../lib/ui/log.js';

/**
 * awf init — 初始化项目工作流环境
 *
 * 流程：
 *   0. 确认版本号
 *   1. 检查前置依赖（tmux、claude）
 *   2. 安装插件到 ~/.claude/plugins/
 *   3. 初始化 .awf/ 目录结构（从模板复制，--force 补缺失）
 *   4. 注入 awf 规则到 CLAUDE.md
 */
export async function initCommand(options) {
  const { force } = options;
  const paths = getPaths();

  console.log(`${CYAN}⚡ AI Workflow 初始化${RESET}\n`);

  // 0. 版本确认
  const version = await promptVersion(process.cwd());

  // 1. 前置依赖检查
  logSection('检查前置依赖');
  const depResults = checkPrerequisites();
  for (const r of depResults) logStep(r.label, r.status, r.msg);
  if (depResults.some((r) => r.status === 'error')) {
    console.log(`\n${RED}  缺少必要依赖，请安装后再 awf init${RESET}\n`);
    process.exit(1);
  }

  // 2. 安装插件
  logSection('安装插件');
  const extraPlugins = await loadExtraPlugins(paths);
  await installAllPlugins(paths, extraPlugins);

  // 3. 初始化项目
  logSection('初始化项目');
  await initWorkspace(paths, force, version);

  // 4. Claude Code 项目初始化
  logSection('初始化 CLAUDE.md');
  await initClaudeMd(paths.projectRoot, process.cwd());

  // 引导
  console.log('');
  console.log(`${CYAN}  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`${CYAN}  ✔ 初始化完成${RESET}`);
  console.log(`${CYAN}  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log('');
  console.log('  ▸ awf plan "你的需求描述"    开始规划');
  console.log('  ▸ awf run                     启动工作流');
  console.log('');
}

// ── 前置依赖检查 ──

/** 检查 tmux / claude 是否可用，返回检查结果列表 */
function checkPrerequisites() {
  const results = [];
  try { execSync('command -v tmux', { stdio: 'ignore' }); results.push({ label: 'tmux', status: 'ok', msg: '已安装' }); }
  catch { results.push({ label: 'tmux', status: 'warn', msg: '未安装 — brew install tmux' }); }
  try { execSync('command -v claude', { stdio: 'ignore' }); results.push({ label: 'claude', status: 'ok', msg: '已安装' }); }
  catch { results.push({ label: 'claude', status: 'error', msg: '未安装 — npm install -g @anthropic-ai/claude-code' }); }
  return results;
}

// ── 插件安装 ──

/** child_process.exec 的 Promise 包装 */
function execAsync(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, opts, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

/** 读取项目根目录的 .plugins.json，返回额外需安装的插件列表 */
async function loadExtraPlugins(paths) {
  const configPath = path.join(paths.projectRoot, '.plugins.json');
  try { const config = JSON.parse(await fs.readFile(configPath, 'utf-8')); return config.plugins || []; }
  catch { return []; }
}

/** 安装 ai-workflow-dev 及额外插件到 CC 全局插件目录 */
async function installAllPlugins(paths, extraPlugins) {
  const pluginDir = path.join(paths.projectRoot, 'plugin');
  const installedJson = path.join(paths.claudePlugins, 'installed_plugins.json');
  const symlinkPath = path.join(paths.claudePlugins, 'ai-workflow');

  let symlinkValid = false;
  try { const target = await fs.readlink(symlinkPath); await fs.stat(path.join(target, 'plugin.json')); symlinkValid = true; } catch {}
  if (!symlinkValid) await fs.unlink(symlinkPath).catch(() => {});
  try { execSync(`claude plugin marketplace remove "${paths.projectRoot}"`, { stdio: 'pipe' }); } catch {}

  const isInstalled = (spec) => symlinkValid && (() => {
    try { const raw = execSync(`cat "${installedJson}"`, { stdio: 'pipe' }).toString(); return !!JSON.parse(raw).plugins?.[spec]; }
    catch { return false; }
  })();

  try { execSync(`claude plugin marketplace add "${pluginDir}"`, { stdio: 'pipe' }); } catch {}
  const plugins = ['ai-workflow@ai-workflow-dev', ...extraPlugins];

  for (const spec of plugins) {
    const label = spec.split('@')[0];
    if (isInstalled(spec)) { logStep(label, 'skip', '已安装'); continue; }
    const spin = createSpinner(`installing ${spec} ...`);
    try { await execAsync(`claude plugin install ${spec}`); spin.stop(); logStep(label, 'ok', '已安装'); }
    catch (err) { spin.stop(); logStep(label, 'error', `安装失败 — ${err.message}`); }
  }
}

// ── 工作空间初始化 ──

/** 检查/创建 .awf/ 目录，从模板复制文件，--force 时补全缺失 */
async function initWorkspace(paths, force, version) {
  const awfDir = path.join(process.cwd(), '.awf');
  const templateDir = path.join(paths.projectRoot, 'src', 'templates', 'awf');
  const exists = await fs.stat(awfDir).catch(() => null);

  if (!exists) {
    try { await fs.cp(templateDir, awfDir, { recursive: true }); await copyStateTemplate(paths, awfDir); await replaceVersion(awfDir, version); }
    catch { await fs.mkdir(awfDir, { recursive: true }); logStep('.awf/', 'warn', '模板缺失，已创建空目录'); return; }
    logStep('.awf/', 'ok', '已创建'); return;
  }
  if (!force) { logStep('.awf/', 'warn', '已存在，使用 --force 补全缺失文件'); return; }

  await mergeMissing(templateDir, awfDir);
  await copyStateTemplate(paths, awfDir);
  await replaceVersion(awfDir, version);
  logStep('.awf/', 'ok', '已补全缺失文件');
}

/** 递归对比模板目录，只复制目标目录不存在的条目 */
async function mergeMissing(src, dest) {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const srcPath = path.join(src, e.name), destPath = path.join(dest, e.name);
    const destExists = await fs.stat(destPath).catch(() => null);
    if (e.isDirectory()) { if (!destExists) await fs.mkdir(destPath, { recursive: true }); await mergeMissing(srcPath, destPath); }
    else { if (!destExists) await fs.copyFile(srcPath, destPath); }
  }
}

/** 如果目标不存在，从 state.template.json 复制 */
async function copyStateTemplate(paths, awfDir) {
  const src = path.join(paths.projectRoot, 'src', 'mcp', 'awf-state', 'state.template.json');
  const dest = path.join(awfDir, 'state.json');
  if (await fs.stat(dest).catch(() => null)) return;
  try { await fs.copyFile(src, dest); await replaceTimestamp(dest); } catch {}
}

/** 替换文件中的 {{TIMESTAMP}} 占位符 */
async function replaceTimestamp(filePath) {
  try { const raw = await fs.readFile(filePath, 'utf-8'); await fs.writeFile(filePath, raw.replace('{{TIMESTAMP}}', new Date().toISOString())); } catch {}
}

/** 递归替换 .awf/ 目录中所有文件的 {{VERSION}} 占位符 */
async function replaceVersion(awfDir, version) {
  if (!version) return;
  try { await replaceInDir(awfDir, version); } catch {}
}

/** 递归遍历目录，替换所有文件中的 {{VERSION}} */
async function replaceInDir(dir, version) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { await replaceInDir(full, version); }
    else { try { const raw = await fs.readFile(full, 'utf-8'); if (raw.includes('{{VERSION}}')) await fs.writeFile(full, raw.replace(/\{\{VERSION\}\}/g, version)); } catch {} }
  }
}

// ── CLAUDE.md 初始化 ──

/**
 * 检查目标项目是否有 CLAUDE.md，注入 awf 规则段
 * - 不存在 → 从模板创建
 * - 存在但无 awf 规则 → 追加
 * - 已包含 awf 规则 → 跳过
 */
async function initClaudeMd(projectRoot, cwd) {
  const templatePath = path.join(projectRoot, 'src', 'templates', 'CLAUDE.md.template');
  const claudeMdPath = path.join(cwd, 'CLAUDE.md');
  const markerStart = '<!-- awf-rules start -->';

  let awfRules;
  try { awfRules = await fs.readFile(templatePath, 'utf-8'); }
  catch { logStep('CLAUDE.md', 'warn', '模板文件不存在，跳过注入'); return; }

  const claudeMdExists = await fs.stat(claudeMdPath).catch(() => null);
  if (!claudeMdExists) {
    await fs.writeFile(claudeMdPath, awfRules);
    logStep('CLAUDE.md', 'ok', '已创建（含 awf 规则）');
  } else {
    const content = await fs.readFile(claudeMdPath, 'utf-8');
    if (content.includes(markerStart)) { logStep('CLAUDE.md', 'skip', '已包含 awf 规则，跳过注入'); }
    else {
      const separator = content.endsWith('\n') ? '\n' : '\n\n';
      await fs.writeFile(claudeMdPath, content + separator + awfRules);
      logStep('CLAUDE.md', 'ok', '已注入 awf 规则');
    }
  }
}
