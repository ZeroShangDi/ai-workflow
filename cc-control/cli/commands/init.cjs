'use strict';
/**
 * cli/commands/init.cjs — awf init（只编排）
 *
 * 三步，全是调用，不实现细节：
 *   ① 前置检查（tmux / claude / node 在不在 PATH）；
 *   ② 注册插件（本地注进本项目 .claude/settings.json）→ plugin 命令；
 *   ③ 建工作区骨架并播模板 → `shared/workspace.cjs`。
 *
 * 「.awf/ 建成什么样」不在这里 —— 那是 `shared/workspace.cjs` 的事（它拥有工作区形状）。
 */

const { execSync } = require('node:child_process');
const { tooling } = require('../../server/adapters/ports.cjs');
const { initWorkspace } = require('../../server/shared/workspace.cjs');
const { pluginCommand } = require('./plugin.cjs');

/** PATH 上有没有这个命令（`command -v`；找不到不抛） */
function hasCommand(name) {
  try {
    execSync(`command -v ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 前置检查：返回 [{ name, ok, hint }]。任一不过 → 中止（不在半缺依赖的项目里建骨架） */
function checkPrerequisites() {
  return [
    { name: 'tmux', ok: hasCommand('tmux'), hint: 'brew install tmux' },
    { name: 'claude', ok: tooling.claudeAvailable(), hint: '安装 Claude Code 并确保 claude 在 PATH' },
    { name: 'node', ok: hasCommand('node'), hint: '安装 Node.js（插件 MCP server 需要）' },
  ];
}

async function initCommand(options = {}) {
  const projectRoot = process.cwd();

  const deps = checkPrerequisites();
  for (const d of deps) console.log(`  ${d.ok ? '✓' : '✗'} ${d.name}${d.ok ? '' : `  —— ${d.hint}`}`);
  if (deps.some((d) => !d.ok)) {
    console.error('\n  缺少必要依赖，安装后重试');
    process.exit(1);
  }

  await pluginCommand('install', { scope: 'local' });

  const r = initWorkspace(projectRoot, { force: options.force });
  if (r.created) console.log(`已创建 .awf/（${r.dirs} 个目录）`);
  else if (!options.force) console.log('.awf/ 已存在（用 --force 补全缺失文件）');
  if (r.files.length) console.log(`已播模板：${r.files.join(', ')}`);
  if (r.state) console.log('已播种 state.json');

  console.log('\n  下一步：awf plan "你的需求"  →  awf run');
}

module.exports = { initCommand, checkPrerequisites };
