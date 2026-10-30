'use strict';
/**
 * config.cjs — 决策闸门开关判定（features/decision）
 *
 * **单一实现**：CLI 侧经 `decisionMode` 直接 require 本模块（旧树曾有第二份 `src/lib/decision-config.cjs`，
 * 随收口删除），故不存在「两边同步」的问题。
 * 开关 `run.decision.enabled` 缺省 false（不配置 = 关）；策略 `run.decision.mode` 取 manual | ai | auto，
 * 缺省由 enabled 反推（开 → ai，关 → auto）。非法值一律回落缺省。
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

/**
 * 决策策略三路由（新设计）：一个决策事件出现了，谁来决定？
 *   - manual —— 推给人（终端 / 前端页面），CLI 不抢答
 *   - ai     —— 交给决策内核（AskUserQuestion 直接被门阀 deny，引导走 <AWF_DECISION_REQUIRED>）
 *   - auto   —— 默认选第一项（无人值守 / CI 场景）
 *
 * 与 decisionEnabled 的关系：enabled 是**门阀开关**（Stop 那扇门），mode 是**谁来答**。
 * 缺省 auto 是对「旧 CLI 对 AskUserQuestion 一律 5s 自动选第一项」这一既有行为的保真。
 * 注：新设计契约（docs/design/cc-work-api-contract.ts）目前只列了 manual | ai 两值，
 *     第三值 auto 由用户口述补充，待契约同步。
 */
const DECISION_MODES = Object.freeze(['manual', 'ai', 'auto']);

/** 从已解析的 raw（.awf/config.json 内容）判定决策策略；非法/缺省 → enabled 为真则 ai，否则 auto */
function decisionModeFrom(raw) {
  const mode = raw?.run?.decision?.mode;
  if (DECISION_MODES.includes(mode)) return mode;
  return decisionEnabledFrom(raw) ? 'ai' : 'auto';
}

/** 读 <projectRoot>/.awf/config.json 判定决策策略（缺文件/非法 → 缺省） */
function decisionMode(projectRoot) {
  const raw = readJsonFile(configFilePath(projectRoot), { optional: true });
  return decisionModeFrom(raw ?? {});
}

module.exports = {
  isDecisionEnabled, decisionEnabledFrom, decisionMode, decisionModeFrom,
  DECISION_MODES, DECISION_DEFAULT_ENABLED,
};
