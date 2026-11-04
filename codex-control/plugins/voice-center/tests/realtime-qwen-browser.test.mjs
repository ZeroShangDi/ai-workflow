import assert from 'node:assert/strict';
import test from 'node:test';
import { createRealtimeAudio } from '../backend/voice_center_backend/realtime_qwen/browser.js';

class FakeContext {
  constructor() { this.currentTime = 0; this.state = 'suspended'; this.sources = []; FakeContext.latest = this; }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
  createBuffer(channels, size, rate) {
    return { duration: size / rate, getChannelData() { return new Float32Array(size); } };
  }
  createBufferSource() {
    const source = { connect() {}, disconnect() {}, start(at) { this.at = at; },
      stop() { this.stopped = true; }, end() { this.onended?.(); } };
    this.sources.push(source);
    return source;
  }
}

async function player() {
  const sent = [], deliveries = [], errors = [];
  const audio = createRealtimeAudio({ AudioContextImpl: FakeContext,
    send: (v) => sent.push(v), onDelivery: (v) => deliveries.push(v),
    onState() {}, onError: (e) => errors.push(e) });
  await audio.prepare();
  return { audio, sent, deliveries, errors, context: FakeContext.latest };
}
const pcm = Buffer.alloc(960).toString('base64');
const start = { type: 'realtime.audio.start', playbackId: 'r1', noticeId: 'n1' };
const chunk = { type: 'realtime.audio.delta', playbackId: 'r1', audio: pcm };
const end = { type: 'realtime.audio.end', playbackId: 'r1' };

test('generation completion does not acknowledge until all scheduled audio actually ends', async () => {
  const { audio, context, sent, deliveries } = await player();
  audio.handle(start);
  audio.handle(chunk);
  audio.handle(chunk);
  audio.handle(end);
  assert.equal(sent.length, 0);
  context.sources[0].end();
  assert.equal(sent.length, 0);
  context.sources[1].end();
  assert.deepEqual(deliveries, [{ noticeId: 'n1', status: 'spoken' }]);
  assert.equal(sent[0].type, 'realtime.playback.result');
  audio.handle(end);
  assert.equal(sent.length, 1);
  audio.close();
});

test('interruption stops queued audio and cannot later become spoken', async () => {
  const { audio, context, deliveries } = await player();
  audio.handle(start);
  audio.handle(chunk);
  audio.handle({ type: 'realtime.audio.cancel', playbackId: 'r1', status: 'interrupted' });
  assert.equal(context.sources[0].stopped, true);
  context.sources[0].end();
  audio.handle(chunk);
  audio.handle(end);
  assert.deepEqual(deliveries, [{ noticeId: 'n1', status: 'interrupted' }]);
  audio.close();
});

test('closing the page observes interruption before closing the channel and audio context', async () => {
  const { audio, context, deliveries } = await player();
  audio.handle(start);
  audio.handle(chunk);
  audio.close();
  audio.close();
  assert.equal(context.sources[0].stopped, true);
  assert.equal(context.state, 'closed');
  assert.deepEqual(deliveries, [{ noticeId: 'n1', status: 'interrupted' }]);
});

test('missing audio and invalid PCM fail instead of acknowledging playback', async () => {
  const { audio, deliveries, errors } = await player();
  audio.handle(start);
  audio.handle(end);
  assert.equal(deliveries[0].status, 'failed');
  audio.handle({ ...start, playbackId: 'r2' });
  audio.handle({ ...chunk, playbackId: 'r2', audio: 'AA==' });
  assert.equal(deliveries[1].status, 'failed');
  assert.equal(errors.length, 1);
  assert.equal(audio.handle({ type: 'transcript' }), false);
  audio.close();
});
