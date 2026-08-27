import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getPaths } from '../lib/paths.js';
// import { promptVersion } from '../lib/version.js'; // 版本处理暂时禁用
import { stateTemplatePath } from '../lib/plugin-bridge.js';
import { pluginCommand } from './plugin.js';
import { CYAN, RED, RESET } from '../lib/ui/colors.js';
import { logSection, logStep } from '../lib/ui/log.js';

/**
 * awf init — 初始化项目工作流环境
 *
 * 流程：
 *   0. 确认版本号（暂时禁用）
 *   1. 检查前置依赖（tmux、claude）
 *   2. 本地注册插件（注入 plugin/settings.json 到 .claude/settings.json）
 *   3. 初始化 .awf/ 目录结构（从模板复制，--force 补缺失）
 *   4. 注入 awf 规则到 CLAUDE.md
 */
export async function initCommand(options) {
  const { force } = options;
  const paths = getPaths();

  console.log(`${CYAN}⚡ AI Workflow 初始化${RESET}\n`);

  // 0. 版本确认（暂时禁用）
  // const version = await promptVersion(process.cwd());
  const version = undefined; // 版本处理暂时注释

  // 1. 前置依赖检查
  logSection('检查前置依赖');
  const depResults = checkPrerequisites();
  for (const r of depResults) logStep(r.label, r.status, r.msg);
  if (depResults.some((r) => r.status === 'error')) {
    console.log(`\n${RED}  缺少必要依赖，请安装后再 awf init${RESET}\n`);
    process.exit(1);
  }

  // 2. 注册插件（scope 由 pluginCommand 内部决定，默认本地）
  logSection('注册插件');
  await pluginCommand('install');

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

// 全局插件安装逻辑已迁至 src/cli/plugin.js（claude plugin install 方案）

// ── 工作空间初始化 ──

/** 检查/创建 .awf/ 目录，生成精简骨架（目录 + README + config + state，--force 补缺失） */
async function initWorkspace(paths, force, version) {
  const awfDir = path.join(process.cwd(), '.awf');
  const tplDir = path.join(paths.projectRoot, 'src', 'templates');
  const exists = await fs.stat(awfDir).catch(() => null);

  const ensureSkeleton = async () => {
    // 目录结构（bugs/issues/logs/reports/versions）
    const dirs = ['bugs', 'issues', 'logs', 'reports/lint', 'reports/test', 'reports/review', 'reports/summary', 'versions'];
    await fs.mkdir(awfDir, { recursive: true });
    for (const d of dirs) await fs.mkdir(path.join(awfDir, d), { recursive: true });
    // README / config：缺失时复制模板（不覆盖用户改过的）
    if (!await fs.stat(path.join(awfDir, 'README.md')).catch(() => null)) {
      await fs.copyFile(path.join(tplDir, 'awf-README.md'), path.join(awfDir, 'README.md'));
    }
    if (!await fs.stat(path.join(awfDir, 'config.json')).catch(() => null)) {
      await fs.copyFile(path.join(tplDir, 'awf-config.json'), path.join(awfDir, 'config.json'));
    }
    await copyStateTemplate(awfDir);
    await replaceVersion(awfDir, version);
  };

  if (!exists) {
    try { await ensureSkeleton(); logStep('.awf/', 'ok', '已创建'); return; }
    catch { logStep('.awf/', 'warn', '创建失败'); return; }
  }
  if (!force) { logStep('.awf/', 'warn', '已存在，使用 --force 补全缺失文件'); return; }

  await ensureSkeleton();
  logStep('.awf/', 'ok', '已补全缺失文件');
}

/** 如果目标不存在，从插件声明的 state.template.json 复制（路径见 plugin-bridge） */
async function copyStateTemplate(awfDir) {
  const src = stateTemplatePath();
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
