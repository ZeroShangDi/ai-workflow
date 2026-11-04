import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('Work Control trusts only host transcripts and never replays unknown writes', () => {
  const result = spawnSync(process.env.PYTHON || 'python3', [new URL('./work-control.py', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
