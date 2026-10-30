import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ControlService } from '../src/control-service.mjs';
import { loadHubFromEnvironment } from '../src/hub-loader.mjs';
import { PROFILE_VOICE_CONTROLLER } from '../src/plugin.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-control-hub-'));

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('local entry loads a Hub client module without a concrete adapter', async () => {
  const modulePath = path.join(root, 'fake-hub.mjs');
  fs.writeFileSync(modulePath, `
const methods = [
  'latestUserTranscript', 'getPending', 'createWork', 'findWork', 'getStatus',
  'sendMessage', 'readWork', 'readEvents', 'resolveAnswer', 'resolveApproval',
  'stopWork', 'ackAnnouncement'
];
export function createHubClient() {
  return Object.fromEntries(methods.map((name) => [
    name,
    async () => name === 'findWork' ? { candidates: [{ workId: 'work-loaded' }] } : {}
  ]));
}
`, 'utf8');
  const hub = await loadHubFromEnvironment({ BRIDGE_CONTROL_HUB_MODULE: modulePath });
  const service = new ControlService({ hub, profile: PROFILE_VOICE_CONTROLLER });
  const result = await service.call('bridge_chat_find', { query: 'loaded' });
  assert.deepEqual(result, { candidates: [{ workId: 'work-loaded' }] });
});
