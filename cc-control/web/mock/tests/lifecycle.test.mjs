import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer } from '../server.js';
import { SCENARIOS, PROJECT_ROOTS } from '../fixtures.js';
import { projectLog } from '../logs/project-log.js';
function harness(scenario = 'empty') {
  const server = createMockServer({ scenario }); let root = PROJECT_ROOTS[0];
  return { server, get: path => server.handle(`${path}${path.includes('?') ? '&' : '?'}p=${encodeURIComponent(root)}`).body,
    post: (path, body = {}) => server.handle(`${path}?p=${encodeURIComponent(root)}`, { method: 'POST', body }),
    select: value => { root = value; }, tick: (n = 1) => { for (let i = 0; i < n; i++) server.advance(); } };
}
test('complete timeline: empty → directory → environment → requirement → editable plan → run → decision → applied task → done', () => {
  const h = harness(); assert.deepEqual(h.server.handle('/status').body.projects, []);
  assert.equal(h.server.handle('/projects/directories').body.directories.length, 3);
  assert.equal(h.post('/projects/open', { path: '/mock/new-product' }).status, 201); h.select('/mock/new-product');
  assert.equal(h.get('/workspace').environment.status, 'reading');
  assert.equal(h.post('/requirements', { text: 'x' }).status, 409); h.tick(2);
  assert.equal(h.get('/workspace').environment.status, 'ready');
  assert.equal(h.post('/requirements', { text: '实现搜索及筛选' }).status, 201);
  assert.equal(h.post('/run/submit', { runId: 'too-early' }).status, 409);
  assert.equal(h.post('/plan/generate').status, 202); assert.equal(h.post('/plan/generate').status, 409); h.tick(2);
  const plan = h.get('/workspace').plan; assert.equal(plan.status, 'ready');
  plan.tasks[0].title = '确认搜索范围';
  assert.equal(h.post('/plan/save', { ...plan, summary: '搜索体验' }).status, 200);
  assert.equal(h.post('/plan/approve', { version: plan.version }).status, 409);
  assert.equal(h.post('/plan/approve', { version: plan.version + 1 }).status, 200);
  assert.equal(h.get('/awf/state').tasks[0].title, '确认搜索范围');
  assert.equal(h.post('/run/submit', { runId: 'journey' }).status, 202); h.tick(8);
  const proposal = h.get('/awf/dynamic-planning/proposals').proposals[0]; assert.equal(proposal.status, 'decision_required');
  assert.equal(h.get('/awf/state').mode, 'pause');
  assert.equal(h.post(`/awf/decisions/${proposal.decision.decisionId}/resolve`, { reviewer: '验收人', outcome: 'approve' }).status, 200);
  assert.equal(h.get('/awf/state').mode, 'run'); h.tick(40);
  assert.equal(h.get('/run/status').runs.at(-1).status, 'done');
  assert.ok(h.get('/awf/state').tasks.every(t => t.status === 'done'));
  assert.ok(h.get('/conversation').messages.some(m => m.type === 'decision'));
  const events = h.get('/run/events?limit=500').events;
  for (const type of ['environment.ready', 'requirement.created', 'plan.ready', 'plan.approved', 'decision.requested', 'dynamic_planning.applied', 'run.stopped']) assert.ok(events.some(e => e.type === type), type);
  assert.equal(new Set(events.map(e => e.seq)).size, events.length);
});
test('environment read failure is visible and retry succeeds; existing directory restores tasks', () => {
  const h = harness(); h.post('/projects/open', { path: '/mock/unreadable' }); h.select('/mock/unreadable'); h.tick(2);
  assert.equal(h.get('/workspace').environment.status, 'failed');
  h.post('/workspace/environment/read'); h.tick(2); assert.equal(h.get('/workspace').environment.status, 'ready');
  h.post('/projects/open', { path: '/mock/cc-work' }); h.select('/mock/cc-work'); h.tick(2);
  assert.ok(h.get('/awf/state').tasks.length); assert.ok(h.get('/awf/decisions').decisions.length);
});
test('plan validates drafts without mutating on invalid or cyclic dependencies; failed generation retries', () => {
  const h = harness('plan-error'); h.post('/plan/generate'); h.tick(2); const plan = h.get('/workspace').plan;
  const copy = structuredClone(plan); copy.tasks[0].deps = [copy.tasks[1].id];
  assert.equal(h.post('/plan/save', copy).status, 400); assert.deepEqual(h.get('/workspace').plan, plan);
  copy.tasks[0].deps = []; copy.tasks[0].title = '  '; assert.equal(h.post('/plan/save', copy).status, 400);
});
test('failed/cancelled runs retry with new identity, preserving history; blocked task can resume', () => {
  const h = harness('failed'), old = h.get('/run/status').runs[0];
  const retried = h.post(`/run/${old.runId}/retry`); assert.equal(retried.status, 202); assert.notEqual(retried.body.runId, old.runId);
  assert.equal(h.get('/run/status').runs[0].status, 'failed');
  assert.equal(h.post(`/run/${retried.body.runId}/cancel`).status, 200); assert.equal(h.post(`/run/${retried.body.runId}/cancel`).status, 409);
  const blocked = harness('blocked'), task = blocked.get('/awf/state').tasks.find(t => t.status === 'blocked');
  assert.equal(blocked.post(`/tasks/${task.id}/unblock`).status, 200); blocked.post('/run/state/mode', { mode: 'run' }); blocked.tick(3);
  assert.ok(blocked.get('/awf/state').tasks.some(t => t.status === 'active'));
});
test('decisions adopt or atomically replace; proposals approve, review, recover, and reject replacement emptiness', () => {
  const h = harness('demo'); assert.equal(h.post('/awf/decisions/D-008/adopt').status, 200); assert.equal(h.post('/awf/decisions/D-008/adopt').status, 409);
  assert.equal(h.post('/awf/decisions/D-007/override', { instruction: '补充验证' }).status, 200);
  assert.equal(h.post('/awf/decisions/D-007/override', { instruction: '重复' }).status, 409);
  const base = '/run/dynamic-planning/proposals/';
  const count = h.get('/awf/state').tasks.length;
  assert.equal(h.post(base + 'P-002/alternative', { reviewer: 'test', instruction: ' ' }).status, 400);
  assert.equal(h.get('/awf/state').tasks.length, count);
  assert.equal(h.post(base + 'P-002/alternative', { reviewer: 'test', instruction: '改为独立验证' }).status, 200);
  assert.equal(h.get('/awf/state').tasks.length, count + 1);
  assert.ok(h.get('/awf/decisions').decisions.some(d => d.decision_id === 'D-010' && d.event === 'decision_overridden'));
  assert.equal(h.post(base + 'P-003/review', { reviewer: 'test' }).body.proposal.status, 'applied');
  const conflict = harness('conflict'); assert.equal(conflict.post(base + 'P-001/approve', { reviewer: 'test' }).body.proposal.status, 'conflicted');
  assert.equal(conflict.post(base + 'P-001/retry', { reviewer: 'test' }).body.proposal.status, 'awaiting_approval');
  assert.equal(conflict.post(base + 'P-001/approve', { reviewer: 'test' }).body.proposal.status, 'applied');
});
test('all scenario payloads are readable and isolated; source log is authentic static data', () => {
  for (const scenario of SCENARIOS.filter(s => !['empty', 'error'].includes(s))) {
    const h = harness(scenario); for (const path of ['/workspace', '/conversation', '/logs/source', '/awf/state', '/run/status']) assert.notEqual(h.get(path).ok, false, scenario + path);
  }
  const h = harness('demo'); h.post('/send', { text: '消息隔离' }); h.tick();
  assert.ok(h.get('/conversation').messages.some(m => m.text === '消息隔离'));
  h.select(PROJECT_ROOTS[1]); assert.equal(h.get('/conversation').messages.length, 0);
  assert.equal(h.get('/logs/source').text, projectLog.text);
  assert.ok(projectLog.text.trim().split('\n').every(line => JSON.parse(line).event));
});
test('queued runs start on advance; outage recovery and invalid choices preserve state', () => {
  const q = harness('queued'); assert.equal(q.get('/run/status').runs[0].status, 'queued'); q.tick(); assert.equal(q.get('/run/status').runs[0].status, 'running');
  const h = harness('error'); assert.equal(h.get('/workspace').ok, false); h.server.recover(); assert.equal(h.get('/workspace').ok, true);
  const w = harness('waiting'); assert.equal(w.post('/respond', { value: '999' }).status, 400); assert.ok(w.get('/status').decisionPending);
  w.post('/respond', { value: '1' }); w.post('/stop'); const messages = w.get('/conversation').messages; w.tick(); assert.equal(w.get('/conversation').messages.length, messages.length);
});
