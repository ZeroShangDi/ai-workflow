'use strict';
/**
 * interactive.cjs — cc interactive 端口（claude 字面只在此 adapter）
 *
 * 外部源码（cli/server）零 claude 命令字面（纪律 R-cc）：plan 交互式对话等 claude 直启
 * 统一收口到本 adapter。launchInteractiveClaude 启动 Claude Code 交互式会话（继承 stdio），
 * 供 plan（src/cli/plan.js）等调用；spawn 细节与返回约定与旧 spawnClaude 一致。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

/**
 * 启动交互式 Claude Code 会话（stdio inherit）。
 * @param {{ cwd: string, prompt: string, settingsPath?: string, dangerouslySkipPermissions?: boolean }} opts
 * @returns {Promise<void>} resolve on 正常退出(0/null)；异常/非零 reject
 */
function launchInteractiveClaude({ cwd, prompt, settingsPath = projectSettingsPath(cwd), dangerouslySkipPermissions = true }) {
  return new Promise((resolve, reject) => {
    const args = [
      ...(settingsPath ? ['--settings', settingsPath] : []),
      ...(dangerouslySkipPermissions ? ['--dangerously-skip-permissions'] : []),
      prompt,
    ];
    const proc = spawn('claude', args, { stdio: 'inherit', cwd });
    proc.on('close', (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`claude 异常退出，code: ${code}`));
    });
    proc.on('error', (err) => reject(new Error(`无法启动 claude: ${err.message}`)));
  });
}

/** 默认 settings 路径（目标项目 .claude/settings.json，plan 用） */
function projectSettingsPath(cwd) {
  return path.join(cwd, '.claude', 'settings.json');
}

module.exports = { launchInteractiveClaude, projectSettingsPath };
