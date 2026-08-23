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
 *   absolute=false → args 前缀 ${CLAUDE_PLUGIN_ROOT}（插件态，供 plugin/core/.mcp.json）
 *   absolute=true  → args 解析为绝对路径（供项目级 .mcp.json）
 *   env 占位符：{PORT} → 端口字面量
 * @param {object} mcpServers
 * @param {{repoRoot: string, absolute?: boolean, port?: number}} opts
 */
export function renderMcpServers(mcpServers, { repoRoot, absolute = false, port } = {}) {
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
        return `${PLUGIN_ROOT}/${a.replace(/^\.\//, '')}`;
      }),
      ...(Object.keys(env).length ? { env } : {}),
    };
  }
  return out;
}

/**
 * 项目级 .mcp.json 内容（绝对路径）— awf init/run 写入目标项目，
 * 使 MCP 工具在 enabled-only 插件注册下也能加载（插件 .mcp.json 此时只连通不暴露工具）。
 * @param {string} repoRoot - cc-control 根目录
 * @param {number} [port] - 端口覆盖；缺省用 config.json 的 port
 */
export function projectMcpJson(repoRoot, port) {
  const config = readPluginConfig(repoRoot);
  const effectivePort = Number.isFinite(port) ? port : config.port;
  return { mcpServers: renderMcpServers(config.mcpServers, { repoRoot, absolute: true, port: effectivePort }) };
}
