import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TriggerConfigStore, validateTriggerConfig } from '../src/config.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-center-config-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('defaults to no triggers and persists explicit configuration privately', () => {
  const file = path.join(root, 'config.json');
  const store = new TriggerConfigStore({ filePath: file });
  assert.deepEqual(store.load().triggers, []);

  const saved = store.replace({
    schemaVersion: 1,
    triggers: [{
      id: 'trusted-host',
      enabled: true,
      topics: ['task.completed', 'task.failed'],
      description: 'test only',
    }],
  });
  assert.equal(saved.triggers[0].enabled, true);
  assert.match(saved.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(fs.statSync(file).mode & 0o077, 0);

  const reloaded = new TriggerConfigStore({ filePath: file });
  assert.deepEqual(reloaded.load().triggers, saved.triggers);
  saved.triggers[0].topics.push('mutated');
  assert.deepEqual(store.snapshot().triggers[0].topics, ['task.completed', 'task.failed']);
});

test('rejects unknown keys, duplicate ids, and empty topic subscriptions', () => {
  assert.throws(
    () => validateTriggerConfig({ schemaVersion: 1, triggers: [], extra: true }),
    /Unknown trigger configuration keys/,
  );
  assert.throws(
    () => validateTriggerConfig({
      schemaVersion: 1,
      triggers: [
        { id: 'same', enabled: true, topics: ['task.completed'] },
        { id: 'same', enabled: false, topics: ['task.failed'] },
      ],
    }),
    /Duplicate trigger id/,
  );
  assert.throws(
    () => validateTriggerConfig({
      schemaVersion: 1,
      triggers: [{ id: 'empty', enabled: true, topics: [] }],
    }),
    /must contain at least one topic/,
  );
});
