import assert from 'node:assert/strict';
import test from 'node:test';

import { isSessionId, parseSseBlock } from '../src/adapters/cmb.mjs';

test('parses JSON state events', () => {
  const value = parseSseBlock('id: 12\nevent: state\ndata: {"status":"active"}');
  assert.deepEqual(value, { event: 'state', data: { status: 'active' } });
});

test('ignores heartbeat blocks', () => {
  assert.equal(parseSseBlock(': heartbeat'), null);
});

test('joins multiline event data', () => {
  const value = parseSseBlock('event: note\ndata: first\ndata: second');
  assert.deepEqual(value, { event: 'note', data: 'first\nsecond' });
});

test('accepts UUIDv7 CMB session identifiers', () => {
  assert.equal(isSessionId('01a18b03-9d91-7331-9476-23622ace3710'), true);
  assert.equal(isSessionId('not-a-session'), false);
});
