import { getRoute } from './routes.js';
export function readRoute(location) {
  const params = new URLSearchParams(location.search);
  const view = params.get('view') || location.pathname.split('/').pop().replace(/\.html$/, '');
  return { view: getRoute(view).key, project: params.get('p'), runId: params.get('runId') || '' };
}
export function routeUrl(route, currentUrl) {
  const url = new URL(currentUrl);
  url.pathname = '/';
  url.searchParams.set('view', getRoute(route.view).key);
  for (const [key, value] of [['p', route.project], ['runId', route.runId]]) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  // sid is a server session slot, not a run id.
  url.searchParams.delete('sid');
  return `${url.pathname}${url.search}${url.hash}`;
}
