import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  legacyDestination,
  lookupApplicationProject,
  staticRedirects,
} from '../app/routes/dashboard/v2-redirects.ts';
import { routes } from '../app/routes.ts';
import { matchRoutes } from 'react-flight-router/router';

for (const [old, destination] of Object.entries(staticRedirects)) {
  test(`${old} redirects to ${destination}`, async () => {
    assert.equal(
      await legacyDestination(old, async () => {
        throw new Error('No project lookup needed');
      }),
      destination,
    );
    assert.ok(matchRoutes(routes, destination.split('?')[0]).length, 'destination is registered');
  });
}
for (const [suffix, destination] of [
  ['', '/apps/home-gym'],
  ['/releases', '/releases'],
  ['/logs', '/logs?app=home-gym'],
  ['/build', '/logs?app=home-gym'],
  ['/traffic', '/apps/home-gym'],
  ['/settings', '/apps/home-gym/settings'],
]) {
  test(`old application ${suffix || 'overview'} resolves its project`, async () => {
    const old = `/dashboard/home-gym${suffix}`;
    assert.equal(
      await legacyDestination(old, async (application) => {
        assert.equal(application, 'home-gym');
        return 'project-1';
      }),
      `/dashboard/projects/project-1${destination}`,
    );
    assert.equal(await legacyDestination(old, async () => null), '/dashboard/live');
    assert.ok(matchRoutes(routes, old).length);
    assert.ok(
      matchRoutes(routes, `/dashboard/projects/project-1${destination.split('?')[0]}`).length,
    );
  });
}
test('catalog detail and import keep their identity', async () => {
  assert.equal(
    await legacyDestination('/dashboard/catalog/immich', async () => null),
    '/dashboard/discover/immich',
  );
  assert.equal(
    await legacyDestination('/dashboard/catalog/import', async () => null),
    '/dashboard/discover/import',
  );
});
test('current routes do not redirect to themselves or perform application lookups', async () => {
  for (const path of [
    '/dashboard',
    '/dashboard/projects',
    '/dashboard/live',
    '/dashboard/computers/models',
    '/dashboard/tasks/123/checks',
    '/dashboard/agents/new',
  ])
    assert.equal(
      await legacyDestination(path, async () => {
        throw new Error('Unexpected lookup');
      }),
      null,
    );
});
test('query strings, hashes, trailing slashes and encoded identities survive', async () => {
  assert.equal(
    await legacyDestination('/dashboard/activity/?filter=mine#latest', async () => null),
    '/dashboard/inbox?tab=answered&filter=mine#latest',
  );
  assert.equal(
    await legacyDestination('/dashboard/my%20app/build?app=wrong&level=error', async (app) => {
      assert.equal(app, 'my app');
      return 'my/project';
    }),
    '/dashboard/projects/my%2Fproject/logs?app=my+app&level=error',
  );
});
test('lookup uses the application repository endpoint and supports existing coordinator mount', async () => {
  const paths: string[] = [];
  const request: typeof fetch = async (input) => {
    paths.push(String(input));
    return paths.length === 1
      ? new Response('', { status: 404 })
      : Response.json({ projects: [{ id: 'project-1', name: 'home-gym' }] });
  };
  assert.equal(await lookupApplicationProject('home gym', request), 'project-1');
  assert.deepEqual(paths, [
    '/api/application-repositories?application=home%20gym',
    '/api/workspace/application-repositories?application=home%20gym',
  ]);
});
test('missing, malformed, unauthorized and unreachable projects fall back safely', async () => {
  for (const body of [{ projects: [] }, {}, { projects: [null, { id: 42 }] }])
    assert.equal(await lookupApplicationProject('home-gym', async () => Response.json(body)), null);
  assert.equal(
    await lookupApplicationProject('home-gym', async () => new Response('', { status: 401 })),
    null,
  );
  assert.equal(
    await lookupApplicationProject('home-gym', async () => {
      throw new Error('Offline');
    }),
    null,
  );
});

test('host redirect adapter returns HTTP 308 for every old path without intercepting writes', async () => {
  const { permanentRedirectResponse } = await import('../app/routes/dashboard/v2-redirects.ts');
  for (const path of [
    ...Object.keys(staticRedirects),
    '/dashboard/catalog/immich',
    ...['', '/releases', '/logs', '/build', '/traffic', '/settings'].map(
      (suffix) => `/dashboard/home-gym${suffix}`,
    ),
  ]) {
    const request = new Request(`http://localhost${path}`);
    const response = await permanentRedirectResponse(request, async () => 'project-1');
    assert.equal(response?.status, 308);
    assert.equal(
      response?.headers.get('Location'),
      await legacyDestination(path, async () => 'project-1'),
    );
  }
  assert.equal(
    await permanentRedirectResponse(
      new Request('http://localhost/dashboard/projects'),
      async () => null,
    ),
    null,
  );
  assert.equal(
    await permanentRedirectResponse(
      new Request('http://localhost/dashboard/apps', { method: 'POST' }),
      async () => null,
    ),
    null,
  );
});

test('repository pages from before v2 open the project, and never shadow a deploy.local page', async () => {
  for (const [old, next] of [
    ['/home-gym', '/dashboard/projects/home-gym'],
    ['/home-gym/pulls?state=open', '/dashboard/projects/home-gym/pulls?state=open'],
    ['/home-gym/deployment', '/dashboard/projects/home-gym/releases'],
    ['/dashboard/repositories/home%20gym/settings', '/dashboard/projects/home%20gym/settings'],
  ])
    assert.equal(await legacyDestination(old, async () => null), next);
  for (const page of [
    '/about',
    '/signin',
    '/docs/ship',
    '/dashboard',
    '/dashboard/settings',
    '/dashboard/settings?tab=account',
    '/@vite/client',
    '/home-gym/x',
  ])
    assert.equal(await legacyDestination(page, async () => null), null, page);
});

test('package bookmarks redirect, including scoped names and setup queries', async () => {
  for (const path of [
    '/packages',
    '/packages?tab=setup',
    '/packages/npm/react-flight-router',
    '/packages/npm/%40deploy.local%2Fmdns',
    '/packages/npm/@deploy.local/mdns',
  ]) {
    const destination = await legacyDestination(path, async () => {
      throw new Error('No project lookup needed');
    });
    assert.equal(destination, '/dashboard' + path);
    assert.ok(matchRoutes(routes, destination!.split('?')[0]).length);
  }
});
