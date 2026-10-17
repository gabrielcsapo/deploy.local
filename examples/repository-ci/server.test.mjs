import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApplication } from './server.mjs';
const version = JSON.parse(readFileSync(new URL('./version.json', import.meta.url), 'utf8'));
test('a release has a positive identity and a useful message', () => {
  assert.equal(Number.isInteger(version.release) && version.release > 0, true);
  assert.equal(typeof version.message, 'string');
  assert.ok(version.message.trim().length > 10);
});
test('the running server exposes health and the exact committed version', async () => {
  const server = createApplication();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await (await fetch(origin + '/health')).text(), 'ok');
    assert.deepEqual(await (await fetch(origin + '/version')).json(), version);
    assert.equal((await fetch(origin + '/')).status, 200);
    assert.equal((await fetch(origin + '/missing')).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
