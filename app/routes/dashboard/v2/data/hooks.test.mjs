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
      queueMicrotask,
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
    subscriber.events([{ type: 'health' }, { type: 'conversation' }]);
    await settle();
    assert.deepEqual(
      requests,
      [],
      'health and progress events wait out the spacing on a fresh seed',
    );
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

test('parts of a page share a read in flight, and a refresh after a change starts its own', async () => {
  const h = await componentHarness(
    'app/routes/dashboard/v2/data/hooks.tsx',
    {
      './seeds': {
        useDataSeed: () => undefined,
        freshSeed: () => false,
        resourceKey: (key) => key,
      },
      '../../detail/shared': { getAuth: () => ({ username: 'alice', token: 'one' }) },
      './event-feed': { createEventFeed: () => ({ subscribe: () => () => {}, reset() {} }) },
      './inbox-store': { createInboxStore: () => ({}) },
      '../inbox/presentation': { agentName: (name) => name },
    },
    {
      window: { addEventListener() {}, removeEventListener() {} },
      Headers,
      AbortController,
      setTimeout,
      clearTimeout,
      queueMicrotask,
      fetch: async () => assert.fail('the test supplies its own request'),
    },
  );
  try {
    const pending = [];
    const request = (path, init) =>
      new Promise((resolve, reject) => {
        pending.push({
          path,
          resolve: (name) => resolve({ ok: true, json: async () => ({ name }) }),
        });
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    const read = (afterChange, signal = new AbortController().signal) =>
      h.exports.sharedRead('/api/v2/live', signal, false, afterChange, request);
    const leaving = new AbortController();
    const polls = [read(false), read(false), read(false, leaving.signal)];
    assert.equal(pending.length, 1, 'three polls, one request');
    leaving.abort();
    await assert.rejects(polls[2]);
    await settle();
    // The read in flight may predate the change, so the refresh asks again; refreshes
    // delivered in the same turn share that second request.
    const refreshes = [read(true), read(true)];
    assert.equal(pending.length, 2);
    const tolerant = h.exports.sharedRead(
      '/api/v2/live',
      new AbortController().signal,
      true,
      false,
      request,
    );
    assert.equal(pending.length, 2, 'optional and required readers share a request');
    const late = read(false);
    assert.equal(pending.length, 2, 'a poll joins the newest read');
    pending[0].resolve('before');
    pending[1].resolve('after');
    assert.deepEqual(
      (await Promise.all(polls.slice(0, 2))).map((v) => v.name),
      ['before', 'before'],
    );
    assert.deepEqual(
      (await Promise.all([...refreshes, late, tolerant])).map((v) => v.name),
      ['after', 'after', 'after', 'after'],
    );
  } finally {
    h.dispose();
  }
});
