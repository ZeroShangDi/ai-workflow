'use strict';
/**
 * cli/commands/init.cjs — awf init（只编排）
 *
 * 四步，全是调用，不实现细节：
 *   ⓪ `--adapter <平台>`（可选）先把平台写进 `.awf/config.json` —— 之后 ①②③ 与后续所有命令
 *      都按**项目配置**解析，不需要每次带环境变量，也不用先手改配置；
 *   ① 前置检查（清单由本项目平台声明：cc 要 tmux/claude/node，DSH 只要 dsh/node）；
 *   ② 注册插件（cc 注进 `.claude/settings.json`；dsh 装 profile）→ plugin 命令；
 *   ③ 建工作区骨架并播模板 → `shared/workspace.cjs`。
 *
 * 「.awf/ 建成什么样」不在这里 —— 那是 `shared/workspace.cjs` 的事（它拥有工作区形状）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { resolveProjectAdapters, resolveAdapterName, ADAPTER_NAMES } = require('../../server/adapters/ports.cjs');
const { initWorkspace, applyAdapter } = require('../../server/shared/workspace.cjs');
const { configFilePath } = require('../../server/shared/project-paths.cjs');
const { pluginCommand } = require('./plugin.cjs');

/**
 * `--adapter <平台>`：把平台**先**写进项目配置（`.awf/config.json`），这样前置检查、插件装配
 * 与后续所有命令都直接按项目解析，不用 `CC_ADAPTER=… awf init` 这种一次性环境变量。
 * 显式传参 → 覆盖已有值（用户明确要的平台优先）；未知平台名立即报错退出（不静默回落）。
 * @param {string} projectRoot
 * @param {string} name
 */
function seedAdapter(projectRoot, name) {
  const raw = String(name).trim();
  if (!ADAPTER_NAMES.includes(raw)) {
    console.error(`  未知平台 "${raw}"（可选：${ADAPTER_NAMES.join(' | ')}）`);
    process.exit(2);
  }
  const file = configFilePath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `${JSON.stringify({ runtime: { adapter: raw } }, null, 2)}\n`);
    console.log(`  平台：${raw}（已写入 .awf/config.json）`);
    return raw;
  }
  const r = applyAdapter(projectRoot, raw, { onlyIfMissing: false });
  console.log(`  平台：${raw}（${r.changed ? `已写入 .awf/config.json：${r.reason}` : r.reason}）`);
  return raw;
}

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

  // ⓪ 显式平台优先：先落配置，后面每一步（检查/装配/骨架）都按它走
  if (options.adapter) seedAdapter(projectRoot, options.adapter);

  const deps = checkPrerequisites(projectRoot);
  for (const d of deps) console.log(`  ${d.ok ? '✓' : '✗'} ${d.name}${d.ok ? '' : `  —— ${d.hint}`}`);
  if (deps.some((d) => !d.ok)) {
    console.error('\n  缺少必要依赖，安装后重试');
    process.exit(1);
  }

  await pluginCommand('install', { scope: 'local' });

  // 平台要**记进项目**：init 按当前解析到的平台装资产（DSH 装 profile 插件），
  // 模板缺省却是 cc —— 不记就会得到「资产按 dsh 装、项目解析成 cc」（T-P2-02 收口）。
  const adapterName = resolveAdapterName(projectRoot);
  const r = initWorkspace(projectRoot, { force: options.force, adapter: adapterName });
  if (r.adapter) console.log(`  平台：${adapterName}${r.adapter.changed ? `（已记入 .awf/config.json：${r.adapter.reason}）` : `（${r.adapter.reason}）`}`);
  if (r.created) console.log(`已创建 .awf/（${r.dirs} 个目录）`);
  else if (!options.force) console.log('.awf/ 已存在（用 --force 补全缺失文件）');
  if (r.files.length) console.log(`已播模板：${r.files.join(', ')}`);
  if (r.state) console.log('已播种 state.json');

  console.log('\n  下一步：awf plan "你的需求"  →  awf run');
}

module.exports = { initCommand, checkPrerequisites };
