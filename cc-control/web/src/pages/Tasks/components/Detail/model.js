// 任务详情页的派生数据：只做「把 state 里已有的字段摊平成设计稿要的形状」。
// 不新增字段、不猜语义 —— 查不到的（依赖任务被删、WBS 项不在树里）就退回只显示 id。

/** 最近一次执行的时间戳：完成时间优先，未完成退回开始时间 */
export const execTime = task => task?.exec?.completedAt || task?.exec?.startedAt || '';

/**
 * 依赖任务：`deps` 只有 id，标题与状态要回任务列表里查。
 * 查不到（依赖已被删/不在当前 state）时 title 留空，行里只显示 id，不编造标题。
 */
export const resolveDeps = (task, tasks = []) =>
  (task?.deps || []).map(id => {
    const found = tasks.find(item => item?.id === id);
    return { id, title: found?.title || '', status: found?.status || '' };
  });

/** 关联规划：`wbsRef` → `state.wbs` 里的名字（wbs 是 `{id,name,desc,deps}[]`） */
export function resolveWbs(task, wbs) {
  const ref = task?.wbsRef;
  if (!ref) return null;
  const found = (Array.isArray(wbs) ? wbs : []).find(item => item?.id === ref);
  return { id: ref, name: found?.name || '' };
}

/**
 * `exec.architecture.path` 的展示映射。值域来自真实数据（extend / refactor-then-change /
 * remove / none / no-change），中文只是展示，未知值原样透出。
 */
const PATH_LABELS = {
  extend: '扩展',
  'refactor-then-change': '先重构再变更',
  remove: '移除',
  none: '无',
  'no-change': '无变更',
};

/** 架构判断里要展示的字段与顺序（设计稿五行）；其余键（reviewNote/scope/verdict…）不在详情里出现 */
const ARCH_FIELDS = [
  ['path', '实现路径'],
  ['boundary', '权威边界'],
  ['changeAxis', '变化轴'],
  ['boundaryChanged', '边界变更'],
  ['note', '关键取舍'],
];

const boolText = value => (value === true ? '是' : value === false ? '否' : null);

/** 架构判断的展示行：值为空的字段整行不出现（不显示「—」占位） */
export const archRows = architecture =>
  ARCH_FIELDS.map(([key, title]) => {
    const raw = architecture?.[key];
    const bool = boolText(raw);
    if (bool !== null) return { key, title, value: bool };
    if (raw === undefined || raw === null || raw === '') return null;
    const text = String(raw);
    if (key !== 'path') return { key, title, value: text };
    const zh = PATH_LABELS[text];
    return { key, title, value: zh ? `${zh}  /  ${text}` : text };
  }).filter(Boolean);
