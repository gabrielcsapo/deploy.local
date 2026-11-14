import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness, settle } from '../../../../../scripts/component-harness.mjs';

test('project app health uses its seed, skips the first snapshot and refreshes on health events', async () => {
  const seed = {
    owner: 'owner',
    cursor: 4,
    at: Date.now(),
    data: {
      '/api/live': { computers: [], summary: {} },
      '/api/live/web': { app: { name: 'web' } },
      '/api/inbox?state=waiting': { items: [] },
    },
  };
  let subscriber;
  const requests = [];
  const h = await componentHarness(
    'app/routes/dashboard/v2/live/data.ts',
    {
      '../data/seeds': {
        useDataSeed: () => seed,
        freshSeed: (value, path) => Object.hasOwn(value.data, path),
      },
      '../data/hooks': {
        remembered: (path, value) => value?.data[path],
        remember() {},
        eventFeed: {
          subscribe(value) {
            subscriber = value;
            return () => {};
          },
        },
        authenticatedFetch: async (path) => {
          requests.push(path);
          return { ok: true, json: async () => seed.data[path] };
        },
      },
    },
    { AbortController, AbortSignal },
  );
  try {
    const read = () => h.render(() => h.exports.useLive('web'));
    assert.equal(read().detail.app.name, 'web');
    assert.deepEqual(read().items, []);
    h.effects();
    const signal = new AbortController().signal;
    await subscriber.snapshot(signal, 4);
    assert.deepEqual(requests, []);
    await subscriber.events([{ type: 'health' }], signal);
    await settle();
    assert.equal(requests.length, 3);
    assert.equal(read().detail.app.name, 'web');
    await subscriber.snapshot(signal, 5);
    assert.equal(requests.length, 6, 'reconnection reads another snapshot');
  } finally {
    h.dispose();
  }
});
