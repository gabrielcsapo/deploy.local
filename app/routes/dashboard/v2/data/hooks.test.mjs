import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness, settle } from '../../../../../scripts/component-harness.mjs';

test('seeded resources skip the initial read, refresh on events and isolate browser identities', async () => {
  const path = '/api/v2/live';
  const seed = { owner: 'alice', at: Date.now(), cursor: 8, data: { [path]: { name: 'first' } } };
  let auth = { username: 'alice', token: 'one' };
  let subscriber;
  const requests = [];
  const h = await componentHarness(
    'app/routes/dashboard/v2/data/hooks.tsx',
    {
      './seeds': {
        useDataSeed: () => seed,
        freshSeed: (value, key) => Object.hasOwn(value.data, key),
        resourceKey: (key) => key,
      },
      '../../detail/shared': { getAuth: () => auth },
      './event-feed': {
        createEventFeed: () => ({
          subscribe(value) {
            subscriber = value;
            return () => {};
          },
          reset() {},
        }),
      },
      './inbox-store': { createInboxStore: () => ({}) },
      '../inbox/presentation': { agentName: (name) => name },
    },
    {
      window: { addEventListener() {}, removeEventListener() {} },
      Headers,
      AbortController,
      setTimeout,
      clearTimeout,
      fetch: async (key) => {
        requests.push(key);
        return { ok: true, json: async () => ({ name: 'live' }) };
      },
    },
  );
  try {
    const read = () => h.render(() => h.exports.useResource(path));
    assert.equal(read().data.name, 'first');
    assert.equal(read().loading, false);
    h.effects();
    await subscriber.snapshot(new AbortController().signal, 8);
    assert.deepEqual(requests, []);
    subscriber.events([{ type: 'release' }]);
    await settle();
    assert.equal(read().data.name, 'live');
    assert.deepEqual(requests, [path]);
    await subscriber.snapshot(new AbortController().signal, 9);
    await settle();
    assert.equal(requests.length, 2, 'reconnect refreshes');
    assert.equal(h.exports.remembered(path).name, 'live');
    auth = { username: 'bob', token: 'two' };
    assert.equal(h.exports.remembered(path), undefined, 'another session cannot reuse Alice data');
  } finally {
    h.dispose();
  }
});
