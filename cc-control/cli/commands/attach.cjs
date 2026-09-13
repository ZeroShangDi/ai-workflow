'use strict';
/**
 * cli/commands/attach.cjs — 接入 tmux 会话观看实时对话（纯外部动作，不拉环境、不改状态）
 */

const { execSync } = require('node:child_process');
const { buildContext } = require('../lib/context.cjs');

function attachCommand() {
  const ctx = buildContext(process.cwd());
  try {
    execSync(`tmux attach -t ${ctx.runSessionName}`, { stdio: 'inherit' });
  } catch {
    console.error(`无法接入会话 ${ctx.runSessionName}（未启动？）`);
    process.exit(1);
  }
}

module.exports = { attachCommand };
