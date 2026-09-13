'use strict';
/**
 * cli/lib/context.cjs — 本次命令的上下文装配（新 CLI 自己的那份）
 *
 * 「我这次是谁、跟谁说话、文件在哪」全部取自 `server/shared/run-context.cjs`（那份布局的单一知情者），
 * 本文件只做两件事：
 *   ① 清洗父 run 身份后调它；
 *   ② 补 sid 缺省（会话名 = `cc-<sid>`，见下）。
 *
 * server 入口与 bootstrap 脚本路径也在 run-context 里（`serverScriptPath` / `bootstrapScriptPath`），
 * 本文件**不再自己算**：旧树时期 run-context 的 `serverScriptPath` 指向 `src/server/server.cjs`（旧 CLI
 * 的接线），新 CLI 只能用相对自身的位置绕开；旧树退役后该字段已改指 `server/server.cjs`，覆盖随之取消。
 */

const { commandConfigEnv } = require('./env.cjs');
const runContext = require('../../server/shared/run-context.cjs');

/**
 * @param {string} projectRoot 项目根（.awf 宿主）
 * @param {{ env?: object, sid?: string }} [opts] env 缺省 process.env（会先清洗父 run 身份）
 * @returns {object} run-context 的全部字段（含 serverScriptPath / bootstrapScriptPath）
 */
function buildContext(projectRoot, { env = process.env, sid = null } = {}) {
  // sid 缺省必须补 projectSid(projectRoot)：会话名 = `cc-<sid>`，而 server 端（runtime/project.cjs）
  // 用 `sid || projectSid(root)` 兜底同一个值。这里若留空，run-context 会回落到基础名 `cc`，
  // 于是 CLI 建出 `cc` 而宿主去找 `cc-<sid>` —— 派发时 "tmux session not found"（真机踩到）。
  const runSid = sid || runContext.projectSid(projectRoot);
  return runContext.buildRunContext({ projectRoot, sid: runSid, env: commandConfigEnv(env) });
}

module.exports = { buildContext };
