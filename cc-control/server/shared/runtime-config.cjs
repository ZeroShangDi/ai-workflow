'use strict';
/**
 * runtime-config.cjs — 运行期常量单源解析（config 默认 + env 覆盖）
 *
 * 背景：运行期常量（端口 / 会话名等）过去在每个模块手工拷贝默认值（8787 / 'cc'），
 * 一旦漂移就难以追踪。本模块把它们收敛到唯一来源：
 *   - 默认值  ← plugin/config.json（port 顶层 / runtime.session，经 config-loader 校验）
 *   - env 覆盖 ← CC_PORT / CC_SESSION（优先级高于配置文件）
 * repo 内各模块（cli / server / tmux / session client）一律经本模块取值，不再自带字面量。
 *
 * 插件侧（plugin/core/hooks/gateway.cjs、plugin/core/mcp/*）运行在 Claude Code 插件环境，
 * 无法引用 core/；它们只读由 CLI/渲染链按同一单源注入的 argv/env（gateway 收 argv 端口、
 * awf-session 收 AWF_BASE / CC_SESSION、awf-state 收 AWF_PROJECT_ROOT）。
 *
 * 边界与取舍：
 *   - 只解析、不改写；不同 run 的多实例会话名/路径装配由上层（run-context 装配器）承接。
 *   - 无缓存：每次调用都重新读 config 文件，保证「改配置即时生效」；高频调用时注意 I/O 成本
 *     （getServerPort + getSessionName 各触发一次文件读）。
 *   - strict：配置缺失/非法直接抛错，不静默回落——config 是唯一默认源，静默兜底只会掩盖漂移。
 */

const { loadConfig } = require('./config-loader.cjs');
const { pluginConfigPath } = require('./plugin-assets.cjs');

/** plugin/config.json 路径（包根由 plugin-assets 推导，不受 cwd / 运行目录影响） */
function runtimeConfigPath() {
  return pluginConfigPath();
}

/**
 * 运行期常量规则（声明式，交给 config-loader 校验）：
 *   - port：整数，1–65535，必填；CC_PORT 可覆盖
 *   - runtime.session：非空字符串，必填；CC_SESSION 可覆盖
 * 两个字段都 required：配置文件缺失这两项时 strict 直接抛错，暴露「config 单源不完整」。
 */
const RUNTIME_RULES = {
  port: { env: 'CC_PORT', type: 'integer', min: 1, max: 65535, required: true },
  'runtime.session': { env: 'CC_SESSION', type: 'string', pattern: /^.+$/, required: true },
};

/**
 * 读取运行期常量。passthrough 保留整份 config；port/session 解析为
 * env(CC_PORT/CC_SESSION) > config 文件 > （缺失即 strict 报错，config 是唯一默认源）。
 * @param {object} [env] 环境变量（缺省 process.env），便于测试注入
 * @returns {{ port: number, session: string }}
 * @throws {ConfigError} config 缺失/字段非法时（strict）
 */
function readRuntimeConfig(env = process.env) {
  // passthrough=true：以整份 config 为基底，rules 只对 port/runtime.session 兜底/覆盖，
  // 其余字段原样保留；调用方只取需要的两个字段（其余留给未来消费方）。
  const cfg = loadConfig({ rules: RUNTIME_RULES, source: { filePath: runtimeConfigPath() }, passthrough: true, env, strict: true });
  return { port: cfg.port, session: cfg.runtime?.session };
}

/** Session Server 监听端口（CC_PORT 覆盖 config 单源 port） */
function getServerPort(env) {
  return readRuntimeConfig(env).port;
}

/** tmux session 默认名（CC_SESSION 覆盖 config 单源 runtime.session） */
function getSessionName(env) {
  return readRuntimeConfig(env).session;
}

// 对外：整份读取（readRuntimeConfig）+ 两个取单值的便捷函数 + 配置路径（测试/诊断用）。
module.exports = { runtimeConfigPath, readRuntimeConfig, getServerPort, getSessionName };
