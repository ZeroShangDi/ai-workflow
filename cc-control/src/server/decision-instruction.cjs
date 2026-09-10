'use strict';
/**
 * decision-instruction.cjs — 决策模式指令读取（server 本地 helper，CJS）
 *
 * 定位 decision 插件并读取其决策模式短指令（decision/mode-instruction.md）。
 * server（CJS）用它在两处注入同一文案：
 *   - Stop 决策闸门：block 的 reason（Claude Code Stop hook block 契约字段）
 *   - PreToolUse(AskUserQuestion) 决策闸门：deny 的 reason
 * 改指令内容只改插件文件，server 零改动。
 *
 * 插件目录经 plugin/config.json 的 marketplace.plugins 解析（按插件名 ai-workflow-decision 定位，
 * 不写死目录名），与渲染器同一注册表。
 */
const fs = require('node:fs');
const path = require('node:path');

const DECISION_PLUGIN_NAME = 'ai-workflow-decision';
const INSTRUCTION_REL = path.join('decision', 'mode-instruction.md');

/** 读取 cc-control 包根 plugin/config.json */
function readPluginConfig(pkgRoot) {
  return JSON.parse(fs.readFileSync(path.join(pkgRoot, 'plugin', 'config.json'), 'utf-8'));
}

/**
 * 定位 decision 插件目录（marketplace.plugins 中 name === ai-workflow-decision 条目的 dir）。
 * @param {string} pkgRoot - cc-control 包根（缺省取本模块上级 = src/server 的父目录）
 * @returns {string} 相对 plugin/ 的目录名（如 decision）
 */
function decisionPluginDir(pkgRoot) {
  const cfg = readPluginConfig(pkgRoot);
  const entry = cfg.marketplace?.plugins?.find((p) => p.name === DECISION_PLUGIN_NAME);
  if (!entry?.dir) {
    throw new Error(`decision 插件未注册于 marketplace.plugins（config.json），无法定位 ${DECISION_PLUGIN_NAME}`);
  }
  return entry.dir;
}

/** 决策模式指令文件绝对路径 */
function decisionInstructionPath(pkgRoot) {
  return path.join(pkgRoot, 'plugin', decisionPluginDir(pkgRoot), INSTRUCTION_REL);
}

/**
 * 读取并 trim 决策模式指令文案（供 Stop block / PreToolUse deny 两处注入）。
 * @param {string} [pkgRoot] - cc-control 包根；缺省以本模块位置推导
 * @returns {string} 指令文本（不含尾部空白）
 */
function readDecisionInstruction(pkgRoot) {
  const root = pkgRoot || path.resolve(__dirname, '..', '..'); // src/server → 包根
  return fs.readFileSync(decisionInstructionPath(root), 'utf-8').trim();
}

module.exports = { readDecisionInstruction, decisionInstructionPath, decisionPluginDir, DECISION_PLUGIN_NAME };
