'use strict';
/**
 * app.cjs — server 控制平面应用骨架（W3-003 bootstrap 接缝；接 W3-001 config/装配地基）
 *
 * 目标：为后续「server 常驻控制平面分层」（boot/优雅关闭/健康/config 装载 + run 域、store、
 * metrics、api、events 等子模块）提供可挂接的应用装配点。本文件保持行为不变——只装配
 * run-context/store/config 等既有地基，不重写现有 server.cjs / cli run 路径。
 *
 * createServerApp({ projectRoot, sid }) 产出：
 *   ctx     run-context 装配（路径/会话名/端口/每 run 布局）
 *   stores  该 run 的 store 层（state/usage/runConfig/meta/snapshots + append/json 工厂）
 *   config  装载：infra（plugin/config.json 单源，经 config-loader）+ run（.awf/config.json 可选）
 *   health()   健康状态（ok / pid / projectRoot / sid / bootedAt / uptimeMs）
 *   onShutdown(fn) / shutdown()   优雅关闭注册表（先入先出反向执行，供 W3-003 优雅关闭接线）
 *
 * config 装载（接 W3-001）：
 *   - infra：config-loader passthrough 读 ctx.infraConfigPath（port/engineDir 校验）
 *   - run  ：.awf/config.json 可选读（缺失 → null）；默认合并规则归未来 loadRunConfig 迁移
 *
 * 骨架不自动 mkdir/不监听端口/不启动进程——boot 由后续 api/host 任务在此基座上触发。
 */

const configLoader = require('../lib/config-loader.cjs');
const { buildRunContext } = require('../lib/run-context.cjs');
const { createRunStores } = require('../lib/store.cjs');

/** infra 配置（plugin/config.json）字段规则（与 plugin-config.js 的 PLUGIN_CONFIG_RULES 对齐，单源校验） */
const INFRA_RULES = {
  port: { type: 'integer', min: 1, max: 65535 },
  engineDir: { type: 'string', pattern: /^.+$/ },
  marketplace: { type: 'object' },
  mcpServers: { type: 'object' },
  hooks: { type: 'object' },
};

/**
 * 装载 infra 单源配置（plugin/config.json，经 config-loader passthrough 校验；必读）。
 * @param {string} infraRoot
 */
function loadInfraConfig(infraRoot) {
  return configLoader.loadConfig({
    rules: INFRA_RULES,
    source: { filePath: require('node:path').join(infraRoot, 'plugin', 'config.json') },
    passthrough: true,
  });
}

/**
 * 装载项目 run 配置（.awf/config.json，可选读；缺失 → null）。
 * @param {object} ctx run-context（提供 runConfigPath）
 */
function loadRunConfigFile(ctx) {
  return createRunStores(ctx).runConfig.readSync();
}

/**
 * 装配 server 应用骨架。
 * @param {{ projectRoot?: string, sid?: string, env?: object }} input
 */
function createServerApp({ projectRoot, sid, env } = {}) {
  const ctx = buildRunContext({ sid, projectRoot, env });
  const stores = createRunStores(ctx);
  const bootedAt = new Date().toISOString();
  const startedMs = Date.now();

  // ── 优雅关闭注册表 ──
  const shutdownHandlers = [];
  function onShutdown(fn) {
    if (typeof fn !== 'function') throw new Error('app.onShutdown: fn 须为函数');
    shutdownHandlers.push(fn);
    return fn;
  }
  /** 依注册逆序执行各关闭处理器；单项异常吞掉并累计返回。 */
  function shutdown() {
    const errors = [];
    for (const fn of [...shutdownHandlers].reverse()) {
      try { fn(); } catch (err) { errors.push(err); }
    }
    return errors;
  }

  /** 健康状态（boot 后应可达；可扩展 storage/http 子健康） */
  function health() {
    return {
      ok: true,
      pid: process.pid,
      projectRoot: ctx.projectRoot,
      sid: ctx.sid ?? null,
      port: ctx.port,
      bootedAt,
      uptimeMs: Date.now() - startedMs,
    };
  }

  return {
    ctx,
    stores,
    bootedAt,
    config: {
      infra: () => loadInfraConfig(ctx.infraRoot),
      run: () => loadRunConfigFile(ctx),
    },
    health,
    onShutdown,
    shutdown,
  };
}

module.exports = { createServerApp, loadInfraConfig, loadRunConfigFile };
