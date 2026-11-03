import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createVoiceHttpServer } from '../src/http.mjs';

test('Qwen protocol, host authorization and playback lifecycle work without credentials', () => {
  const result = spawnSync(process.env.PYTHON || 'python3',
    [new URL('./realtime-qwen.py', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('the browser adapter is served as a module under the existing same-origin policy', async (t) => {
  const server = createVoiceHttpServer({ app: {}, onError() {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/realtime-qwen.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.match(await response.text(), /export function createRealtimeAudio/);
  const denied = await fetch(`${base}/realtime-qwen.js`, { headers: { Origin: 'https://untrusted.example' } });
  assert.equal(denied.status, 403);
});
