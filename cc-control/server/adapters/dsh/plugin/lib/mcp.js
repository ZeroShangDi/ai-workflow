/**
 * mcp.js — 把包内自带的 MCP server 挂进**会话作用域**
 *
 * 形态：平台的手法（与 `dsh-acp` 的 mountAcpMcpServers 一致）是
 * `agentCtx.plugin(McpClient, {transport:'stdio', serverName, command, args, env})`，
 * 必须落在 **agent 发布前**的 `setup` 窗口里 —— `sessionController.create` 没有这个窗口，
 * 挂上去的工具进不了会话工具表（P2-5d 实测：0 个工具）。
 *
 * 自包含：入口一律 `<本包根>/<mcp.json 的 entry>`。旧实现靠 `awfRepo` 指到
 * **cc 侧的插件树** 去取 server.cjs —— 那正是「插件目录引用外部目录」的元凶，
 * 且 link/拷贝到别处就断。现在随包携带（含 awf-state 的两个叶子依赖 `mcp/_lib/`）。
 *
 * 项目隔离：每个项目各起一份 MCP server 进程，并把自己的 `AWF_PROJECT_ROOT` 传给它 ——
 * 不把项目变量放进共享全局配置（共享 server 会串项目，见 P2-6d 实测）。
 */

import path from 'node:path';
import { listMcpServers, pluginRoot } from './assets.js';

/**
 * 本次要挂哪些 server：config.mcpServers **显式给出时完全照办**（空数组 = 一个都不挂，
 * 便于测试与「只跑通道」的场景）> 否则取 mcp.json 的 mountByDefault。
 * @param {object} config 插件配置
 * @returns {Array<{name: string, entry: string}>}
 */
export function resolveServers(config = {}) {
  const declared = listMcpServers();
  if (Array.isArray(config.mcpServers)) {
    const wanted = new Set(config.mcpServers);
    return declared.filter((s) => wanted.has(s.name));
  }
  return declared.filter((s) => s.mountByDefault);
}

/** 某一个 server 的入口绝对路径（本包内） */
export function serverEntryPath(entry) {
  return path.join(pluginRoot(), entry);
}

/**
 * 把声明的 MCP server 挂进给定 agent 作用域。
 * @param {object} agentCtx setup 回调拿到的 agent 作用域 ctx（必须带 plugin）
 * @param {string} cwd 项目根（进 AWF_PROJECT_ROOT，决定这个 server 进程读哪个项目的 state.json）
 * @param {{config?: object, log?: Function, loadMcpClient?: Function}} deps
 * @returns {Promise<string[]>} 实际挂上的 server 名
 * @throws {Error} agent 作用域缺失 / McpClient 加载不到 —— 明确失败，不静默少挂
 */
export async function mountMcpServers(agentCtx, cwd, {
  config = {},
  log = () => {},
  loadMcpClient = () => import('@deepseek-ai/dsh-mcp-client'),
} = {}) {
  if (typeof agentCtx?.plugin !== 'function') {
    throw new Error('缺少 agent 作用域 ctx（setup 回调的第一个参数）—— MCP 只能挂在会话作用域');
  }
  const servers = resolveServers(config);
  if (servers.length === 0) {
    // 显式声明了空集 = 调用方的选择（不告警）；没声明却什么都没有 = 多半是 mcp.json 坏了
    if (!Array.isArray(config.mcpServers)) log('warn', '没有要挂的 MCP server（mcp.json 未声明任何 mountByDefault 条目）');
    return [];
  }

  const McpClient = await loadMcpClient();
  const mounted = [];
  for (const server of servers) {
    await agentCtx.plugin(McpClient, {
      transport: 'stdio',
      serverName: server.name,
      command: process.execPath,
      args: [serverEntryPath(server.entry)],
      env: { AWF_PROJECT_ROOT: cwd, ...(config.mcpEnv ?? {}) },
    });
    mounted.push(server.name);
  }
  log('info', `已挂 MCP：${mounted.join(', ')}（项目 ${cwd}）`);
  return mounted;
}
