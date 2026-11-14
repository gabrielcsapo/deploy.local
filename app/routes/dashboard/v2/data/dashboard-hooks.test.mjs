import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness, settle } from '../../../../../scripts/component-harness.mjs';
import { freshSeed, readSeeded } from './seeds.tsx';

test('Computers consumes the seed without a request, retains polling and explicit refresh, and switches seeds', async () => {
  let seed = {
    owner: 'alice',
    at: Date.now(),
    data: { '/api/computers': { computers: [{ name: 'Alice computer' }] } },
  };
  const requests = [],
    timers = [];
  const h = await componentHarness(
    'app/routes/dashboard/v2/computers/data.ts',
    {
      '../data/seeds': { useDataSeed: () => seed, freshSeed },
      '../data/hooks': {
        onAuthReset: () => () => {},
        remember() {},
        remembered: (path, seed) => seed?.data[path],
        authenticatedFetch: async (path) => {
          requests.push(path);
          return { ok: true, json: async () => ({ computers: [{ name: 'Refreshed' }] }) };
        },
      },
    },
    {
      AbortController,
      setInterval: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearInterval() {},
    },
  );
  try {
    const read = () => h.render(() => h.exports.useComputerData('/computers'));
    assert.equal(read().data.computers[0].name, 'Alice computer');
    h.effects();
    await settle();
    assert.deepEqual(requests, []);
    timers[0]();
    await settle();
    assert.equal(read().data.computers[0].name, 'Refreshed');
    read().refresh();
    read();
    h.effects();
    await settle();
    assert.equal(requests.length, 2);
    seed = {
      owner: 'bob',
      at: Date.now(),
      data: { '/api/computers': { computers: [{ name: 'Bob computer' }] } },
    };
    assert.equal(
      read().data.computers[0].name,
      'Bob computer',
      'new route seed wins before effects',
    );
  } finally {
    h.dispose();
  }
});

test('first form reads honor fresh success/error seeds and expired seeds use the live API', async () => {
  const path = '/api/auth/account';
  const seed = {
    owner: 'alice',
    at: Date.now(),
    data: { [path]: { username: 'alice' } },
    errors: { '/api/nodes': 'Administrator access required' },
  };
  let reads = 0;
  const request = async () => {
    reads++;
    return { username: 'live' };
  };
  assert.equal((await readSeeded(seed, path, request)).username, 'alice');
  await assert.rejects(readSeeded(seed, '/api/nodes', request), /Administrator access required/);
  assert.equal(reads, 0);
  assert.equal(
    (await readSeeded({ ...seed, at: seed.at - 10001 }, path, request)).username,
    'live',
  );
  assert.equal((await readSeeded(undefined, path, request)).username, 'live');
  assert.equal(reads, 2);
});

test('Composer does not re-request the shell agents, model choices, or seeded task on mount', async () => {
  const seed = {
    owner: 'alice',
    at: Date.now(),
    data: {
      '/api/agents': { agents: [] },
      '/api/model-settings': { choices: [], local: [], defaults: {}, providers: [] },
      '/api/task-snapshots/task': {
        task: { id: 'task' },
        project: { id: 'project' },
        screenshots: [],
      },
    },
  };
  const requests = [];
  const h = await componentHarness('app/components/ui/v2/Composer.tsx', {
    './Dialog': { Dialog: 'Dialog' },
    'react-flight-router/client': { useLocation: () => ({ pathname: '/dashboard/tasks/task' }) },
    '../../../routes/dashboard/v2/data/seeds': { useDataSeed: () => seed, readSeeded },
    '../../../routes/dashboard/v2/markup/client': {
      mediaRequest: async (path) => {
        requests.push(path);
        throw new Error('Unexpected read');
      },
      submitMessage() {},
      uploadFile() {},
    },
  });
  try {
    h.render(h.exports.Composer);
    h.effects();
    await settle();
    assert.deepEqual(requests, []);
  } finally {
    h.dispose();
  }
});
