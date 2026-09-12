'use strict';
/**
 * decision-config.cjs — 决策闸门开关判定（server/CLI 共用单一实现）
 *
 * 与 CLI run-config 同源防漂移：src/lib/run-config.js 的 decision 段也委托本模块读取。
 * 缺省 enabled=false（不配置 = 关 = 旧上抛逻辑），仅接受布尔，非法值回落缺省。
 *
 * ## 边界
 * 只回答「闸门开没开」一个问题，不解析决策内容、不感知会话态。开与关的语义差异全部由
 * gate.cjs / handler.cjs 消费：关 = 完全沿用旧行为（AskUserQuestion 照常上抛、Stop 不拦截、
 * 不产生任何决策记录）；开 = 拦截并引导走决策内核。
 *
 * ## 为什么缺省关
 * 闸门会改写 Stop / AskUserQuestion 的控制流（拦截回合、注入决策指令），属侵入性行为；
 * 未显式配置的项目不应被它改变既有运行方式，故缺省 false，开启须在 .awf/config.json 显式声明。
 */
const fs = require('node:fs');
const path = require('node:path');

/** 决策闸门缺省关闭（单一来源，ESM/CJS 共用） */
const DECISION_DEFAULT_ENABLED = false;

/**
 * 从已解析的 raw（.awf/config.json 内容）判定 run.decision.enabled。
 * @param {object} raw
 * @returns {boolean} 仅接受布尔；缺省/非法回落 false
 */
function decisionEnabledFrom(raw) {
  return typeof raw?.run?.decision?.enabled === 'boolean' ? raw.run.decision.enabled : DECISION_DEFAULT_ENABLED;
}

/**
 * server/CLI 侧判定决策闸门是否开启：读 <projectRoot>/.awf/config.json。
 * 文件缺失 / 非法 JSON / 未配置 → false（与 CLI 同默认）。
 * @param {string} projectRoot - 用户项目根目录
 * @returns {boolean}
 */
function isDecisionEnabled(projectRoot) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(projectRoot, '.awf', 'config.json'), 'utf-8'));
  } catch {
    /* 缺失或非法 JSON → 用默认（关） */
  }
  return decisionEnabledFrom(raw);
}

module.exports = { isDecisionEnabled, decisionEnabledFrom, DECISION_DEFAULT_ENABLED };
