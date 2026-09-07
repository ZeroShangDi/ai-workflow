import path from 'node:path';
import fs from 'node:fs';

/** 插件 MCP args 前缀：Claude Code 注入插件根（仅 installed 插件生效） */
const PLUGIN_ROOT = '${CLAUDE_PLUGIN_ROOT}';

/** plugin.json 的作者 / 许可（写入每个插件的 plugin.json） */
const AUTHOR = { name: 'v-shangjunhao' };
const LICENSE = 'MIT';

/** config.json 未声明 engineDir 时的引擎插件目录（兼容旧配置） */
const DEFAULT_ENGINE_DIR = 'core';

/**
 * 读取插件唯一配置源 plugin/config.json（port / engineDir / marketplace / mcpServers / hooks）
 * @param {string} repoRoot - cc-control 根目录
 */
export function readPluginConfig(repoRoot) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'plugin', 'config.json'), 'utf8'));
}

/**
 * 引擎插件根目录 = plugin/<engineDir>。
 * 引擎插件承载引擎运行时：mcpServers 的 server 源码（plugin/<engineDir>/mcp/）
 * 与 hooks 生成物（plugin/<engineDir>/hooks/hooks.json、plugin/<engineDir>/.mcp.json）。
 * @param {string} repoRoot - cc-control 根目录
 */
export function enginePluginRoot(repoRoot) {
  const config = readPluginConfig(repoRoot);
  return path.join(repoRoot, 'plugin', config.engineDir || DEFAULT_ENGINE_DIR);
}

/**
 * 渲染 mcpServers（args 相对引擎插件根 plugin/<engineDir> 解析）。
 *   absolute=true  → args 解析为绝对路径（供跨项目注入的项目级 .mcp.json）
 *   relativeTo=<dir> → args 解析为相对 <dir> 的路径（供自托管项目级 .mcp.json，与仓库提交版一致）
 *   两者都未设 → args 前缀 ${CLAUDE_PLUGIN_ROOT}（插件态，供引擎插件 .mcp.json）
 *   env 占位符：{PORT} → 端口字面量
 * @param {object} mcpServers
 * @param {{repoRoot: string, absolute?: boolean, relativeTo?: string, port?: number}} opts
 */
export function renderMcpServers(mcpServers, { repoRoot, absolute = false, relativeTo, port } = {}) {
  const engineRoot = enginePluginRoot(repoRoot);
  const out = {};
  for (const [name, srv] of Object.entries(mcpServers)) {
    const env = {};
    for (const [k, v] of Object.entries(srv.env || {})) {
      env[k] = String(v).replaceAll('{PORT}', String(port));
    }
    out[name] = {
      type: srv.type || 'stdio',
      command: srv.command || 'node',
      args: srv.args.map((a) => {
        if (absolute) return path.resolve(engineRoot, a);
        if (relativeTo) return path.relative(relativeTo, path.resolve(engineRoot, a));
        return `${PLUGIN_ROOT}/${a.replace(/^\.\//, '')}`;
      }),
      ...(Object.keys(env).length ? { env } : {}),
    };
  }
  return out;
}

/**
 * 渲染单个插件的 plugin.json（plugin/<dir>/plugin.json 内容）。
 *   withHooks=true（引擎插件）→ 追加 hooks 字段，指向该插件内的 hooks.json
 * 依 marketplace.plugins 条目生成，接受任意 dir。
 * @param {{name: string, description: string, version: string, keywords?: string[]}} entry
 * @param {{withHooks?: boolean}} [opts]
 */
export function renderPluginJson(entry, { withHooks = false } = {}) {
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

/** 渲染 marketplace.json（source 取 ./<dir>/，依 marketplace.plugins 遍历） */
export function renderMarketplace(marketplace) {
  const plugins = marketplace.plugins.map((p) => ({
    name: p.name,
    description: p.description,
    version: p.version,
    source: `./${p.dir}/`,
  }));
  return JSON.stringify({ name: marketplace.name, description: marketplace.description, owner: marketplace.owner, plugins }, null, 2) + '\n';
}

/**
 * 项目级 .mcp.json 内容 — awf init/run 写入目标项目，
 * 使 MCP 工具在 enabled-only 插件注册下也能加载（插件 .mcp.json 此时只连通不暴露工具）。
 * 路径形态按场景：
 *   projectRoot == repoRoot（自托管）→ 相对 `plugin/<engineDir>/...`，与仓库提交版一致、可移植、git 干净
 *   projectRoot != repoRoot（跨项目注入）→ 绝对路径（server 在 cc-control 包内，逃逸相对路径不可靠）
 * @param {string} repoRoot - cc-control 根目录
 * @param {number} [port] - 端口覆盖；缺省用 config.json 的 port
 * @param {string} [projectRoot] - 目标项目根（.mcp.json 所在处）；缺省用 repoRoot
 */
export function projectMcpJson(repoRoot, port, projectRoot) {
  const config = readPluginConfig(repoRoot);
  const effectivePort = Number.isFinite(port) ? port : config.port;
  const target = projectRoot || repoRoot;
  const selfHosted = path.resolve(target) === path.resolve(repoRoot);
  const opts = selfHosted
    ? { repoRoot, relativeTo: target, port: effectivePort }
    : { repoRoot, absolute: true, port: effectivePort };
  return { mcpServers: renderMcpServers(config.mcpServers, opts) };
}
