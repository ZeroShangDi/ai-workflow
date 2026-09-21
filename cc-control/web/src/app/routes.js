// A feature extension adds one route: navigation, loader and reads stay together.
export const ROUTES = [
  { key: 'project', label: '项目', icon: 'tasks', reads: ['workspace'], load: () => import('../pages/Project/index.jsx') },
  { key: 'plan', label: 'Plan', icon: 'tasks', reads: ['workspace', 'state'], load: () => import('../pages/Plan/index.jsx') },
  { key: 'run', label: 'Run', icon: 'run', reads: ['state', 'conversation', 'sourceLog'], snapshot: true, load: () => import('../pages/Run/index.jsx') },
  { key: 'tasks', label: '任务', icon: 'tasks', reads: ['state'], load: () => import('../pages/Tasks/index.jsx') },
  { key: 'decisions', label: '决策', icon: 'decisions', reads: ['decisions'], load: () => import('../pages/Decisions/index.jsx') },
  { key: 'reviews', label: '动态复审', icon: 'decisions', reads: ['proposals'], load: () => import('../pages/DynamicReview/index.jsx') },
  { key: 'logs', label: '日志', icon: 'logs', reads: [], snapshot: true, load: () => import('../pages/Logs/index.jsx') },
  { key: 'diagnostics', label: '诊断', hidden: true, reads: [], load: () => import('../pages/Diagnostics/index.jsx') },
  { key: 'wbs-tree', label: 'WBS', hidden: true, reads: [], load: () => import('../pages/WbsTree/index.jsx') },
  // 三个 CLI 入口页（U4：先做空页面）。`awf open dashboard|tree|ui` 打开的就是它们。
  // 为什么要显式登记：路由表里没有这三个 key 时，`readRoute` 会**静默回退到第一页（项目）**——
  // 用户以为打开了新页面，看到的却是别处界面（假成功）。
  { key: 'dashboard', label: '总览', hidden: true, reads: [], placeholder: true, load: () => import('../pages/Placeholder/index.jsx') },
  { key: 'tree', label: '任务树', hidden: true, reads: [], placeholder: true, load: () => import('../pages/Placeholder/index.jsx') },
  { key: 'ui', label: '界面', hidden: true, reads: [], placeholder: true, load: () => import('../pages/Placeholder/index.jsx') },
];
// Both platform route sets live here; the first page is the fallback route.
export const MODE_ROUTES = {
  cc: ROUTES,
  dsh: ['tasks', 'decisions', 'reviews', 'logs'].map(key => ROUTES.find(route => route.key === key)),
};
export const getRoutes = mode => Object.hasOwn(MODE_ROUTES, mode) ? MODE_ROUTES[mode] : MODE_ROUTES.cc;
export const getViews = mode => getRoutes(mode).filter(route => !route.hidden);
export const VIEWS = getViews('cc');
export const getRoute = (key, mode) => {
  const routes = getRoutes(mode);
  return routes.find(route => route.key === key) || routes[0];
};
