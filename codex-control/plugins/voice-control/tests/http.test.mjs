import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveReplayCursor } from '../src/http.mjs';

test('SSE reconnects prefer last-event-id over the cursor embedded in the URL', () => {
  const url = new URL('http://voice.test/api/sessions/vcs_1/events?after=0');
  assert.equal(resolveReplayCursor(url, { 'last-event-id': '12' }), '12');
  assert.equal(resolveReplayCursor(url, {}), '0');
  assert.equal(resolveReplayCursor(
    new URL('http://voice.test/api/sessions/vcs_1/events'),
    { 'last-event-id': '9' },
  ), '9');
});
