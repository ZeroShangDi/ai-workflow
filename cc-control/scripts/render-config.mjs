#!/usr/bin/env node
/**
 * render-config.mjs — 从 plugin/config.json 渲染插件注册文件
 *
 * 唯一配置源：plugin/config.json（port / engineDir / marketplace / mcpServers / hooks）
 *
 * 模式 1（无参数，npm run build 时调用）— 重生成提交在库里的文件：
 *   - plugin/.claude-plugin/marketplace.json      市场声明（依 marketplace.plugins 遍历 → source ./<dir>/）
 *   - plugin/<dir>/plugin.json                    各插件声明（依 marketplace.plugins 遍历；引擎插件含 hooks 字段）
 *   - plugin/<engineDir>/.mcp.json                MCP 声明（相对路径，修掉硬编码绝对路径 bug）
 *   - plugin/<engineDir>/hooks/hooks.json         引擎 hooks（__PORT__ → 字面量端口，单源不进非引擎插件）
 *   说明：plugins 的 plugin.json 完全由 marketplace.plugins 条目驱动，新增插件只需在 config 加条目；
 *        mcpServers/hooks 为引擎运行时单源资产，只渲染进引擎插件目录（config.engineDir，缺省 core）。
 *
 * 模式 2（--workdir <dir> [--port <port>]）— 独立沙箱渲染（手动调用，不再被 bootstrap.sh 触发）：
 *   - <workdir>/.claude/settings.json         hooks（当前端口）
 *   - <workdir>/.mcp.json                     MCP（绝对路径）
 *   注意：bootstrap.sh 已不调用此模式 — 插件/hooks/MCP 由 .claude/settings.json 注册加载，避免覆盖项目注册。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPluginConfig, renderMcpServers, renderPluginJson, renderMarketplace, resolvePluginAssets, renderRepoSettings } from '../src/lib/plugin-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const pluginRoot = path.join(repoRoot, 'plugin');

/** 渲染 hooks 段（含 hooks 顶层包装），__PORT__ → 端口字面量 */
function renderHooksObject(hooks, port) {
  const raw = JSON.stringify(hooks, null, 2).replaceAll('__PORT__', String(port));
  return JSON.parse(raw);
}

function renderHooksFile(hooks, port) {
  return JSON.stringify({ hooks: renderHooksObject(hooks, port) }, null, 2) + '\n';
}

function write(pathname, content) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, content);
  console.log(`  ✓ ${path.relative(repoRoot, pathname)}`);
}

function main() {
  const argv = process.argv.slice(2);
  const workdirIdx = argv.indexOf('--workdir');
  const workdir = workdirIdx >= 0 ? argv[workdirIdx + 1] : null;
  const portIdx = argv.indexOf('--port');
  const portArg = portIdx >= 0 ? Number(argv[portIdx + 1]) : NaN;

  const config = readPluginConfig(repoRoot);
  const port = Number.isFinite(portArg) ? portArg : config.port;
  const { marketplace, mcpServers, hooks, engineDir } = config;
  const enginePluginDir = path.join(pluginRoot, engineDir || 'core');

  if (workdir) {
    // 模式 2：沙箱文件（手动渲染）— projectDir 用字面 workdir（独立沙箱，server 在 repoRoot 内 → 绝对路径），端口用 --port
    write(path.join(workdir, '.claude', 'settings.json'), renderHooksFile(hooks, port));
    write(
      path.join(workdir, '.mcp.json'),
      JSON.stringify({ mcpServers: renderMcpServers(mcpServers, { repoRoot, absolute: true, port }) }, null, 2) + '\n',
    );
    return;
  }

  // 模式 1：重生成提交文件 — args 用 ${CLAUDE_PLUGIN_ROOT}（Claude Code 注入插件根）
  console.log('render-config: 生成插件注册文件');
  write(path.join(pluginRoot, '.claude-plugin', 'marketplace.json'), renderMarketplace(marketplace));

  // T1-081：config 单源扩展——任意插件可声明自身 mcpServers/hooks（engineDir-only 取消）。
  // 引擎插件（config.engineDir）在自身无声明时回落顶层 config.mcpServers/hooks（向后兼容）；
  // 其余插件仅用自身声明（无则不给引擎运行时资产）。渲染按插件输出到各自 dir。
  for (const plugin of marketplace.plugins) {
    const { mcpServers: pluginMcp, hooks: pluginHooks } = resolvePluginAssets(plugin, { mcpServers, hooks, engineDir });
    write(path.join(pluginRoot, plugin.dir, 'plugin.json'), renderPluginJson(plugin, { withHooks: !!pluginHooks }));
    if (pluginMcp) {
      write(path.join(pluginRoot, plugin.dir, '.mcp.json'), JSON.stringify({ mcpServers: renderMcpServers(pluginMcp, { repoRoot, port }) }, null, 2) + '\n');
    }
    if (pluginHooks) {
      write(path.join(pluginRoot, plugin.dir, 'hooks', 'hooks.json'), renderHooksFile(pluginHooks, port));
    }
  }

  // T1-082：本仓 .claude/settings.json = plugin/settings.json 渲染产物（<pkg> → 绝对 plugin 根；
  // 第三方如 figma 属 plugin/settings.json 的手工合并层，原样保留）
  const pluginSettings = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'settings.json'), 'utf8'));
  write(path.join(repoRoot, '.claude', 'settings.json'), renderRepoSettings(pluginSettings, pluginRoot));
}

main();
