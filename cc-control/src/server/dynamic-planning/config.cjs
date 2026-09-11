'use strict';

/** 动态任务规划执行策略。默认人工批准后应用，避免未配置项目自动改写既定规划。 */
const fs = require('node:fs');
const path = require('node:path');

const MODES = Object.freeze({
  AUTO_THEN_REVIEW: 'auto_then_review',
  APPROVE_THEN_APPLY: 'approve_then_apply',
});
const DEFAULT_MODE = MODES.APPROVE_THEN_APPLY;

function normalizeMode(value) {
  return Object.values(MODES).includes(value) ? value : DEFAULT_MODE;
}

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

function loadDynamicPlanningConfig(projectRoot) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(projectRoot, '.awf', 'config.json'), 'utf8'));
  } catch {
    // 缺失/非法配置使用安全默认值。
  }
  return dynamicPlanningConfigFrom(raw);
}

module.exports = { MODES, DEFAULT_MODE, normalizeMode, dynamicPlanningConfigFrom, loadDynamicPlanningConfig };
