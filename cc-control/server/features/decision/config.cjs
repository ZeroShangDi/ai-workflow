'use strict';
/**
 * config.cjs — 决策闸门开关判定（features/decision）
 *
 * 新 server 树与 cli 树**各有一份实现**（server 与 cli 隔离、不共享代码，理由同 shared/prompts.js）：
 * 旧树那份在 src/lib/decision-config.cjs（由 src/lib/run-config.js 消费），两边读同一个字段
 * `run.decision.enabled`，语义以本文件为准，改动需两边同步（默认值、仅接受布尔、非法回落缺省）。
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
// .awf/config.json 的读取形状（路径 + 容错语义）由项目配置约定决定，是外部形状 ——
// 经共享原语读，本模块只管「decision 段的字段语义」。
const { readJsonFile } = require('../../shared/config-loader.cjs');
const { configFilePath } = require('../../shared/project-paths.cjs'); // .awf 布局单源

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
  // optional：文件缺失 / 非法 JSON → null（用默认「关」），与 CLI 同默认
  const raw = readJsonFile(configFilePath(projectRoot), { optional: true });
  return decisionEnabledFrom(raw ?? {});
}

module.exports = { isDecisionEnabled, decisionEnabledFrom, DECISION_DEFAULT_ENABLED };
