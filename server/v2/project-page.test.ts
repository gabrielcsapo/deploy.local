/* eslint-disable react/no-children-prop -- Node test uses createElement with required children props. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { registerHooks } from 'node:module';
// Client pages import stylesheets, which only the bundler understands.
registerHooks({
  load: (url, context, next) =>
    url.endsWith('.css')
      ? { format: 'module', source: '', shortCircuit: true }
      : next(url, context),
});
const root = mkdtempSync(join(tmpdir(), 'server-first-'));
process.env.DEPLOY_DATA_DIR = root;
const store = await import('../store.ts');
const workspace = await import('../workspace/store.ts');
const { loadProjectPage, projectPageOwner, loadProjectTab } = await import('./project-page.ts');
const { buildAuthCookie } = await import('../auth-cookie.ts');
const { DataSeeds } = await import('../../app/routes/dashboard/v2/data/seeds.tsx');
const { InboxProvider } = await import('../../app/routes/dashboard/v2/data/hooks.tsx');
const { default: Projects } =
  await import('../../app/routes/dashboard/v2/projects/page.client.tsx');
const { RouterProvider } = await import('react-flight-router/client');
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
  const html = renderToString(
    createElement(RouterProvider, {
      initialUrl: '/dashboard/projects',
      initialParams: {},
      initialSegments: {},
      createFromReadableStream: async () => ({}),
      callServer: async () => {},
      children: createElement(DataSeeds, {
        seed: page!.seed,
        children: createElement(InboxProvider, { children: createElement(Projects) }),
      }),
    }),
  );
  assert.match(html, /alice private project/);
  assert.doesNotMatch(html, /bob private project|dl-skel/);
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
  const html = renderToString(
    createElement(RouterProvider, {
      initialUrl: '/dashboard/projects',
      initialParams: {},
      initialSegments: {},
      createFromReadableStream: async () => ({}),
      callServer: async () => {},
      children: createElement(DataSeeds, {
        children: createElement(InboxProvider, { children: createElement(Projects) }),
      }),
    }),
  );
  assert.match(html, /dl-skel/);
  assert.doesNotMatch(html, /alice private project|bob private project/);
});
