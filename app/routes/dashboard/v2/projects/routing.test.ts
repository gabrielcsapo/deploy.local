import test from 'node:test';
import assert from 'node:assert/strict';
import { appPath, appTabItems, projectTabItems } from './routing.ts';
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

test('one-app projects retain code, pull requests and issues alongside app tabs', () => {
  const tabs = projectTabItems(
    '/p',
    {
      project: { apps: [{ name: 'web', kind: 'web' }] },
      repository: {},
      pulls: [{ state: 'open' }],
      issues: [{}],
    },
    0,
  );
  assert.deepEqual(
    tabs.map((tab) => tab.label),
    [
      'Overview',
      'Code',
      'Pull requests',
      'Issues',
      'Releases',
      'Requests',
      'Performance',
      'Logs',
      'Settings',
    ],
  );
  assert.equal(tabs.find((tab) => tab.label === 'Overview')?.href, '/p');
  assert.equal(tabs.find((tab) => tab.label === 'Requests')?.href, '/p/requests');
  assert.equal(tabs.find((tab) => tab.label === 'Performance')?.href, '/p/performance');
  assert.equal(tabs.find((tab) => tab.label === 'Settings')?.href, '/p/apps/web/settings');
  assert.equal(tabs.find((tab) => tab.label === 'Pull requests')?.count, 1);
});

test('a one-worker project has no Performance tab', () => {
  const tabs = projectTabItems(
    '/p',
    {
      project: { apps: [{ name: 'worker', kind: 'worker' }] },
      repository: null,
      pulls: [],
      issues: [],
    },
    0,
  );
  assert.ok(!tabs.some((tab) => ['Performance', 'Requests'].includes(tab.label)));
});
