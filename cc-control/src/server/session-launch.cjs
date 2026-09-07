'use strict';
/**
 * session-launch.cjs — claude 会话启动构建（迁入 cc/host 的纯规则）
 *
 * 把 bootstrap.sh / run.js 里拼 claude 命令行与 tmux 会话启动的逻辑收敛为可测试纯构建：
 *   buildSessionEnv(ctx, { settingsPath })：claude 进程 env（CC_SESSION + 去 telemetry 变量）
 *   buildClaudeArgs(ctx, { settingsPath, messagingSocket })：claude 参数（permission-mode/bypass、
 *       --settings run-settings、--messaging-socket-path）
 *   buildTmuxCommand(ctx, { workdir, settingsPath, messagingSocket })：tmux new-session 完整命令
 * 镜像现有 bootstrap.sh 语义（env -u CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC/…、history-limit 100000、
 * CC_SESSION 注入），作为把 claude 启动经 server/host(tmux) 执行的基座。live 切换（bootstrap.sh/run.js
 * ensureSession 实际改调、host 执行、settings 渲染归 cc）在 W1-044/069 等 host 接入任务执行。
 */

const path = require('node:path');

/** 需剥离的变量（会关闭 cross-session messaging）——与 bootstrap.sh env -u 对齐 */
const STRIP_ENV = ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_TELEMETRY', 'DO_NOT_TRACK', 'DISABLE_GROWTHBOOK'];

/** claude 进程 env：继承 process.env 但注入 CC_SESSION，并去剥离项 */
function buildSessionEnv(ctx, { baseEnv = process.env } = {}) {
  const env = { ...baseEnv, CC_SESSION: ctx.runSessionName };
  for (const k of STRIP_ENV) delete env[k];
  return env;
}

/** claude 启动参数（permission-mode bypass + 专属 settings + messaging socket） */
function buildClaudeArgs(ctx, { settingsPath, messagingSocket }) {
  return [
    'claude',
    '--permission-mode',
    'bypassPermissions',
    ...(messagingSocket ? ['--messaging-socket-path', messagingSocket] : []),
    ...(settingsPath ? ['--settings', settingsPath] : []),
  ];
}

/**
 * tmux new-session 完整启动命令（镜像 bootstrap.sh；把 env 显式套在 claude 前）。
 * @param {object} ctx - run-context（runSessionName）
 * @param {{ workdir: string, settingsPath: string, messagingSocket: string, width?: number, height?: number }} opts
 * @returns {string} tmux new-session 命令行（可经 host 原语或 shell 执行）
 */
function buildTmuxCommand(ctx, { workdir, settingsPath, messagingSocket, width = 200, height = 50 }) {
  const env = buildSessionEnv(ctx);
  const envPrefix = `env -u ${STRIP_ENV.join(' -u ')} CC_SESSION="${env.CC_SESSION}"`;
  const claude = ['claude', '--permission-mode', 'bypassPermissions',
    `--messaging-socket-path "${messagingSocket}"`,
    `--settings "${settingsPath}"`].join(' ');
  return `tmux new-session -d -s "${ctx.runSessionName}" -x ${width} -y ${height} -c "${workdir}" "${envPrefix} ${claude}"`;
}

/** 会话默认 settings 路径：.awf/run-settings.json（与 writeRunSettings 一致） */
function runSettingsPath(projectRoot) {
  return path.join(projectRoot, '.awf', 'run-settings.json');
}

module.exports = { STRIP_ENV, buildSessionEnv, buildClaudeArgs, buildTmuxCommand, runSettingsPath };
