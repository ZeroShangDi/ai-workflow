// A feature extension adds one route: navigation, loader and reads stay together.
export const ROUTES = [
  { key: 'run', label: 'Run', icon: 'run', reads: ['state'], snapshot: true, load: () => import('../pages/Run/index.jsx') },
  { key: 'tasks', label: '任务', icon: 'tasks', reads: ['state'], load: () => import('../pages/Tasks/index.jsx') },
  { key: 'decisions', label: '决策', icon: 'decisions', reads: ['decisions'], load: () => import('../pages/Decisions/index.jsx') },
  { key: 'reviews', label: '动态复审', icon: 'decisions', reads: ['proposals'], load: () => import('../pages/DynamicReview/index.jsx') },
  { key: 'logs', label: '日志', icon: 'logs', reads: [], snapshot: true, load: () => import('../pages/Logs/index.jsx') },
  { key: 'diagnostics', label: '诊断', hidden: true, reads: [], load: () => import('../pages/Diagnostics/index.jsx') },
  { key: 'wbs-tree', label: 'WBS', hidden: true, reads: [], load: () => import('../pages/WbsTree/index.jsx') },
];
export const VIEWS = ROUTES.filter(route => !route.hidden);
export const getRoute = key => ROUTES.find(route => route.key === key) || ROUTES[0];
