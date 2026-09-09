'use strict';
/**
 * run-driver.cjs — 单 agent 阶段链驱动（纯规则，供 run/driver 迁入）
 *
 * 捕获 CLAUDE.md 文档化阶段链模型，作为把 cli runLoop 迁入 run 域（server 常驻 + oneshot 端口）
 * 的纯规则层；live 切换（cli run.js 实际改调 driver、prompt 经 oneshot 端口）由后续
 * run-domain 托管任务接线，本模块不改写现状。
 *
 *   STAGE_CHAINS：simple=DEV→COMMIT；medium=DEV→TEST→COMMIT；complex=DEV→DOCS→REVIEW→TEST→COMMIT
 *   decideChain(task)：按任务复杂度选链（门禁/文档/提交类给保守链，避免无谓门禁）
 *   STAGE_ORDER / nextStage / assertStage 供驱动循环推进
 */

const STAGE_CHAINS = {
  simple: ['DEV', 'COMMIT'],
  medium: ['DEV', 'TEST', 'COMMIT'],
  complex: ['DEV', 'DOCS', 'REVIEW', 'TEST', 'COMMIT'],
};

/** 门禁/文档/提交任务用保守链，不参与通用复杂分级 */
const SPECIAL_KIND_CHAIN = { review: 'simple', test: 'simple', doc: 'simple', commit: 'simple' };

/** 通用复杂度分级启发式：按计划改动面/依赖/约束粗分（可按实际收敛） */
function classifyComplexity(task = {}) {
  const files = task.plannedFiles?.length || 0;
  const deps = task.deps?.length || 0;
  const constraints = task.constraints?.length || 0;
  const score = files * 2 + deps + constraints;
  if (score >= 8) return 'complex';
  if (score >= 3) return 'medium';
  return 'simple';
}

/**
 * 选阶段链：门禁/文档/提交类走保守 simple；否则按复杂度。
 * @returns {{ chain: 'simple'|'medium'|'complex', stages: string[] }}
 */
function decideChain(task = {}) {
  if (SPECIAL_KIND_CHAIN[task.kind]) return { chain: SPECIAL_KIND_CHAIN[task.kind], stages: STAGE_CHAINS[SPECIAL_KIND_CHAIN[task.kind]] };
  const chain = classifyComplexity(task);
  return { chain, stages: STAGE_CHAINS[chain] };
}

/** 链内下一阶段（无 → null，链结束） */
function nextStage(stages, current) {
  const i = stages.indexOf(current);
  if (i < 0) throw new Error(`run-driver: 阶段 ${current} 不在链 ${stages.join('→')}`);
  return i + 1 < stages.length ? stages[i + 1] : null;
}

/** 断言阶段属于链（驱动推进前校验） */
function assertStage(stages, stage) {
  if (!stages.includes(stage)) throw new Error(`run-driver: 阶段 ${stage} 非法，链=${stages.join('→')}`);
}

/**
 * 门禁完成钩子锚点：任务完成 → 仅对门禁 kind（review/test）委托 gate 闭环（verdict→派生修复）。
 * 由调用方注入 handleGateCompletion（cli gate-fix），driver 只做过滤/编排——单/多 agent 收敛到同一锚点。
 * @param {string} projectRoot
 * @param {{ handleGateCompletion?: Function, kinds?: string[] }} deps
 */
function gateCompletionHook(projectRoot, { handleGateCompletion, kinds = ['review', 'test'] } = {}) {
  return async (id, task) => {
    if (!task || !kinds.includes(task.kind)) return false;
    if (typeof handleGateCompletion !== 'function') return false;
    await handleGateCompletion(projectRoot, id, task);
    return true;
  };
}

module.exports = { STAGE_CHAINS, classifyComplexity, decideChain, nextStage, assertStage, gateCompletionHook };
