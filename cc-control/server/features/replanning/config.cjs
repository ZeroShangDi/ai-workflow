'use strict';
/**
 * replanning/config.cjs — 动态任务规划的执行策略配置（.awf/config.json 的 run.dynamicPlanning 段）。
 *
 * 两种执行模式：
 *   - approve_then_apply（默认）：提案先挂起、等人工批准后才改 state；
 *   - auto_then_review：提案即时应用，事后走 Review 复核。
 * 缺省取 approve_then_apply：动态规划会改写既定任务图，属高风险动作，未显式配置的项目
 * 不应被自动改写，故默认必须有人点头。
 */

const { readJsonFile } = require('../../shared/config-loader.cjs');
const { configFilePath } = require('../../shared/project-paths.cjs'); // .awf 布局单源

const MODES = Object.freeze({
  AUTO_THEN_REVIEW: 'auto_then_review',
  APPROVE_THEN_APPLY: 'approve_then_apply',
});
const DEFAULT_MODE = MODES.APPROVE_THEN_APPLY;

/** 只接受白名单内的模式值；未知/缺省值一律回落 DEFAULT_MODE（防止拼写错误造成意外自动应用） */
function normalizeMode(value) {
  return Object.values(MODES).includes(value) ? value : DEFAULT_MODE;
}

/**
 * 从已解析的 raw（.awf/config.json 内容）抽取动态规划配置。
 * @param {object} raw
 * @returns {{ mode: string, extensions: object }}
 */
function dynamicPlanningConfigFrom(raw) {
  const section = raw?.run?.dynamicPlanning || {};
  return {
    mode: normalizeMode(section.mode),
    // 预埋扩展空间：未来复审器、通知器、策略实现可按名字接入；核心当前不解释其内容。
    extensions: section.extensions && typeof section.extensions === 'object' && !Array.isArray(section.extensions)
      ? { ...section.extensions }
      : {},
  };
}

/**
 * 读取 <projectRoot>/.awf/config.json 并解析动态规划配置。
 * 文件缺失/非法 JSON → 安全默认（approve_then_apply + 空 extensions），不抛错。
 * @param {string} projectRoot
 * @returns {{ mode: string, extensions: object }}
 */
function loadDynamicPlanningConfig(projectRoot) {
  // .awf/config.json 的读取形状（路径 + 容错语义）是外部约定，经共享原语读
  const raw = readJsonFile(configFilePath(projectRoot), { optional: true });
  return dynamicPlanningConfigFrom(raw ?? {});
}

module.exports = { MODES, DEFAULT_MODE, normalizeMode, dynamicPlanningConfigFrom, loadDynamicPlanningConfig };
