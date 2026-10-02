// A feature extension adds one route: navigation, loader and reads stay together.
export const ROUTES = [
  {
    key: 'run',
    label: '会话',
    icon: 'run',
    // decisions：Run 页只显示「本次产生了多少条决策、几条待复审」并跳转决策页，
    // 展示与复审的唯一入口在决策页（见 design/decision-redesign.md）。
    reads: ['state', 'decisions', 'logFiles'],
    snapshot: true,
    load: () => import('@/pages/Run/index.jsx'),
  },
  {
    key: 'tasks',
    label: '任务',
    icon: 'tasks',
    // decisions：任务列表要标出「哪些任务产生过决策」（归因字段 task_id），并支持点进决策页按任务筛
    reads: ['state', 'decisions'],
    load: () => import('@/pages/Tasks/index.jsx'),
  },
  {
    key: 'decisions',
    label: '决策',
    icon: 'decisions',
    reads: ['decisions'],
    load: () => import('@/pages/Decisions/index.jsx'),
  },
  {
    key: 'reviews',
    label: '动态任务',
    icon: 'reviews',
    reads: ['proposals'],
    load: () => import('@/pages/DynamicReview/index.jsx'),
  },
  {
    key: 'logs',
    label: '日志',
    icon: 'logs',
    reads: ['logFiles'],
    snapshot: true,
    load: () => import('@/pages/Logs/index.jsx'),
  },
  {
    key: 'diagnostics',
    label: '诊断',
    hidden: true,
    reads: [],
    load: () => import('@/pages/Diagnostics/index.jsx'),
  },
  {
    key: 'wbs-tree',
    label: 'WBS',
    hidden: true,
    reads: [],
    load: () => import('@/pages/WbsTree/index.jsx'),
  },
  // 三个 CLI 入口页（U4：先做空页面）。`awf open dashboard|tree|ui` 打开的就是它们。
  // 为什么要显式登记：路由表里没有这三个 key 时，`readRoute` 会**静默回退到会话页**——
  // 用户以为打开了新页面，看到的却是别处界面（假成功）。
  {
    key: 'dashboard',
    label: '总览',
    hidden: true,
    reads: [],
    placeholder: true,
    load: () => import('@/pages/Placeholder/index.jsx'),
  },
  {
    key: 'tree',
    label: '任务树',
    hidden: true,
    reads: [],
    placeholder: true,
    load: () => import('@/pages/Placeholder/index.jsx'),
  },
  {
    key: 'ui',
    label: '界面',
    hidden: true,
    reads: [],
    placeholder: true,
    load: () => import('@/pages/Placeholder/index.jsx'),
  },
];
// Both platform route sets live here; the conversation route is the cc fallback.
export const MODE_ROUTES = {
  cc: ROUTES,
  dsh: ['tasks', 'decisions', 'reviews', 'logs'].map(key =>
    ROUTES.find(route => route.key === key),
  ),
};
export const getRoutes = mode =>
  Object.hasOwn(MODE_ROUTES, mode) ? MODE_ROUTES[mode] : MODE_ROUTES.cc;
export const getViews = (mode, sessionKind) => {
  const routes = getRoutes(mode).filter(route => !route.hidden);
  if (mode === 'dsh') return routes;
  const session = routes.find(route => route.key === 'run');
  const tasks = routes.find(route => route.key === 'tasks');
  if (!sessionKind) return session ? [{ ...session, label: '会话' }] : routes;
  if (sessionKind === 'plan') return [
    ...(session ? [{ ...session, label: '会话' }] : []),
    ...(tasks ? [{ ...tasks, label: '任务' }] : []),
  ];
  const contextual = ['tasks', 'reviews', 'decisions', 'logs']
    .map(key => routes.find(route => route.key === key))
    .filter(Boolean)
    .map(route => route.key === 'reviews' ? { ...route, label: '动态任务' } : route);
  return [...(session ? [{ ...session, label: '会话' }] : []), ...contextual];
};
export const VIEWS = getViews('cc', 'plan');
export const getRoute = (key, mode) => {
  // Older links may still contain the removed Project/Plan page keys.
  if (['project', 'plan'].includes(key)) key = 'run';
  const routes = getRoutes(mode);
  return routes.find(route => route.key === key) || routes[0];
};
