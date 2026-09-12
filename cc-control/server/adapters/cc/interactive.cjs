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
 * 与 oneshot 的区别：oneshot 是「跑完收集 stdout」，这里是「把终端交给 claude 让用户对话」，
 * 故 stdio: 'inherit'，父进程不读输出、也不抢占 stdin。
 * @param {{ cwd: string, prompt: string, settingsPath?: string, dangerouslySkipPermissions?: boolean }} opts
 *   settingsPath  缺省取项目 .claude/settings.json（供 claude 按本项目 settings 运行）
 *   dangerouslySkipPermissions  缺省 true —— plan 交互场景不弹权限确认（这是自动化的前提）
 * @returns {Promise<void>} resolve on 正常退出(0/null)；异常/非零 reject
 *   code === null 视为正常：进程被信号终止（如用户 Ctrl+C）不是错误
 */
function launchInteractiveClaude({ cwd, prompt, settingsPath = projectSettingsPath(cwd), dangerouslySkipPermissions = true }) {
  return new Promise((resolve, reject) => {
    // 参数顺序：可选 flag 在前，prompt 作为最后的位置参数
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

// projectSettingsPath 是函数声明（可提升），故能在上方默认参数处被引用
module.exports = { launchInteractiveClaude, projectSettingsPath };
