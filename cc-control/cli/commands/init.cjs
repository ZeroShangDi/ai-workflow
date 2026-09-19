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

const { resolveProjectAdapters } = require('../../server/adapters/ports.cjs');
const { initWorkspace } = require('../../server/shared/workspace.cjs');
const { pluginCommand } = require('./plugin.cjs');

/**
 * 前置检查：清单由**本项目平台的适配器**声明（C02 / T-P1-01）——
 * cc 要 tmux/claude/node，DSH 不要求用户安装 Claude Code。
 * @param {string} [projectRoot] 项目根（缺省 cwd）
 * @returns {Array<{ name: string, ok: boolean, hint: string }>}
 */
function checkPrerequisites(projectRoot = process.cwd()) {
  return resolveProjectAdapters(projectRoot).checks();
}

async function initCommand(options = {}) {
  const projectRoot = process.cwd();

  const deps = checkPrerequisites(projectRoot);
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
