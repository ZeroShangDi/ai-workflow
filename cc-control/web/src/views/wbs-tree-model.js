// web/src/views/wbs-tree-model.js — WBS-Tree 视图模型（纯函数）。
// T1-090：把 open tree CLI 渲染（renderTree → .awf/w-tree.html，T1-066 已移除）的展示逻辑迁到 web（可单测）。
// 数据源：GET /awf/state 全量 state { wbs, tasks, plan }（wbs 节点 id 常引用任务 wbsRef）。
//
// 树的来源：state.wbs 在本架构中为「可交付节点」扁平表，父/子边不落盘（awf_wbs_create 无 children）。
// 本模型按优先级重建层次：节点声明 `children`（id 数组，兼容 awf-plan-wbs 的 WBS JSON 形态）→ 显式成边；
// 未声明边的节点一律作为根（平铺），顺序保持 state 原序——与旧 renderTree 对扁平 wbs 的
// `data.children || data` 兜底一致，不臆造父层。每个节点若被任务以 wbsRef 引用则携带任务状态。

/**
 * WBS 语义层级编号（id 形如 W1-001/W3-001 → 1/3；任务=1…项目=4；非法 → 0）。
 * @param {string} id
 */
export function levelOf(id) {
  const m = /^W(\d+)-/i.exec(String(id || ''));
  return m ? Number(m[1]) : 0;
}

/**
 * 由 state 构建 WBS 森林。
 * @param {{ wbs?: object[], tasks?: object[] }} src
 *   wbs:   GET /awf/state 的 wbs 数组（可带可选 children 声明，元素: id/name/title/desc/acceptance）
 *   tasks: 任务数组（wbsRef 命中节点时携带其状态/类型）
 * @returns {{ roots: object[], stats: object }} roots 平铺/嵌套节点；stats 汇总
 */
export function buildWbsTree({ wbs = [], tasks = [] } = {}) {
  const taskOf = {};
  for (const t of tasks) {
    const ref = t?.wbsRef;
    if (ref && !(ref in taskOf)) taskOf[ref] = t; // 每 WBS 节点取首个绑定任务
  }

  const nodeOf = new Map();
  const nodes = wbs.map((w) => {
    const node = {
      id: String(w?.id || ''),
      name: w?.name || w?.title || '(未命名)',
      desc: w?.desc || w?.description || null,
      acceptance: w?.acceptance || null,
      level: levelOf(w?.id),
      task: null,
      children: [],
    };
    if (node.id && taskOf[node.id]) {
      const t = taskOf[node.id];
      node.task = { id: t.id, kind: t.kind, status: t.status };
    }
    nodeOf.set(node.id, node);
    return node;
  });

  // 1) 显式 children 成边（先于兜底平铺；仅当父子 id 都在集内）
  const parented = new Set();
  for (const w of wbs) {
    if (!Array.isArray(w?.children) || !nodeOf.has(w.id)) continue;
    const parent = nodeOf.get(w.id);
    for (const childId of w.children) {
      const child = nodeOf.get(childId);
      if (child && !parented.has(child.id)) {
        parent.children.push(child);
        parented.add(child.id);
      }
    }
  }

  // 2) 未成边节点平铺为根（保持原序）
  const roots = [];
  for (const n of nodes) if (!parented.has(n.id)) roots.push(n);

  // 汇总（绑定到任务的节点计数 + 按状态分布）
  const stats = { total: nodes.length, withTask: 0, byStatus: {} };
  for (const n of nodes) {
    if (!n.task) continue;
    stats.withTask += 1;
    stats.byStatus[n.task.status] = (stats.byStatus[n.task.status] || 0) + 1;
  }
  return { roots, stats };
}
