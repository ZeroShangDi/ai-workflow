'use strict';

/**
 * run-env.cjs — run / server 子进程环境边界
 *
 * bootstrap 会把本次 run 的完整会话名和项目身份注入 Claude。Claude 内再次执行
 * `awf run` / `awf server start` 时，这些变量属于父 run，不能继续被当作新控制平面的
 * 配置输入；否则 `CC_SESSION=cc-<projectSid>` 会被再次拼接成双后缀。
 *
 * 本模块只做纯对象转换，不修改 process.env。
 */

const RUN_IDENTITY_KEYS = Object.freeze([
  'CC_SESSION',
  'CC_PROJECT',
  'CC_WORKDIR',
  'CC_AWF_STATE_SERVER',
  'CC_SID',
]);

/** 删除父 run 身份；保留 CC_PORT 等控制平面配置。 */
function withoutRunIdentity(env = process.env) {
  const clean = { ...env };
  for (const key of RUN_IDENTITY_KEYS) delete clean[key];
  return clean;
}

/**
 * CLI 命令的配置输入。
 * 只有明确处于 awf run 会话内（CC_AWF_STATE_SERVER=1）才清洗，顶层用户显式提供的
 * CC_SESSION/CC_PROJECT 仍保持原有覆盖语义。
 */
function commandConfigEnv(env = process.env) {
  return env.CC_AWF_STATE_SERVER === '1' ? withoutRunIdentity(env) : { ...env };
}

/** server 必须接收基础 session 名，不能继承父 run 的完整 session / sid。 */
function serverSpawnEnv({ env = process.env, projectRoot, port, baseSession }) {
  return {
    ...withoutRunIdentity(env),
    CC_SESSION: baseSession,
    CC_PORT: String(port),
    CC_PROJECT: projectRoot,
  };
}

/** tmux/Claude 子会话只接收本次显式装配的完整身份，不继承父 run 的 sid。 */
function runSessionEnv({ env = process.env, projectRoot, port, sessionName, stateServer = true }) {
  const child = {
    ...withoutRunIdentity(env),
    CC_SESSION: sessionName,
    CC_WORKDIR: projectRoot,
    CC_PROJECT: projectRoot,
    CC_PORT: String(port),
  };
  if (stateServer) child.CC_AWF_STATE_SERVER = '1';
  return child;
}

module.exports = {
  RUN_IDENTITY_KEYS,
  withoutRunIdentity,
  commandConfigEnv,
  serverSpawnEnv,
  runSessionEnv,
};
