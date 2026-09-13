'use strict';
/**
 * cli/lib/context.cjs — 本次命令的上下文装配（新 CLI 自己的那份）
 *
 * 「我这次是谁、跟谁说话、文件在哪」全部取自这里。路径/端口/会话名**不在这算** ——
 * 那份布局归 `server/shared/run-context.cjs`（单一知情者），本文件只做三件事：
 *   ① 清洗父 run 身份后调它；
 *   ② 指向**本 CLI 配套的 server 入口**（隔壁 server/server.cjs）；
 *   ③ 收敛 CLI 自己要用的少数几项。
 *
 * ## 为什么 server 入口由 CLI 自己给
 * 新树 `run-context` 的 `serverScriptPath` 指向旧树 `src/server/server.cjs`（那是旧 CLI 的接线）。
 * 新 CLI 的服务端是它的兄弟目录 —— 用相对自身的位置表达，移动 cli/+server/ 这一对时不会坏。
 * 等到只剩一棵树时，这个字段应回归 run-context 单源。
 */

const path = require('node:path');
const { commandConfigEnv } = require('./env.cjs');
const runContext = require('../../server/shared/run-context.cjs');

/** 本 CLI 配套的 server 入口（cli/ 与 server/ 是兄弟目录） */
const SERVER_ENTRY = path.resolve(__dirname, '..', '..', 'server', 'server.cjs');
/** tmux 会话引导脚本（与旧 CLI 共用同一份；它只启动 tmux + claude，不做插件渲染） */
const BOOTSTRAP_SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'bootstrap.sh');

/**
 * @param {string} projectRoot 项目根（.awf 宿主）
 * @param {{ env?: object, sid?: string }} [opts] env 缺省 process.env（会先清洗父 run 身份）
 * @returns {object} run-context 的全部字段 + serverEntry / bootstrapScript
 */
function buildContext(projectRoot, { env = process.env, sid = null } = {}) {
  // sid 缺省必须补 projectSid(projectRoot)：会话名 = `cc-<sid>`，而 server 端（runtime/project.cjs）
  // 用 `sid || projectSid(root)` 兜底同一个值。这里若留空，run-context 会回落到基础名 `cc`，
  // 于是 CLI 建出 `cc` 而宿主去找 `cc-<sid>` —— 派发时 "tmux session not found"（真机踩到）。
  const runSid = sid || runContext.projectSid(projectRoot);
  const ctx = runContext.buildRunContext({ projectRoot, sid: runSid, env: commandConfigEnv(env) });
  return { ...ctx, serverEntry: SERVER_ENTRY, bootstrapScript: BOOTSTRAP_SCRIPT };
}

module.exports = { buildContext, SERVER_ENTRY, BOOTSTRAP_SCRIPT };
