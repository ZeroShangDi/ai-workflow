'use strict';
/**
 * decision/instruction.cjs — 决策模式指令读取（decision 功能的**资产适配**）
 *
 * 分界线：
 *   - **读什么**由本功能决定 —— decision 插件的 `decision/mode-instruction.md`；
 *   - **插件目录在哪**由插件系统决定（`plugin/config.json` 的 marketplace 注册表）——
 *     那是外部形状，经 `shared/plugin-assets.cjs` 引用，本模块不再自己实现一遍注册表查找。
 *     插件改名/挪目录只改注册表，这里零改动。
 *
 * server 用它在两处注入同一文案：
 *   - Stop 决策闸门：block 的 reason（Claude Code Stop hook block 契约字段）
 *   - PreToolUse(AskUserQuestion) 决策闸门：deny 的 reason
 * 改指令内容只改插件文件，server 零改动。
 */

const { pluginDir, pluginAssetPath, readPluginAsset } = require('../../shared/plugin-assets.cjs');

/** 插件名（进 marketplace 注册表查；与目录名分离，故改名只需改这里） */
const DECISION_PLUGIN_NAME = 'ai-workflow-decision';
/** 指令文件在插件目录内的相对路径（挪位置只需改这里） */
const INSTRUCTION_REL = ['decision', 'mode-instruction.md'];

/** decision 插件在 plugin/ 下的目录名（经注册表解析，不写死） */
function decisionPluginDir() {
  return pluginDir(DECISION_PLUGIN_NAME);
}

/** 决策模式指令文件的绝对路径 */
function decisionInstructionPath() {
  return pluginAssetPath(DECISION_PLUGIN_NAME, ...INSTRUCTION_REL);
}

/**
 * 读取并 trim 决策模式指令文案（供 Stop block / PreToolUse deny 两处注入）。
 * @returns {string} 指令文本（不含尾部空白）
 */
function readDecisionInstruction() {
  return readPluginAsset(DECISION_PLUGIN_NAME, ...INSTRUCTION_REL).trim();
}

module.exports = { readDecisionInstruction, decisionInstructionPath, decisionPluginDir, DECISION_PLUGIN_NAME };
