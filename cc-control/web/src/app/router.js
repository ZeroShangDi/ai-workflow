import { getRoute } from './routes.js';
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
  };
}
export function routeUrl(route, currentUrl) {
  const url = new URL(currentUrl);
  url.pathname = '/';
  url.searchParams.set('view', getRoute(route.view, url.searchParams.get('mode')).key);
  for (const [key, value] of [
    ['p', route.project],
    ['runId', route.runId],
  ]) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  if (url.searchParams.get('mode') === 'dsh') url.searchParams.delete('p');
  // Legacy URLs keep their old slot semantics; explicit mode URLs carry platform identity.
  if (!url.searchParams.has('mode')) url.searchParams.delete('sid');
  return `${url.pathname}${url.search}${url.hash}`;
}
