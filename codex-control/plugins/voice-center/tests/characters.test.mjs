import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('built-in character module owns catalog, resources and private atomic selection without providers', () => {
  const result = spawnSync(process.env.PYTHON || 'python3',
    [new URL('./characters.py', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
