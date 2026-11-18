import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'server-first-'));
process.env.DEPLOY_DATA_DIR = root;
const store = await import('../../store.ts');
const workspace = await import('../../workspace/store.ts');
const { loadProjectPage, projectPageOwner, loadProjectTab } = await import('./project-page.ts');
const { buildAuthCookie } = await import('../../auth-cookie.ts');
const alice = store.registerUser('alice', 'test-password');
const bob = store.registerUser('bob', 'test-password');
for (const owner of ['alice', 'bob'])
  workspace.save('project', owner, {
    id: `${owner}-project`,
    name: `${owner} private project`,
    repositoryStatus: 'preparing',
  });
const request = (owner?: string, token?: string, path = '/dashboard/projects') =>
  new Request(`http://localhost${path}`, {
    headers: owner && token ? { cookie: buildAuthCookie(owner, token) } : {},
  });
after(() => {
  workspace.db.close();
  store._resetDb();
  rmSync(root, { recursive: true, force: true });
});

test('server-rendered project pages contain only the cookie owner, never explicit header identity', async () => {
  const req = request('alice', alice.token);
  req.headers.set('x-deploy-username', 'bob');
  req.headers.set('x-deploy-token', bob.token!);
  const page = await loadProjectPage(req);
  assert.equal(page?.seed.owner, 'alice');
  const html = JSON.stringify(page!.seed);
  assert.match(html, /alice private project/);
  assert.doesNotMatch(html, /bob private project/);
  const other = await loadProjectPage(request('bob', bob.token));
  assert.doesNotMatch(JSON.stringify(other?.seed), /alice private project/);
  assert.equal(
    (await loadProjectPage(req))?.seed,
    page?.seed,
    'deduplicated only inside this request',
  );
});

test('missing, malformed, expired and revoked cookies retain the client path', async () => {
  const headerOnly = request();
  headerOnly.headers.set('x-deploy-username', 'alice');
  headerOnly.headers.set('x-deploy-token', alice.token!);
  assert.equal(await loadProjectPage(headerOnly), undefined);
  const malformed = request();
  malformed.headers.set('cookie', 'deploy-sh-auth=%oops');
  assert.equal(await loadProjectPage(malformed), undefined);
  assert.equal(await loadProjectTab(undefined), undefined);
  assert.equal(await loadProjectPage(request('alice', 'wrong')), undefined);
  const expired = store.loginUser('bob', 'test-password');
  store
    .getSqlite()!
    .prepare('UPDATE sessions SET expires_at=? WHERE token=?')
    .run(1, expired.token);
  assert.equal(await loadProjectPage(request('bob', expired.token)), undefined);
  const revoked = store.loginUser('bob', 'test-password');
  store.logoutUser('bob', revoked.token!);
  assert.equal(projectPageOwner(request('bob', revoked.token)), undefined);
  assert.equal(await loadProjectPage(request('alice', alice.token, '/dashboard/live')), undefined);
});
