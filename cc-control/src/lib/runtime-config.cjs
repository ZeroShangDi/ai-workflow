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
 * 无法引用 src/lib；它们只读由 CLI/渲染链按同一单源注入的 argv/env（gateway 收 argv 端口、
 * awf-session 收 AWF_BASE / CC_SESSION、awf-state 收 AWF_PROJECT_ROOT）。
 *
 * 本模块只解析、不改写；不同 run 的多实例会话名/路径装配由上层（run-context 装配器）承接。
 */

const path = require('node:path');
const { loadConfig } = require('./config-loader.cjs');

/** plugin/config.json 路径（相对本模块 src/lib 定位，不受 cwd / 运行目录影响） */
function runtimeConfigPath() {
  return path.resolve(__dirname, '..', '..', 'plugin', 'config.json');
}

/** 运行期常量规则：默认值来自 config 单源文件，CC_* 环境变量可覆盖（strict 校验） */
const RUNTIME_RULES = {
  port: { env: 'CC_PORT', type: 'integer', min: 1, max: 65535, required: true },
  'runtime.session': { env: 'CC_SESSION', type: 'string', pattern: /^.+$/, required: true },
};

/**
 * 读取运行期常量。passthrough 保留整份 config；port/session 解析为
 * env(CC_PORT/CC_SESSION) > config 文件 > （缺失即 strict 报错，config 是唯一默认源）。
 * @param {object} [env] 环境变量（缺省 process.env），便于测试注入
 * @returns {{ port: number, session: string }}
 */
function readRuntimeConfig(env = process.env) {
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

module.exports = { runtimeConfigPath, readRuntimeConfig, getServerPort, getSessionName };
