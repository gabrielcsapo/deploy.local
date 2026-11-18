import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RouteConfig } from 'react-flight-router/router';
import { matchRoutes } from 'react-flight-router/router';
import { declaredRedirect, legacyDestination } from '../app/routes/dashboard/v2-redirects.ts';
import { routes } from '../app/routes.ts';

// Every route that declares a redirect lands exactly where the client redirect it replaced did.
function declared(list: RouteConfig[], prefix = ''): string[] {
  return list.flatMap((route) => {
    const path = [prefix, route.path].filter(Boolean).join('/');
    return [
      ...(route.redirect ? [path] : []),
      ...(route.children ? declared(route.children, path) : []),
    ];
  });
}

const samples: Record<string, string[]> = {
  projectId: ['home-gym', 'my%20project', 'releases'],
  section: ['repository', 'issues', 'pulls', 'pipelines', 'deployment', 'settings', 'unknown'],
  id: ['immich'],
  name: ['tally', '%40scope%2Fname'],
  scope: ['@deploy'],
  repository: ['home-gym', 'tally', 'dashboard', 'api', 'docs'],
};
function expand(pattern: string): string[] {
  const [head, ...rest] = pattern.split('/');
  const options = head.startsWith(':') ? (samples[head.slice(1)] ?? ['x']) : [head];
  if (!rest.length) return options;
  return options.flatMap((option) => expand(rest.join('/')).map((tail) => `${option}/${tail}`));
}

const patterns = declared(routes);
test('the app declares the redirects that need no lookup', () => {
  // Two of them send a project's old Issues and Pull requests lists to its Work tab
  // (projects/routing.ts workRedirect, tested in routing.test.ts).
  assert.equal(patterns.length, 23);
});

for (const pattern of patterns) {
  test(`/${pattern} lands where the client redirect sent it`, async () => {
    for (const path of expand(pattern)) {
      for (const suffix of ['', '?filter=mine', '/']) {
        const url = new URL(`/${path}${suffix}`, 'http://deploy.local');
        const matches = matchRoutes(routes, url.pathname);
        // Another route may take the URL first (a real page): then nothing redirects here.
        if (!matches.some((match) => match.route.redirect)) continue;
        const before =
          (await legacyDestination(url.pathname + url.search, async () => {
            throw new Error('No project lookup on a declared redirect');
          })) || '/dashboard/live';
        assert.equal(declaredRedirect({ url }), before, url.href);
      }
    }
  });
}

// Every page the dashboard serves opens as itself. A page missing from the redirect module's list
// of places is taken for an old application address: the host then looks for an application with
// that name in every project and sends the browser to Live (which happened to Releases and Pull
// requests once pages could read the sign-in cookie).
function served(list: RouteConfig[], prefix = ''): string[] {
  return list.flatMap((route) => {
    const path = [prefix, route.path].filter(Boolean).join('/');
    return [
      ...(route.redirect || route.path === undefined ? [] : [path]),
      ...(route.children ? served(route.children, path) : []),
    ];
  });
}
test('every dashboard page opens as itself without an application lookup', async () => {
  const pages = served(routes)
    .filter((path) => path === 'dashboard' || path.startsWith('dashboard/'))
    // `/dashboard/:name…` are the old application addresses; looking them up is their job.
    .filter((path) => !path.split('/')[1]?.startsWith(':'))
    .flatMap(expand);
  assert.ok(pages.length > 40, `only ${pages.length} dashboard pages found`);
  const looked: string[] = [];
  for (const page of pages) {
    const destination = await legacyDestination('/' + page, async (application) => {
      looked.push(`/${page} looked up ${application}`);
      return null;
    });
    if (destination) looked.push(`/${page} → ${destination}`);
  }
  assert.deepEqual(looked, []);
});
