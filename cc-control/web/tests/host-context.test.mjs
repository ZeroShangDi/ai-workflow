import test from 'node:test';
import assert from 'node:assert/strict';
import { readHostContext, acceptHostMessage, resolveProject } from '../src/shared/context.js';
import { getViews, getRoutes, ROUTES } from '../src/app/routes.js';
import { routeUrl, readRoute } from '../src/app/router.js';

test('DSH identity stays separate from project path and run identity', () => {
  const context = readHostContext({ search: '?mode=dsh&pid=workspace-1&sid=session-2&p=/wrong' });
  assert.deepEqual(context, { mode: 'dsh', pid: 'workspace-1', sid: 'session-2', projectRoot: null });
  assert.equal(resolveProject(context, [{ projectRoot: '/boot' }]), null);
  const url = new URL(routeUrl({ view: 'run', project: '/project', runId: '' }, 'http://localhost/?mode=dsh&pid=workspace-1&sid=session-2'), 'http://localhost');
  assert.equal(url.searchParams.get('sid'), 'session-2');
  assert.equal(url.searchParams.get('pid'), 'workspace-1');
  assert.equal(url.searchParams.has('p'), false);
  assert.equal(url.searchParams.has('runId'), false);
});

test('host context requires matching parent, origin and active session', () => {
  const parent = {}, origin = 'http://localhost:3080';
  const context = { mode: 'dsh', pid: 'w1', sid: 's1', projectRoot: null };
  const event = { source: parent, origin, data: { type: 'awf:context', ...context, projectRoot: '/my project' } };
  const options = { parent, origin, context };
  assert.equal(resolveProject(acceptHostMessage(event, options)), '/my project');
  assert.equal(acceptHostMessage({ ...event, source: {} }, options), null);
  assert.equal(acceptHostMessage({ ...event, origin: 'https://example.com' }, options), null);
  assert.equal(acceptHostMessage({ ...event, data: { ...event.data, sid: 'old-session' } }, options), null);
});

test('CC standalone supports legacy paths and explicit project IDs', () => {
  assert.equal(resolveProject(readHostContext({ search: '?p=%2Frepo' })), '/repo');
  assert.equal(resolveProject(readHostContext({ search: '?mode=cc&pid=p1&sid=s1' }), [{ projectId: 'p1', projectRoot: '/repo' }]), '/repo');
  assert.equal(resolveProject(readHostContext({ search: '?pid=unknown' }), [{ projectRoot: '/boot' }]), null);
});

test('DSH allows exactly four routes, including direct URL access', () => {
  const allowed = ['tasks', 'decisions', 'reviews', 'logs'];
  assert.deepEqual(getViews('dsh').map(v => v.key), allowed);
  for (const view of [...allowed, 'project', 'run', 'plan', 'diagnostics', 'wbs-tree', 'tree', 'unknown']) {
    const url = new URL(`http://localhost/?mode=dsh&pid=p1&sid=s1&view=${view}`);
    const expected = allowed.includes(view) ? view : 'tasks';
    assert.equal(readRoute(url).view, expected);
    const next = new URL(routeUrl({ view }, url.href), url);
    assert.equal(next.searchParams.get('view'), expected);
    assert.equal(next.searchParams.get('pid'), 'p1');
    assert.equal(next.searchParams.get('sid'), 's1');
  }
  assert.equal(readRoute(new URL('http://localhost/run.html?mode=dsh')).view, 'tasks');
});

test('unknown platforms retain the CC route set', () => {
  for (const mode of ['cc', undefined, 'future-platform', 'constructor', '__proto__']) {
    assert.equal(getRoutes(mode), ROUTES);
  }
});
