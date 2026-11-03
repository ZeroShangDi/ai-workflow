import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('optional memory is a no-op without configuration and bounds external failures', () => {
  const result = spawnSync(process.env.PYTHON || 'python3', [new URL('./memory.py', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
