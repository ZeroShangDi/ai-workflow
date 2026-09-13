'use strict';
/**
 * plugin-assets.cjs — 插件资产定位原语（包根 → plugin/<dir>/<asset>）
 *
 * 为什么要有这个模块：`plugin/config.json` 的 `marketplace.plugins` 是**插件目录的唯一注册表**
 * （render-config.mjs 渲染 marketplace.json 也读它）。「插件 X 的资产在哪」这个形状由**插件系统**
 * 决定，不由任何功能决定 —— 所以它该是共享原语，而不是各功能各写一遍 fs + JSON.parse。
 *
 * 此前散了三处，各知道一部分：
 *   - shared/prompts.js          写死 `plugin/plugin-code/prompts.json`（插件改名/挪目录就漂）
 *   - shared/runtime-config.cjs  写死 `plugin/config.json` 路径
 *   - features/decision/instruction.cjs  自己实现了 marketplace 查找
 * 现在统一经这里：**只有本模块知道 plugin/ 目录怎么摆**。
 *
 * 边界：只做「定位 + 读」。不校验资产内容、不解析 JSON 语义、不做缓存（改配置即时生效）。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 包根（本模块在 server/shared/ 下，上两级即包根；不受 cwd 影响） */
function pkgRoot() {
  return path.resolve(__dirname, '..', '..');
}

/** 插件注册表文件 plugin/config.json 的绝对路径（它是注册表本身，故不经注册表查） */
function pluginConfigPath(root = pkgRoot()) {
  return path.join(root, 'plugin', 'config.json');
}

/**
 * 读插件注册表条目（marketplace.plugins）。
 * 缺文件 / 非法 JSON / 无 marketplace 段 → 空数组（调用方按「未注册」处理）。
 * @param {string} [root] 包根；缺省由模块位置推导
 * @returns {Array<{ name: string, dir: string }>}
 */
function marketplacePlugins(root = pkgRoot()) {
  try {
    const cfg = JSON.parse(fs.readFileSync(pluginConfigPath(root), 'utf-8'));
    return Array.isArray(cfg?.marketplace?.plugins) ? cfg.marketplace.plugins : [];
  } catch {
    return [];
  }
}

/**
 * 按插件名查它在 plugin/ 下的目录名（如 ai-workflow-decision → decision）。
 * **不写死目录名**：插件改名/挪目录只改注册表，调用方零改动。
 * @param {string} name 插件名（marketplace.plugins[].name）
 * @param {string} [root] 包根
 * @returns {string} 目录名（相对 plugin/）
 * @throws {Error} 该插件未注册、或条目缺 dir
 */
function pluginDir(name, root = pkgRoot()) {
  const entry = marketplacePlugins(root).find((p) => p?.name === name);
  if (!entry?.dir) {
    throw new Error(`插件未注册于 marketplace.plugins（plugin/config.json）：${name}`);
  }
  return entry.dir;
}

/**
 * 插件内资产的绝对路径。
 * @param {string} name 插件名
 * @param {...string} parts 插件目录内的相对路径分段
 * @returns {string}
 */
function pluginAssetPath(name, ...parts) {
  return path.join(pkgRoot(), 'plugin', pluginDir(name), ...parts);
}

/**
 * 读插件内文本资产（UTF-8）。
 * @param {string} name 插件名
 * @param {...string} parts 插件目录内的相对路径分段
 * @returns {string} 文件原文（是否 trim 由调用方决定）
 * @throws {Error} 插件未注册，或文件读不到
 */
function readPluginAsset(name, ...parts) {
  return fs.readFileSync(pluginAssetPath(name, ...parts), 'utf-8');
}

const CORE_PLUGIN = 'ai-workflow-core';

/** state 模板（插件资产）：awf init 播种 .awf/state.json 用 */
function stateTemplatePath() {
  return pluginAssetPath(CORE_PLUGIN, 'mcp', 'awf-state', 'state.template.json');
}

module.exports = {
  pkgRoot,
  pluginConfigPath,
  marketplacePlugins,
  pluginDir,
  pluginAssetPath,
  readPluginAsset,
  stateTemplatePath,
};
