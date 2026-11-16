import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { keptFixture } from './kept.fixture.ts';
const fixture = await keptFixture();
const { packagesApi } = await import('./api.ts');
const server = createServer(async (req, res) => {
  try {
    await packagesApi(req, res, req.headers['x-test-user'] === 'reader' ? 'reader' : 'owner');
  } catch (error: any) {
    res.writeHead(error.status || 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
});
after(async () => {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await fixture.close();
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const call = (path: string, method = 'GET', user = 'owner') =>
  fetch(origin + '/api/packages/cache/' + path, { method, headers: { 'x-test-user': user } });

test('HTTP list, detail and totals include both ecosystems; all removal routes are admin-only and idempotent', async () => {
  await fixture.add('@scope/shared', '1.0.0', 'npm', 200, 400);
  await fixture.add('@scope/shared', '2.0.0', 'npm', 100, 400);
  await fixture.add('shared', '1.0.0', 'cargo', 50, 400);
  fixture
    .db()
    .prepare('INSERT INTO package_pins VALUES(?,?,?,?,?)')
    .run('npm', '@scope/shared@2.0.0', 'p1', 'live', 'release');
  const list = await (await call('kept?q=shared')).json();
  assert.equal(list.packages, 2);
  assert.equal(list.versions, 3);
  assert.equal(list.canRemove, true);
  const detail = await (await call('entry/npm/%40scope%2Fshared')).json();
  assert.equal(detail.totalVersions, 2);
  assert.equal(detail.neededVersions, 1);
  const status = await (await fetch(origin + '/api/packages/cache')).json();
  assert.equal(status.kept.bytes, 350);
  assert.equal(status.storage.ecosystems.cargo, 50);
  for (const path of [
    'kept/remove?time=idle',
    'remove/npm/%40scope%2Fshared',
    'remove/cargo/shared',
  ]) {
    assert.equal((await call(path, 'POST', 'reader')).status, 403);
  }
  assert.equal((await call('kept/remove', 'POST')).status, 400);
  assert.equal((await call('kept?kind=bad')).status, 400);
  assert.equal((await call('entry/npm/%40scope%2Fshared?offset=-1')).status, 400);
  assert.equal((await (await call('kept', 'GET', 'reader')).json()).canRemove, false);
  const removed = await (await call('kept/remove?time=idle&q=shared', 'POST')).json();
  assert.equal(removed.versions, 1);
  assert.equal(removed.bytes, 200);
  assert.equal(removed.keptBytes, 150);
  assert.equal((await (await call('kept/remove?time=idle', 'POST')).json()).versions, 0);
  assert.equal((await (await call('remove/npm/%40scope%2Fshared', 'POST')).json()).versions, 0);
  assert.equal((await (await call('remove/cargo/shared', 'POST')).json()).versions, 0);
});
