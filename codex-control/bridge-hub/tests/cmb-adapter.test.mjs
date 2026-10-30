import assert from 'node:assert/strict';
import test from 'node:test';

import { CmbAdapter, parseSseBlock, readSse } from '../src/cmb-adapter.mjs';
import { startMockCmb } from './helpers.mjs';

test('CMB adapter uses public login, session, view, send, and SSE HTTP contracts', async (t) => {
  const cmb = await startMockCmb();
  t.after(cmb.close);
  const adapter = new CmbAdapter({
    baseUrl: cmb.baseUrl,
    username: 'admin',
    password: 'test-password',
    timeoutMs: 2000,
  });

  const status = await adapter.status();
  assert.equal(status.authenticated, true);
  assert.equal(status.instanceId, 'mock-instance');

  const sessions = await adapter.sessions({ query: 'Mock', limit: 5 });
  assert.equal(sessions.sessions[0].title, 'Mock chat');
  assert.match(cmb.state.readCalls[0].query, /source=all/);

  const view = await adapter.view('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal(view.status, 'idle');

  const receipt = await adapter.send('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', {
    text: 'hello',
    requestId: 'request-1',
  });
  assert.equal(receipt.status, 'accepted');
  assert.equal(cmb.state.sendCalls[0].text, 'hello');
  assert.equal(cmb.state.sendCalls[0].mode, 'send');

  cmb.state.sessionExpired = true;
  const stream = await adapter.openEvents('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  const events = [];
  for await (const event of readSse(stream)) events.push(event);
  assert.deepEqual(events, [{
    id: null,
    event: 'state',
    data: { status: 'active', connected: true },
  }]);
  assert.equal(cmb.state.loginCount, 2);
});

test('SSE parser handles heartbeat, multiline data, and ids', () => {
  assert.equal(parseSseBlock(': heartbeat'), null);
  assert.deepEqual(
    parseSseBlock('id: 12\nevent: state\ndata: {"ok":\ndata: true}'),
    { id: '12', event: 'state', data: { ok: true } },
  );
});

test('CMB write failures are classified as unknown without automatic retry', async (t) => {
  const cmb = await startMockCmb();
  t.after(cmb.close);
  cmb.state.sendMode = 'unknown';
  const adapter = new CmbAdapter({
    baseUrl: cmb.baseUrl,
    username: 'admin',
    password: 'test-password',
    timeoutMs: 2000,
  });
  await assert.rejects(
    adapter.send('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', { text: 'will fail' }),
    (error) => error.unknown === true && /synthetic upstream failure/.test(error.message),
  );
  assert.equal(cmb.state.sendCount, 1);
});
