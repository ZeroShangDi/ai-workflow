import assert from 'node:assert/strict';
import test from 'node:test';

import { createVoiceHttpServer, resolveReplayCursor } from '../src/http.mjs';

test('SSE reconnects prefer last-event-id over the cursor embedded in the URL', () => {
  const url = new URL('http://voice.test/api/sessions/vcs_1/events?after=0');
  assert.equal(resolveReplayCursor(url, { 'last-event-id': '12' }), '12');
  assert.equal(resolveReplayCursor(url, {}), '0');
  assert.equal(resolveReplayCursor(
    new URL('http://voice.test/api/sessions/vcs_1/events'),
    { 'last-event-id': '9' },
  ), '9');
});


test('cross-origin pages cannot change work mode or invoke model calls', async (t) => {
  let writes = 0;
  const server = createVoiceHttpServer({
    app: {},
    workModeStore: { set() { writes += 1; return 'control'; } },
    onError() {},
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/config/work-mode`, {
    method: 'PUT',
    headers: { Origin: 'https://untrusted.example', 'Content-Type': 'text/plain' },
    body: JSON.stringify({ mode: 'control' }),
  });
  assert.equal(response.status, 403);
  assert.equal(writes, 0);
  const local = await fetch(`${base}/api/config/work-mode`, {
    method: 'PUT',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'control' }),
  });
  assert.equal(local.status, 200);
  assert.equal(writes, 1);
});
