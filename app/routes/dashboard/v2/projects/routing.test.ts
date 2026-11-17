import test from 'node:test';
import assert from 'node:assert/strict';
import { appPath, appTabItems, projectTabItems, workRedirect } from './routing.ts';
import { routes } from '../../../../routes.ts';
import { matchRoutes } from 'react-flight-router/router';

test('Performance tab destinations resolve to the project page for both app layouts', () => {
  for (const single of [false, true]) {
    const href = appTabItems('/dashboard/projects/gym', { name: 'web', kind: 'web' }, single).find(
      (tab) => tab.label === 'Performance',
    )!.href;
    const matched = matchRoutes(routes, href);
    assert.match(matched.at(-1)!.route.id, /performance$/);
  }
});

test('app links live under their project and safely encode fallback project keys', () => {
  assert.equal(
    appPath({ appId: 'worker', name: 'Worker', project: 'gym' }),
    '/dashboard/projects/gym/apps/worker',
  );
  assert.equal(
    appPath({ appId: 'photos.app', name: 'photos.app', project: 'app:photos.app' }),
    '/dashboard/projects/app%3Aphotos%2Eapp/apps/photos%2Eapp',
  );
  assert.equal(
    appPath({ appId: 'photos', name: 'photos' }),
    '/dashboard/projects/app%3Aphotos/apps/photos',
  );
});

test('web apps have Performance between Requests and Releases; workers omit both', () => {
  const tabs = appTabItems('/dashboard/projects/gym', { name: 'sync job', kind: 'worker' });
  assert.deepEqual(
    tabs.map((tab) => tab.label),
    ['Overview', 'Releases', 'Logs', 'Settings'],
  );
  assert.equal(tabs[1].href, '/dashboard/projects/gym/releases?app=sync%20job');
  assert.equal(tabs[2].href, '/dashboard/projects/gym/logs?app=sync%20job');
  assert.deepEqual(
    appTabItems('/p', { name: 'web', kind: 'web' }).map((tab) => tab.label),
    ['Overview', 'Requests', 'Performance', 'Releases', 'Logs', 'Settings'],
  );
  assert.equal(
    appTabItems('/p', { name: 'photos.app', kind: 'web' })[2].href,
    '/p/apps/photos%2Eapp/performance',
  );
});

test('one-app projects retain Work and Code alongside app tabs', () => {
  const tabs = projectTabItems(
    '/p',
    {
      project: { apps: [{ name: 'web', kind: 'web' }] },
      repository: {},
    },
    0,
    7,
  );
  assert.deepEqual(
    tabs.map((tab) => tab.label),
    ['Overview', 'Work', 'Code', 'Releases', 'Requests', 'Performance', 'Logs', 'Settings'],
  );
  assert.equal(tabs.find((tab) => tab.label === 'Overview')?.href, '/p');
  assert.equal(tabs.find((tab) => tab.label === 'Requests')?.href, '/p/requests');
  assert.equal(tabs.find((tab) => tab.label === 'Performance')?.href, '/p/performance');
  assert.equal(tabs.find((tab) => tab.label === 'Settings')?.href, '/p/settings');
  assert.equal(tabs.find((tab) => tab.label === 'Work')?.href, '/p/work');
  assert.equal(tabs.find((tab) => tab.label === 'Work')?.count, 7);
});

test('Work takes the place of Issues and Pull requests on every project', () => {
  const tabs = projectTabItems('/p', { project: { apps: [] }, repository: null }, 0, 0);
  assert.deepEqual(
    tabs.map((tab) => tab.label),
    ['Overview', 'Work', 'Settings'],
  );
  // Nothing open: the tab stays, without a count.
  assert.equal(tabs[1].count, undefined);
});

test('the old Issues and Pull requests lists redirect to Work; a pull request keeps its page', () => {
  for (const list of ['issues', 'pulls']) {
    const matched = matchRoutes(routes, `/dashboard/projects/gym/${list}`).at(-1)!.route;
    assert.equal(typeof matched.redirect, 'function');
    assert.equal(
      workRedirect({ url: new URL(`http://x/dashboard/projects/gym/${list}?state=open`) }),
      '/dashboard/projects/gym/work?state=open',
    );
  }
  assert.equal(
    matchRoutes(routes, '/dashboard/projects/gym/work').at(-1)!.route.id,
    'v2-projects-p-work',
  );
  assert.equal(
    matchRoutes(routes, '/dashboard/projects/gym/pulls/pr1').at(-1)!.route.id,
    'v2-projects-p-pulls-id',
  );
});

test('a one-worker project has no Performance tab', () => {
  const tabs = projectTabItems(
    '/p',
    {
      project: { apps: [{ name: 'worker', kind: 'worker' }] },
      repository: null,
    },
    0,
  );
  assert.ok(!tabs.some((tab) => ['Performance', 'Requests'].includes(tab.label)));
});

test('all project tabs and nested details share a single persistent parent segment', () => {
  const paths = [
    '',
    '/code',
    '/work',
    '/pulls',
    '/pulls/1',
    '/issues',
    '/apps/web',
    '/apps/web/settings',
    '/pipelines',
    '/releases',
    '/releases/r1',
    '/requests',
    '/requests/1',
    '/performance',
    '/logs',
    '/settings',
  ];
  const matches = paths.map((suffix) => matchRoutes(routes, `/dashboard/projects/gym${suffix}`));
  for (const matched of matches) {
    assert.equal(matched.at(-2)!.route.id, 'v2-project-layout');
    assert.equal(matched.filter(({ route }) => route.id === 'v2-project-layout').length, 1);
  }
  assert.ok(
    !matchRoutes(routes, '/dashboard/projects').some(
      ({ route }) => route.id === 'v2-project-layout',
    ),
  );
});
