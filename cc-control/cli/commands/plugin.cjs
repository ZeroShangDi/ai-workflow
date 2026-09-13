'use strict';
/**
 * cli/commands/plugin.cjs — awf plugin install|uninstall（只编排）
 *
 * 两条路径，都不实现 cc 形状：
 *   - **local**（默认）：把随包声明的插件清单与 MCP 声明落进**本项目**配置 —— 经 `profile` 端口
 *     （`adapters/cc/profile.cjs` 管 `.claude/settings.json` / `.mcp.json` 的注入与注销）；
 *   - **global**：装到 CC 用户级插件目录 —— 经 `tooling` 端口（`claude plugin …` 命令字面只在那）。
 *
 * 本文件只有参数分派、循环与输出；命令字符串、合并语义、模板解析全在适配器层。
 */

const path = require('node:path');
const { exec } = require('node:child_process');
const { profile, tooling } = require('../../server/adapters/ports.cjs');
const { buildContext } = require('../lib/context.cjs');

/** child_process.exec 的 Promise 包装（tooling 的 install/uninstall 需要注入执行器） */
function execAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(String(stdout).trim());
    });
  });
}

/** 本地注册：写进本项目的 .claude/settings.json（enabled-only 生效范围 = 本项目） */
function localPlugin(action, projectRoot) {
  if (action === 'install') {
    const r = profile.installProfile(projectRoot);
    if (!r.written) return console.error(`本地注册失败：${r.error}`);
    console.log(`已本地注册 → ${r.path}`);
    const m = profile.installProjectMcp(projectRoot, buildContext(projectRoot, { env: {} }).port);
    if (m.written) console.log(`已注册项目 MCP → ${m.servers.join(', ')}`);
    return;
  }
  if (action === 'uninstall') {
    const r = profile.uninstallProfile(projectRoot);
    console.log(r.written ? `已注销 → ${r.path}` : '无可注销内容');
    return;
  }
  console.error(`未知操作：${action}（可用 install | uninstall）`);
  process.exit(2);
}

/** 全局安装：先注册 marketplace，再按清单逐个 claude plugin install */
async function globalPlugin(action, ctx) {
  const specs = profile.listDeclaredPlugins();
  if (!specs.length) return console.error('plugin/settings.json 未声明任何插件');

  if (action === 'install') {
    const mp = path.join(ctx.infraRoot, 'plugin');
    await execAsync(tooling.buildMarketplaceAdd(mp)); // 幂等
    for (const spec of specs) {
      console.log(`安装 ${spec} …`);
      await tooling.install(spec, { execAsync });
    }
    console.log(`已全局安装 ${specs.length} 个插件`);
    return;
  }
  if (action === 'uninstall') {
    for (const spec of specs) {
      console.log(`卸载 ${spec} …`);
      await tooling.uninstall(spec, { execAsync });
    }
    console.log(`已全局卸载 ${specs.length} 个插件`);
    return;
  }
  console.error(`未知操作：${action}（可用 install | uninstall）`);
  process.exit(2);
}

async function pluginCommand(action, options = {}) {
  const projectRoot = process.cwd();
  if (options.scope === 'global') return globalPlugin(action, buildContext(projectRoot));
  return localPlugin(action, projectRoot);
}

module.exports = { pluginCommand, localPlugin, globalPlugin, execAsync };
