import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WorkModeStore } from '../src/work-mode.mjs';

test('persists an explicit work mode for the next backend start', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-center-work-mode-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new WorkModeStore({ dataDir: directory });
  assert.equal(store.get(), 'none');
  assert.equal(store.set('control'), 'control');
  assert.equal(new WorkModeStore({ dataDir: directory }).get(), 'control');
  assert.throws(() => store.set('market'), /control or none/);
  assert.throws(() => store.set('invalid'), /control or none/);
});
