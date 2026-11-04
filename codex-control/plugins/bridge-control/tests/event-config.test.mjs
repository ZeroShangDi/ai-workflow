import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDirectBackend } from '../src/direct-backend.mjs';

test('control backend switches its task ledger to loaded event files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'control-event-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const taskFile = path.join(root, 'events', 'task-events.jsonl');
  const published = [];
  const backend = createDirectBackend({
    cmb: {
      baseUrl: 'http://127.0.0.1:1',
      username: 'unused',
      password: 'unused',
      timeoutMs: 1000,
    },
    dataDir: path.join(root, 'data'),
  }, {
    publishEvent: (event) => published.push(event),
  });
  t.after(() => backend.close());

  const applied = backend.configureEventFiles({
    taskEvents: taskFile,
  });
  assert.deepEqual(applied, {
    taskEvents: taskFile,
  });

  backend.bus.appendTaskEvent({ topic: 'task.progress', text: '正在执行', dedupeKey: 'event-1' });
  assert.equal(backend.bus.readTaskEvents().events[0].text, '正在执行');
  assert.equal(published.length, 1);
  assert.equal(published[0].topic, 'task.progress');
  assert.equal(published[0].text, '正在执行');
  assert.equal(fs.existsSync(taskFile), true);
});
