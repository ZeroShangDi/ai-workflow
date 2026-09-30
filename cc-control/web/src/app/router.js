import { getRoute } from '@/app/routes.js';
export function readRoute(location) {
  const params = new URLSearchParams(location.search);
  const view =
    params.get('view') ||
    location.pathname
      .split('/')
      .pop()
      .replace(/\.html$/, '');
  return {
    view: getRoute(view, params.get('mode')).key,
    project: params.get('p'),
    runId: params.get('runId') || '',
    // 任务过滤（决策页用）：从任务列表的「有决策」标记点进来时带上，筛出该任务的决策
    task: params.get('task') || '',
  };
}
export function routeUrl(route, currentUrl) {
  const url = new URL(currentUrl);
  url.pathname = '/';
  url.searchParams.set('view', getRoute(route.view, url.searchParams.get('mode')).key);
  for (const [key, value] of [
    ['p', route.project],
    ['runId', route.runId],
    ['task', route.task],
  ]) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  if (url.searchParams.get('mode') === 'dsh') url.searchParams.delete('p');
  // Legacy URLs keep their old slot semantics; explicit mode URLs carry platform identity.
  if (!url.searchParams.has('mode')) url.searchParams.delete('sid');
  return `${url.pathname}${url.search}${url.hash}`;
}
