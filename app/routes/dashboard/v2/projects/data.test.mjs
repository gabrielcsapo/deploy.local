import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness, settle } from '../../../../../scripts/component-harness.mjs';

test('known project counts survive refresh, failed reads and remounts; other projects do not inherit them', async () => {
  const cache = new Map();
  const pending = [];
  const stubs = {
    '../data/hooks': {
      remembered: (path) => cache.get(path),
      remember: (path, value) => cache.set(path, value),
      authenticatedFetch: (path, init) =>
        new Promise((resolve, reject) => pending.push({ path, init, resolve, reject })),
    },
  };
  const open = () =>
    componentHarness('app/routes/dashboard/v2/projects/data.ts', stubs, { AbortController });
  const path = '/api/v2/projects/gym/overview';
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
  read('/api/v2/projects/other/overview');
  h.effects();
  assert.equal(read('/api/v2/projects/other/overview').data, undefined);
  assert.equal(pending[0].init.signal.aborted, true);
  h.dispose();
});
