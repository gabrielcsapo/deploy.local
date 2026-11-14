import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness, settle } from '../../../../../scripts/component-harness.mjs';

test('known project counts survive refresh, failed reads and remounts; other projects do not inherit them', async () => {
  const cache = new Map();
  const pending = [];
  const stubs = {
    '../data/hooks': {
      onAuthReset: () => () => {},
      eventFeed: { subscribe: () => () => {} },
      remembered: (path) => cache.get(path),
      remember: (path, value) => cache.set(path, value),
      authenticatedFetch: (path, init) =>
        new Promise((resolve, reject) => pending.push({ path, init, resolve, reject })),
    },
  };
  const open = () =>
    componentHarness('app/routes/dashboard/v2/projects/data.ts', stubs, { AbortController });
  const path = '/api/projects/gym/overview';
  const known = { pulls: [{ state: 'open' }], issues: [{}], project: { apps: [{ name: 'web' }] } };
  let h = await open();
  const read = (key = path) => h.render(() => h.exports.useData(key));
  assert.equal(read().data, undefined);
  h.effects();
  pending.shift().resolve({ ok: true, json: async () => known });
  await settle();
  assert.equal(read().data, known);
  read().refresh();
  read();
  h.effects();
  assert.equal(read().data, known, 'refresh keeps counts');
  pending.shift().reject(new Error('offline'));
  await settle();
  assert.equal(read().data, known, 'failure keeps counts');
  assert.equal(read().error, 'offline');
  h.dispose();
  h = await open();
  assert.equal(read().data, known, 'remount starts with cached counts');
  h.effects();
  read('/api/projects/other/overview');
  h.effects();
  assert.equal(read('/api/projects/other/overview').data, undefined);
  assert.equal(pending[0].init.signal.aborted, true);
  h.dispose();
});

test('a server seed skips the first request and refreshes after an event, including a subscription gap', async () => {
  const path = '/api/projects/p/overview';
  const seed = { owner: 'owner', at: Date.now(), cursor: 10, data: { [path]: { name: 'server' } } };
  let subscriber;
  const requests = [];
  const cache = new Map();
  const h = await componentHarness(
    'app/routes/dashboard/v2/projects/data.ts',
    {
      '../data/seeds': {
        useDataSeed: () => seed,
        freshSeed: (value, key) => value?.data[key] !== undefined,
      },
      '../data/hooks': {
        remembered: (key, value) => cache.get(key) ?? value?.data[key],
        remember: (key, value) => cache.set(key, value),
        onAuthReset: () => () => {},
        eventFeed: {
          subscribe(value) {
            subscriber = value;
            return () => {};
          },
        },
        authenticatedFetch: async (key) => {
          requests.push(key);
          return { ok: true, json: async () => ({ name: 'updated' }) };
        },
      },
    },
    { AbortController },
  );
  const read = () => h.render(() => h.exports.useData(path));
  assert.equal(read().data.name, 'server');
  h.effects();
  await subscriber.snapshot(new AbortController().signal, 10);
  await settle();
  assert.deepEqual(requests, []);
  subscriber.events([{ type: 'release' }]);
  read();
  h.effects();
  await settle();
  assert.equal(read().data.name, 'updated');
  assert.deepEqual(requests, [path]);
  // A reconnect still requests a fresh snapshot.
  await subscriber.snapshot(new AbortController().signal, 11);
  read();
  h.effects();
  await settle();
  assert.equal(requests.length, 2);
  h.dispose();
});
