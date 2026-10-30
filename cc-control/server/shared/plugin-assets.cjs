'use strict';
/**
 * plugin-assets.cjs — 插件资产定位原语（包根 → plugin/<dir>/<asset>）
 *
 * 为什么要有这个模块：生成后的 `plugin/<dir>/plugin.json` 是运行时可用的插件目录注册表。
 * 「插件 X 的资产在哪」这个形状由**插件系统**
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
  return path.join(root, 'server', 'adapters', 'cc', 'plugin', 'config.json');
}

/**
 * 读生成后的插件 manifest。源码态元数据在 `plugin/<dir>/plugin.json`，构建会把它们渲染到这里。
 * @param {string} [root] 包根；缺省由模块位置推导
 * @returns {Array<{ name: string, dir: string }>}
 */
function marketplacePlugins(root = pkgRoot()) {
  const generatedRoot = path.join(root, 'server', 'adapters', 'cc', 'plugin');
  if (!fs.existsSync(generatedRoot)) return [];
  const found = [];
  for (const item of fs.readdirSync(generatedRoot, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(generatedRoot, item.name, 'plugin.json'), 'utf8'));
      if (manifest?.name) found.push({ name: manifest.name, dir: item.name });
    } catch {
      // 非插件目录或尚未生成 manifest：忽略，由调用方按「未注册」处理。
    }
  }
  return found;
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
    throw new Error(`插件未注册（缺少生成的 manifest）：${name}`);
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
  return path.join(pkgRoot(), 'server', 'adapters', 'cc', 'plugin', pluginDir(name), ...parts);
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

/**
 * 适配器插件的包根 —— 每个平台一个**自包含**包（`server/adapters/<平台>/plugin/`）。
 *
 * 为什么要有这条：cc 的资产按 marketplace 注册表分插件目录，DSH 的资产平铺在一个包里
 * （安装单元 = 一个目录）。形状不同，但「某平台的资产在哪」这个问题的答案都归这里，
 * 不由调用方各自拼路径。
 * @param {string} adapter 平台名（cc / dsh）
 * @param {string} [root] 包根；缺省由模块位置推导
 * @returns {string}
 */
function adapterPluginRoot(adapter, root = pkgRoot()) {
  return path.join(root, 'server', 'adapters', adapter, 'plugin');
}

/**
 * 适配器插件包内资产的绝对路径。
 * @param {string} adapter 平台名
 * @param {...string} parts 包内相对路径分段
 * @returns {string}
 */
function adapterAssetPath(adapter, ...parts) {
  return path.join(adapterPluginRoot(adapter), ...parts);
}

/**
 * 读适配器插件包内的文本资产（UTF-8）。
 * @param {string} adapter 平台名
 * @param {...string} parts 包内相对路径分段
 * @returns {string}
 * @throws {Error} 文件读不到（不静默给空串 —— 上游会据此发出残缺指令）
 */
function readAdapterAsset(adapter, ...parts) {
  return fs.readFileSync(adapterAssetPath(adapter, ...parts), 'utf-8');
}

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
  adapterPluginRoot,
  adapterAssetPath,
  readAdapterAsset,
  stateTemplatePath,
};
