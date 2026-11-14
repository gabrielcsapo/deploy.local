import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createLoadingFixture } from './fixture-server';

test('loading capture holds requests, fails immediately, recovers, and reveals package parts independently', async () => {
  const server = createLoadingFixture();
  await new Promise<void>((resolve) => server.listen(5194, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:5194';
  const configure = (query: string) =>
    fetch(origin + '/fixture/state?' + query).then((r) => r.json());
  const request = (path: string) => fetch(origin + path);
  async function held(path: string) {
    let settled = false;
    const response = request(path).then((r) => {
      settled = true;
      return r;
    });
    let pending = 0;
    for (let n = 0; n < 50 && !pending; n++) {
      pending = (await (await request('/fixture')).json()).pending;
      if (!pending) await delay(5);
    }
    assert.ok(pending > 0);
    assert.equal(settled, false);
    return { response };
  }
  try {
    for (const board of [
      'HomeLoadingPhone',
      'HomeLoadingSlowPhone',
      'HomeRefreshingPhone',
      'ProjectsLoadingPhone',
      'TaskLoadingPhone',
      'LiveLoadingPhone',
    ]) {
      await configure(`board=${board}&behavior=hang`);
      const path =
        board === 'ProjectsLoadingPhone'
          ? '/api/projects'
          : board === 'TaskLoadingPhone'
            ? '/api/tasks/sync'
            : board === 'LiveLoadingPhone'
              ? '/api/live'
              : '/api/state';
      const pending = await held(path);
      await configure('behavior=success');
      assert.equal((await pending.response).status, 200);
    }
    await configure('board=HomeUnavailablePhone&behavior=fail');
    assert.equal((await request('/api/state')).status, 503);
    await configure('behavior=success');
    assert.equal((await request('/api/state')).status, 200);
    await configure('board=PackagesPhone&private=success&copies=hang');
    assert.equal((await (await request('/api/packages')).json()).packages.length, 1);
    const copies = await held('/api/packages/cache');
    await configure('copies=fail');
    assert.equal((await copies.response).status, 503);
    assert.equal((await request('/api/packages')).status, 200);
    await configure('copies=success');
    assert.equal((await request('/api/packages/cache')).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
