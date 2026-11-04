import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLaunchEnvironment } from './launch.mjs';

test('launcher builds the original external-service contract against localhost', () => {
  const value = buildLaunchEnvironment({
    env: {
      PATH: '/bin',
      VOICE_CONTROL_AUDIO_SERVICE_URL: 'http://127.0.0.1:48086',
      VOICE_CONTROL_ASR_URL: 'http://asr.local/v1',
    },
    secret: 's'.repeat(64),
    runtimePort: 48087,
    controlPort: 8791,
  });
  assert.equal(value.VOICE_CONTROL_AUDIO_SERVICE_URL, 'http://127.0.0.1:48087');
  assert.equal(value.VOICE_CONTROL_TICKET_SECRET, 's'.repeat(64));
  assert.equal(value.VOICE_CONTROL_LLM_URL, 'http://127.0.0.1:8791/v1');
  assert.equal(value.VOICE_CONTROL_ASR_URL, 'http://asr.local/v1');
});
