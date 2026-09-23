// 任务来源：server 既有字段 `task.source`，值域 gate_fix | dynamic_planning，字段缺失 = 来自初始规划。
// 沿用这个字段而不是另开一个 `origin`——planner 的 insert_task 早在写 dynamic_planning 了，
// 两个来源字段必然会不一致。动态「编辑」不计入：改过字段的任务仍然是原计划，来源只回答「谁创建了它」。
//
// server 写字段之前，门禁派生用 ID 约定兜底：id 形如 `<gateId>-F<recheck>`
// （见 server/features/gate/closure.js）。dynamic_planning 没有约定可依，只能等字段。
export const TASK_SOURCES = ['plan', 'gate_fix', 'dynamic_planning'];
const SOURCE_LABELS = {
  plan: '原计划',
  gate_fix: '门禁回退派生',
  dynamic_planning: '运行期动态规划',
};
const SOURCE_SHORT = { plan: '原计划', gate_fix: '门禁派生', dynamic_planning: '动态规划' };
export const sourceOf = task =>
  task?.source || (/-F\d+$/.test(task?.id || '') ? 'gate_fix' : 'plan');
// 未知来源原样透出，不静默归到「原计划」——免得把新来源伪装成老来源。
export const sourceLabel = value => SOURCE_LABELS[value] || value || SOURCE_LABELS.plan;
export const sourceShort = value => SOURCE_SHORT[value] || value || SOURCE_SHORT.plan;
/** 门禁派生任务的触发门禁 id（`T3-009-F1` → `T3-009`）；不符合约定时返回 null。 */
export const gateOf = task => {
  const id = task?.id || '';
  return /-F\d+$/.test(id) ? id.replace(/-F\d+$/, '') : null;
};
