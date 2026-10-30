'use strict';
/**
 * cc/checks.cjs — Claude Code 平台的前置依赖检查（C02 / T-P1-01）
 *
 * 「init 要检查哪些命令」是**平台知识**，不是 CLI 知识：cc 需要 tmux + claude，DSH 不要求
 * 用户安装 Claude Code。因此这份清单从 `cli/commands/init.cjs` 下沉到平台适配器，由
 * `resolveProjectAdapters(projectRoot).checks()` 按项目取（见 ../ports.cjs 的 ADAPTER_PLATFORMS）。
 *
 * `claude` 可用性判定复用 tooling 端口的 `claudeAvailable`（`claude` 字面只在该 adapter 内）。
 */

const { execSync } = require('node:child_process');
const tooling = require('./tooling.cjs');

/** PATH 上有没有这个命令（`command -v`；找不到不抛） */
function hasCommand(name) {
  try {
    execSync(`command -v ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * cc 的前置检查：返回 `[{ name, ok, hint }]`。任一不过 → 调用方中止初始化。
 * @returns {Array<{ name: string, ok: boolean, hint: string }>}
 */
function checkPrerequisites() {
  return [
    { name: 'tmux', ok: hasCommand('tmux'), hint: 'brew install tmux' },
    { name: 'claude', ok: tooling.claudeAvailable(), hint: '安装 Claude Code 并确保 claude 在 PATH' },
    { name: 'node', ok: hasCommand('node'), hint: '安装 Node.js（插件 MCP server 需要）' },
  ];
}

module.exports = { checkPrerequisites };
