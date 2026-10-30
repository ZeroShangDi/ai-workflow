import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer } from '../server.js';
import { PROJECT_ROOTS } from '../fixtures.js';
import { API } from '@/shared/api/index.js';
import { routeUrl, readRoute } from '@/app/router.js';
import { createApiClient } from '@/shared/lib/http.js';
const url = path => {
  const u = new URL(path, 'http://mock');
  u.searchParams.set('p', PROJECT_ROOTS[0]);
  return u.href;
};
test('all read endpoints are implemented; unknown routes cannot reach a live server', () => {
  const server = createMockServer();
  for (const key of [
    'status',
    'snapshot',
    'state',
    'runs',
    'events',
    'decisions',
    'proposals',
    'metrics',
    'diagnostics',
  ])
    assert.equal(server.handle(url(API[key])).status, 200, key);
  assert.equal(server.handle(url('/unknown')).status, 404);
});
test('pause prevents progression, resume advances tasks and cursor events', () => {
  const s = createMockServer();
  const get = path => s.handle(url(path)).body;
  const post = body => s.handle(url(API.workflowMode), { method: 'POST', body });
  post({ mode: 'pause' });
  const before = get(API.state).tasks;
  for (let i = 0; i < 3; i++) s.advance();
  assert.deepEqual(get(API.state).tasks, before);
  post({ mode: 'run' });
  for (let i = 0; i < 3; i++) s.advance();
  assert.ok(
    get(API.state).tasks.filter(t => t.status === 'done').length >
      before.filter(t => t.status === 'done').length,
  );
  const first = get(API.eventPage(0, 2));
  assert.equal(first.events.length, 2);
  assert.ok(get(API.eventPage(first.afterSeq)).events.every(e => e.seq > first.afterSeq));
});
test('approval validates reviewer and updates proposal and tasks', () => {
  const s = createMockServer();
  const path = url(API.approveProposal('P-001'));
  assert.notEqual(s.handle(path, { method: 'POST', body: {} }).status, 200);
  const result = s.handle(path, { method: 'POST', body: { reviewer: 'web-reviewer' } });
  assert.equal(result.body.ok, true);
  assert.ok(s.handle(url(API.state)).body.tasks.some(t => t.source === 'dynamic_planning'));
});
test('scenarios isolate empty, waiting and service failures', () => {
  assert.deepEqual(createMockServer({ scenario: 'empty' }).handle('/status').body.projects, []);
  assert.ok(createMockServer({ scenario: 'waiting' }).handle(url(API.status)).body.decisionPending);
  assert.equal(createMockServer({ scenario: 'error' }).handle(url(API.state)).status, 503);
});
test('navigation preserves preview parameters and clears old session routing', () => {
  const path = routeUrl(
    { view: 'tasks', project: '/a b', runId: 'R1' },
    'http://mock/?mock=1&scenario=empty&sid=old',
  );
  const result = new URL(path, 'http://mock');
  assert.equal(result.searchParams.get('mock'), '1');
  assert.equal(result.searchParams.has('sid'), false);
  assert.deepEqual(readRoute(result), { view: 'tasks', project: '/a b', runId: 'R1' });
});
test('transport scopes requests and normalizes HTTP errors', async () => {
  const client = createApiClient({
    base: 'http://mock',
    project: '/safe',
    httpFetch: async input => {
      assert.equal(new URL(input).searchParams.get('p'), '/safe');
      return new Response('{"error":"conflict"}', { status: 409 });
    },
  });
  assert.deepEqual(await client.post('/send?p=other', { text: 'hello' }), {
    ok: false,
    error: 'conflict',
  });
});
test('remaining writes: start, reply, interrupt, override, resolve, diagnosis', () => {
  const s = createMockServer({ scenario: 'idle' }),
    post = (server, path, body = {}) => server.handle(url(path), { method: 'POST', body });
  assert.equal(post(s, API.submitRun, { runId: 'test-run' }).status, 202);
  assert.equal(post(s, API.submitRun, { runId: 'duplicate' }).status, 409);
  assert.equal(post(s, API.send, { text: 'hello' }).body.ok, true);
  assert.equal(post(s, API.send, { text: 'busy' }).status, 409);
  assert.equal(post(s, API.stop).body.ok, true);
  assert.equal(post(s, API.overrideDecision('D-008'), { instruction: '验证边界' }).body.ok, true);
  assert.equal(
    post(s, API.resolveDecision('D-010'), { reviewer: 'test', outcome: 'approve' }).body.ok,
    true,
  );
  assert.equal(post(s, API.diagnostics).status, 202);
  s.advance();
  assert.equal(s.handle(url(API.diagnostics)).body.diagnosis.status, 'complete');
  const waiting = createMockServer({ scenario: 'waiting' });
  assert.equal(post(waiting, API.respond, { value: '1' }).body.ok, true);
  assert.equal(waiting.handle(url(API.status)).body.decisionPending, null);
  const conflict = createMockServer({ scenario: 'conflict' });
  assert.equal(
    post(conflict, API.approveProposal('P-001'), { reviewer: 'test' }).body.proposal.status,
    'conflicted',
  );
});
import { matrixCells } from '@/shared/components/business/Overview/model.js';
test('matrix bounds cells and preserves all task counts including aggregates', () => {
  for (const tasks of [
    Array.from({ length: 30 }, (_, i) => ({ id: i, status: 'active' })),
    Array.from({ length: 30 }, (_, i) => ({
      id: i,
      status: i < 8 ? 'done' : i < 12 ? 'active' : 'pending',
    })),
  ]) {
    const cells = matrixCells(tasks);
    assert.ok(cells.length <= 16);
    assert.equal(
      cells.reduce((sum, t) => sum + t.count, 0),
      tasks.length,
    );
  }
});
test('timeout aborts transport; writes are not retried', async () => {
  let calls = 0;
  const client = createApiClient({
    httpFetch: (_, { signal }) =>
      new Promise((resolve, reject) => {
        calls++;
        signal.addEventListener('abort', () => reject(signal.reason));
      }),
  });
  await assert.rejects(client.post('/send', { text: 'x' }, { timeoutMs: 10 }), /超时/);
  assert.equal(calls, 1);
});
