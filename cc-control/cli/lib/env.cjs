'use strict';
/**
 * cli/lib/env.cjs — run / server 子进程的环境边界（CC_* 契约）
 *
 * bootstrap 会把本次 run 的完整身份（会话名/项目根/端口）注入 tmux 里的 Claude。Claude 内
 * 再次执行 `awf run` / `awf server start` 时，这些变量**属于父 run**，不能再被当作新控制平面
 * 的配置输入 —— 否则会话名会被二次拼后缀（`cc-<sid>-<sid>`）、hook 网关会把事件投到父 run 的槽。
 *
 * 本模块只做纯对象转换，不改 process.env；不决定身份是什么，只决定「谁该死、谁该活」。
 *
 * ## 与旧树的关系
 * `src/lib/run-env.cjs` 是同一份契约的另一实现（新 CLI 与旧 CLI 隔离、不共享代码，同
 * prompts.js / decision-config.cjs 的处置）。**两边字段必须同步**：新增 run 级身份变量时，
 * 这里、`src/lib/run-env.cjs`、`scripts/bootstrap.sh` 的 ENV_ASSIGNS 三处一起加。
 */

/** run 身份变量：父 run 的这组值不能泄漏进子控制平面 */
const RUN_IDENTITY_KEYS = Object.freeze([
  'CC_SESSION',
  'CC_PROJECT',
  'CC_WORKDIR',
  'CC_AWF_STATE_SERVER',
  'CC_SID',
]);

/** 删掉父 run 身份；保留 CC_PORT 等控制平面配置项 */
function withoutRunIdentity(env = process.env) {
  const clean = { ...env };
  for (const key of RUN_IDENTITY_KEYS) delete clean[key];
  return clean;
}

/**
 * CLI 命令自身的配置输入。
 * 只有明确处于 awf run 会话内（CC_AWF_STATE_SERVER=1）才清洗 —— 顶层用户显式给的
 * CC_SESSION/CC_PROJECT 仍保持覆盖语义。
 */
function commandConfigEnv(env = process.env) {
  return env.CC_AWF_STATE_SERVER === '1' ? withoutRunIdentity(env) : { ...env };
}

/** server 子进程：只收基础会话名，绝不继承父 run 的完整会话名 / sid */
function serverSpawnEnv({ env = process.env, projectRoot, port, baseSession }) {
  return {
    ...withoutRunIdentity(env),
    CC_SESSION: baseSession,
    CC_PORT: String(port),
    CC_PROJECT: projectRoot,
  };
}

/**
 * tmux 里的 Claude 子会话：只收本次显式装配的完整身份。
 * 刻意不注入 CC_SID —— 主 run 走无 sid 的现行布局；注入会让 awf-state/session MCP 去读
 * 不存在的 `.awf/runs/<sid>/` 分片。
 */
function runSessionEnv({ env = process.env, projectRoot, port, sessionName }) {
  return {
    ...withoutRunIdentity(env),
    CC_SESSION: sessionName,
    CC_WORKDIR: projectRoot,
    CC_PROJECT: projectRoot,
    CC_PORT: String(port),
    CC_AWF_STATE_SERVER: '1',
  };
}

module.exports = {
  RUN_IDENTITY_KEYS,
  withoutRunIdentity,
  commandConfigEnv,
  serverSpawnEnv,
  runSessionEnv,
};
