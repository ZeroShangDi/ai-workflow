import assert from 'node:assert/strict';
import test from 'node:test';

import { ConsumerRegistry } from '../src/consumer-registry.mjs';
import { temporaryDirectory } from './helpers.mjs';

test('installation is not subscription and activation requires the full explicit lifecycle', async (t) => {
  const directory = await temporaryDirectory(t);
  const registry = new ConsumerRegistry({ dataDir: directory });
  assert.equal(registry.get('voice-control').subscribed, false);
  assert.equal(registry.listSubscriptions().length, 0);

  registry.setFacts('voice-control', { installed: true, configured: true, healthy: true });
  assert.equal(registry.get('voice-control').paired, false);
  assert.throws(
    () => registry.addSubscription({
      id: 'voice-default',
      consumer: 'voice-control',
      topics: ['task.completed'],
    }),
    (error) => error.code === 'pairing_required',
  );
  assert.throws(
    () => registry.pair('voice-control', { confirmed: false }),
    (error) => error.code === 'pairing_confirmation_required',
  );

  registry.pair('voice-control', { confirmed: true });
  const subscription = registry.addSubscription({
    id: 'voice-default',
    consumer: 'voice-control',
    topics: ['task.completed', 'task.failed'],
    filters: { workId: ['work-1', 'work-2'] },
    delivery: { mode: 'idle', dedupe: 'eventId', ackRequired: true },
  });
  assert.equal(subscription.consumer, 'voice-control');
  assert.deepEqual(
    registry.get('voice-control'),
    {
      id: 'voice-control',
      installed: true,
      configured: true,
      healthy: true,
      paired: true,
      updatedAt: registry.get('voice-control').updatedAt,
      subscribed: true,
      active: true,
      subscriptionCount: 1,
    },
  );

  const matching = {
    eventId: 'evt-1',
    topic: 'task.completed',
    scope: { workId: 'work-1' },
    payload: {},
  };
  const filtered = {
    ...matching,
    eventId: 'evt-2',
    topic: 'task.failed',
    scope: { workId: 'work-3' },
  };
  assert.equal(registry.canConsume('voice-control', matching), true);
  assert.equal(registry.canConsume('voice-control', filtered), false);

  const reloaded = new ConsumerRegistry({ dataDir: directory });
  assert.equal(reloaded.get('voice-control').active, true);
  assert.equal(reloaded.listSubscriptions('voice-control').length, 1);
});

test('disabling an earlier lifecycle fact deactivates later facts', () => {
  const registry = new ConsumerRegistry();
  registry.setFacts('bridge-control', { installed: true, configured: true, healthy: true });
  registry.pair('bridge-control', { confirmed: true });
  registry.addSubscription({
    id: 'control',
    consumer: 'bridge-control',
    topics: ['*'],
  });
  assert.equal(registry.get('bridge-control').active, true);

  registry.setFacts('bridge-control', { healthy: false });
  const state = registry.get('bridge-control');
  assert.equal(state.paired, false);
  assert.equal(state.subscribed, true);
  assert.equal(state.active, false);
});
