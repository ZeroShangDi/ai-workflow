'use strict';
/**
 * gate/loop.cjs — 门禁闭环的**文案规则**（verdict → 修复目标）
 *
 * 把「门禁 verdict → 修复任务目标文案」的纯规则收敛到单一实现。分工：
 *   - 判定与派生（能不能派生、上限几轮、派生任务长什么样）→ ./closure.js
 *   - 提示词模板（gateFixPrompt）→ shared/prompts.js（插件声明，本模块零感知命令字面）
 *   - 本模块 → 只做「任务快照 → 文案」的纯映射
 *
 * 边界：本模块零 IO、零状态。
 */
const { REPORTS_PREFIX } = require('../../shared/project-paths.cjs'); // .awf 布局单源（报告目录前缀）

/**
 * 由门禁任务快照构造修复目标文案（纯规则，供派生修复提示词）。
 * @param {object} gate 门禁任务（含 exec.verdict / exec.architecture / exec.files）
 * @returns {string}
 */
function buildFixTarget(gate) {
  const v = gate.exec?.verdict;
  const architecture = gate.exec?.architecture;
  const reportPath = (gate.exec?.files || []).find((f) => f.startsWith(REPORTS_PREFIX)) || '';
  // 优先指向报告文件（里面逐条列了问题，对修复 Agent 最可执行）；无报告才退化为引用 verdict 结论。
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
