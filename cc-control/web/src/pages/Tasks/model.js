// 任务来源（origin）：server 端 `origin` 字段，三值 plan | gate-fix | dynamic。
// 动态「编辑」不计入 —— 改过字段的任务仍是原计划，来源只有「谁创建了它」。
//
// 字段缺失一律按 `plan` 处理，所以老 state.json 零迁移。
// server 补上字段之前用 ID 约定兜底：门禁回退派生的 id 形如 `<gateId>-F<recheck>`
// （见 server/features/gate/closure.js），这类已经能识别；`dynamic` 只能等 server。
export const TASK_ORIGINS = ['plan', 'gate-fix', 'dynamic'];
const ORIGIN_LABELS = { plan: '原计划', 'gate-fix': '门禁回退派生', dynamic: '运行期动态规划' };
const ORIGIN_SHORT = { plan: '原计划', 'gate-fix': '门禁派生', dynamic: '动态规划' };
export const originOf = task => task?.origin || (/-F\d+$/.test(task?.id || '') ? 'gate-fix' : 'plan');
export const originLabel = value => ORIGIN_LABELS[value] || ORIGIN_LABELS.plan;
export const originShort = value => ORIGIN_SHORT[value] || ORIGIN_SHORT.plan;
/** 门禁派生任务的触发门禁 id（`T3-009-F1` → `T3-009`）；不符合约定时返回 null。 */
export const gateOf = task => {
  const id = task?.id || '';
  return /-F\d+$/.test(id) ? id.replace(/-F\d+$/, '') : null;
};
