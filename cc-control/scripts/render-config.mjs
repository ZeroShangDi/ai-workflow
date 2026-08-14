#!/usr/bin/env node
/**
 * render-config.mjs — 从 plugin/config.json 渲染插件注册文件
 *
 * 唯一配置源：plugin/config.json（port / marketplace / mcpServers / hooks）
 *
 * 模式 1（无参数，npm run build 时调用）— 重生成提交在库里的文件：
 *   - plugin/.claude-plugin/marketplace.json  双插件入口（core + plugin-code）
 *   - plugin/core/.mcp.json                   MCP 声明（相对路径，修掉硬编码绝对路径 bug）
 *   - plugin/core/hooks/hooks.json            插件 hooks（__PORT__ → 字面量端口）
 *   - plugin/core/plugin.json                 引擎层插件声明（含 hooks 字段）
 *   - plugin/plugin-code/plugin.json          领域层插件声明（无 hooks 字段）
 *
 * 模式 2（--workdir <dir> [--port <port>]）— 独立沙箱渲染（手动调用，不再被 bootstrap.sh 触发）：
 *   - <workdir>/.claude/settings.json         hooks（当前端口）
 *   - <workdir>/.mcp.json                     MCP（绝对路径）
 *   注意：bootstrap.sh 已不调用此模式 — 插件/hooks/MCP 由 .claude/settings.json 注册加载，避免覆盖项目注册。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const pluginRoot = path.join(repoRoot, 'plugin');
const coreDir = path.join(pluginRoot, 'core');

const AUTHOR = { name: 'v-shangjunhao' };
const LICENSE = 'MIT';

function readConfig() {
  return JSON.parse(fs.readFileSync(path.join(pluginRoot, 'config.json'), 'utf8'));
}

/** 渲染 hooks 段（含 hooks 顶层包装），__PORT__ → 端口字面量 */
function renderHooksObject(hooks, port) {
  const raw = JSON.stringify(hooks, null, 2).replaceAll('__PORT__', String(port));
  return JSON.parse(raw);
}

function renderHooksFile(hooks, port) {
  return JSON.stringify({ hooks: renderHooksObject(hooks, port) }, null, 2) + '\n';
}

/**
 * 渲染 mcpServers。env 占位符解析：
 *   - {PROJECT_DIR} → 插件态 ${CLAUDE_PROJECT_DIR}（Claude Code 注入）/ 沙箱态 workdir 字面路径
 *   - {PORT} → 端口字面量
 * @param {object} mcpServers
 * @param {{absolute?: boolean, projectDir?: string, port?: number}} opts
 */
function renderMcpServers(mcpServers, { absolute = false, projectDir, port }) {
  const out = {};
  for (const [name, srv] of Object.entries(mcpServers)) {
    const env = {};
    for (const [k, v] of Object.entries(srv.env || {})) {
      env[k] = String(v)
        .replaceAll('{PROJECT_DIR}', projectDir)
        .replaceAll('{PORT}', String(port));
    }
    out[name] = {
      type: srv.type || 'stdio',
      command: srv.command || 'node',
      args: srv.args.map((a) => (absolute ? path.resolve(coreDir, a) : a)),
      ...(Object.keys(env).length ? { env } : {}),
    };
  }
  return out;
}

/** 生成 plugin/<dir>/plugin.json（core 带 hooks 字段，plugin-code 不带） */
function renderPluginJson(entry, { withHooks = false } = {}) {
  const obj = {
    name: entry.name,
    description: entry.description,
    version: entry.version,
    author: AUTHOR,
    license: LICENSE,
    keywords: entry.keywords || [],
  };
  if (withHooks) obj.hooks = './hooks/hooks.json';
  return JSON.stringify(obj, null, 2) + '\n';
}

/** 生成 marketplace.json（source 取 ./<dir>/） */
function renderMarketplace(marketplace) {
  const plugins = marketplace.plugins.map((p) => ({
    name: p.name,
    description: p.description,
    version: p.version,
    source: `./${p.dir}/`,
  }));
  return JSON.stringify({ name: marketplace.name, description: marketplace.description, owner: marketplace.owner, plugins }, null, 2) + '\n';
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

  const config = readConfig();
  const port = Number.isFinite(portArg) ? portArg : config.port;
  const { marketplace, mcpServers, hooks } = config;

  if (workdir) {
    // 模式 2：沙箱文件（手动渲染）— projectDir 用字面 workdir，端口用 --port
    write(path.join(workdir, '.claude', 'settings.json'), renderHooksFile(hooks, port));
    write(
      path.join(workdir, '.mcp.json'),
      JSON.stringify({ mcpServers: renderMcpServers(mcpServers, { absolute: true, projectDir: workdir, port }) }, null, 2) + '\n',
    );
    return;
  }

  // 模式 1：重生成提交文件 — projectDir 用 ${CLAUDE_PROJECT_DIR}（Claude Code 注入）
  console.log('render-config: 生成插件注册文件');
  write(path.join(pluginRoot, '.claude-plugin', 'marketplace.json'), renderMarketplace(marketplace));
  write(path.join(coreDir, '.mcp.json'), JSON.stringify({ mcpServers: renderMcpServers(mcpServers, { projectDir: '${CLAUDE_PROJECT_DIR}', port }) }, null, 2) + '\n');
  write(path.join(coreDir, 'hooks', 'hooks.json'), renderHooksFile(hooks, port));
  write(path.join(coreDir, 'plugin.json'), renderPluginJson(marketplace.plugins.find((p) => p.dir === 'core'), { withHooks: true }));
  write(path.join(pluginRoot, 'plugin-code', 'plugin.json'), renderPluginJson(marketplace.plugins.find((p) => p.dir === 'plugin-code')));
}

main();
