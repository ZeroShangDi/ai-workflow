'use strict';
/**
 * gate-loop.cjs — 门禁闭环规则（verdict → 修复目标）归位（供 cli gate-fix 与后续 run 域复用）
 *
 * 把「门禁 verdict → 修复任务目标文案」的纯规则从 cli/gate-fix.js（现 src/server/gate-fix.js）收敛到 lib，
 * 单一实现；派发（spawnGateFixTask）、元判定（gateFixMeta/MAX_RECHECK，state.js）与
 * 提示词模板（plugin-bridge.gateFixPrompt）仍在各自边界。
 */

/**
 * 由门禁任务快照构造修复目标文案（纯规则，供派生修复提示词）。
 * @param {object} gate 门禁任务（含 exec.verdict / exec.architecture / exec.files）
 * @returns {string}
 */
function buildFixTarget(gate) {
  const v = gate.exec?.verdict;
  const architecture = gate.exec?.architecture;
  const reportPath = (gate.exec?.files || []).find((f) => f.startsWith('.awf/reports/')) || '';
  let target = reportPath
    ? `修复门禁 ${gate.id} 报告 ${reportPath} 中列出的全部问题。`
    : `修复门禁 ${gate.id} 判定中列出的问题：${v?.conclusion || v?.level || ''}。`;
  if (architecture?.note || architecture?.boundary) {
    target += ` 架构修复要求：变化轴=${architecture.changeAxis || '未说明'}；期望边界=${architecture.boundary || '未说明'}；路径=${architecture.path || '未说明'}；${architecture.note || ''}`;
  }
  return target;
}

/** 门禁判定非 pass 的可复审摘要（verdict.level + conclusion，供日志/展示） */
function verdictSummary(gate) {
  const v = gate?.exec?.verdict;
  if (!v?.level) return null;
  return `${v.level}${v.conclusion ? `：${v.conclusion}` : ''}`;
}

module.exports = { buildFixTarget, verdictSummary };
