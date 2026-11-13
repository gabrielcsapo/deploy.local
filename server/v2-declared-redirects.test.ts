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
  assert.equal(patterns.length, 21);
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
