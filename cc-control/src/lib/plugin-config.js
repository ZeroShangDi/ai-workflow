import path from 'node:path';
import fs from 'node:fs';

/** 插件 MCP args 前缀：Claude Code 注入插件根（仅 installed 插件生效） */
const PLUGIN_ROOT = '${CLAUDE_PLUGIN_ROOT}';

/**
 * 读取插件唯一配置源 plugin/config.json（port / marketplace / mcpServers / hooks）
 * @param {string} repoRoot - cc-control 根目录
 */
export function readPluginConfig(repoRoot) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'plugin', 'config.json'), 'utf8'));
}

/**
 * 渲染 mcpServers。
 *   absolute=true  → args 解析为绝对路径（供跨项目注入的项目级 .mcp.json）
 *   relativeTo=<dir> → args 解析为相对 <dir> 的路径（供自托管项目级 .mcp.json，与仓库提交版一致）
 *   两者都未设 → args 前缀 ${CLAUDE_PLUGIN_ROOT}（插件态，供 plugin/core/.mcp.json）
 *   env 占位符：{PORT} → 端口字面量
 * @param {object} mcpServers
 * @param {{repoRoot: string, absolute?: boolean, relativeTo?: string, port?: number}} opts
 */
export function renderMcpServers(mcpServers, { repoRoot, absolute = false, relativeTo, port } = {}) {
  const coreDir = path.join(repoRoot, 'plugin', 'core');
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
        if (absolute) return path.resolve(coreDir, a);
        if (relativeTo) return path.relative(relativeTo, path.resolve(coreDir, a));
        return `${PLUGIN_ROOT}/${a.replace(/^\.\//, '')}`;
      }),
      ...(Object.keys(env).length ? { env } : {}),
    };
  }
  return out;
}

/**
 * 项目级 .mcp.json 内容 — awf init/run 写入目标项目，
 * 使 MCP 工具在 enabled-only 插件注册下也能加载（插件 .mcp.json 此时只连通不暴露工具）。
 * 路径形态按场景：
 *   projectRoot == repoRoot（自托管）→ 相对 `plugin/core/...`，与仓库提交版一致、可移植、git 干净
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
