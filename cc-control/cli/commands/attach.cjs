'use strict';
/**
 * cli/commands/attach.cjs — 接入会话观看实时对话（纯外部动作，不拉环境、不改状态）
 *
 * T-P1-03：不再直连 tmux —— 「怎么接进去看」是平台知识，经本项目解析出的
 * `session` 端口的 `attach()` 完成（cc 实现是 `tmux attach`）。
 */

const { buildContext } = require('../lib/context.cjs');

function attachCommand() {
  const ctx = buildContext(process.cwd());
  const { session } = ctx.adapters.ports;
  try {
    session.attach({ stdio: 'inherit' });
  } catch {
    console.error(`无法接入会话 ${session.sessionName}（未启动？）`);
    process.exit(1);
  }
}

module.exports = { attachCommand };
