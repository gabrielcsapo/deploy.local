import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RouterProvider } from 'react-flight-router/client';
import { DataSeeds, type DataSeed } from '../data/seeds';
import Packages from './page.client';
import {
  changeQuery,
  countLine,
  toggleKind,
  kindLabel,
  removalDescription,
  removalPromise,
  removalNotice,
} from './kept-model';
const seed: DataSeed = {
  owner: 'owner',
  at: Date.parse('2026-11-14T12:00:00Z'),
  origin: 'https://registry.example:8443',
  coordinatorName: 'Atlas',
  timeZone: 'UTC',
  data: {},
};
function render(path: string, data: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    h(RouterProvider, {
      initialUrl: path,
      initialSegments: {},
      initialParams: {},
      createFromReadableStream: async () => undefined,
      callServer: async () => undefined,
      children: h(DataSeeds, { seed: { ...seed, data }, children: h(Packages) }),
    }),
  );
}
const list = {
  packages: 51,
  versions: 61,
  bytes: 1024,
  page: 1,
  kinds: { npm: 50, cargo: 1 },
  canRemove: true,
  entries: [
    {
      ecosystem: 'npm',
      name: '@scope/package',
      versions: 3,
      bytes: 1024,
      lastInstalled: '2026-11-14T11:00:00Z',
      needed: 1,
      neededBy: [{ id: 'p', name: 'forma' }],
    },
    {
      ecosystem: 'cargo',
      name: 'tokio',
      versions: 4,
      bytes: 512,
      lastInstalled: '2026-11-09T00:00:00Z',
      needed: 1,
      neededBy: [{ id: 'p', name: 'mdink' }],
    },
  ],
};

test('kind menu cannot untick its final ecosystem and query changes preserve other filters and reset paging', () => {
  assert.equal(toggleKind('all', 'npm'), 'cargo');
  assert.equal(toggleKind('all', 'cargo'), 'npm');
  assert.equal(toggleKind('npm', 'npm'), 'npm');
  assert.equal(toggleKind('cargo', 'cargo'), 'cargo');
  assert.equal(toggleKind('npm', 'cargo'), 'all');
  assert.deepEqual(['all', 'npm', 'cargo'].map(kindLabel), [
    'npm and Cargo',
    'npm only',
    'Cargo only',
  ]);
  const initial = new URLSearchParams('q=tokio&kind=cargo&time=idle&sort=name&page=3');
  assert.equal(
    changeQuery(initial, 'q', 'serde').toString(),
    'q=serde&kind=cargo&time=idle&sort=name',
  );
  assert.equal(changeQuery(initial, 'page', '4').get('page'), '4');
  assert.equal(changeQuery(initial, 'kind', 'all').has('kind'), false);
  assert.equal(initial.get('page'), '3');
});

test('PackagesKept renders search, counts, both kinds, needed tags, scoped links and pager', () => {
  const html = render('/dashboard/packages/kept', { '/api/packages/cache/kept': list });
  for (const text of [
    'Everything kept',
    '51 packages · 61 versions · 1 KB',
    'Search packages and crates',
    'npm and Cargo',
    'npm packages',
    'Cargo crates',
    'Any time',
    'Largest first',
    'Needed by forma',
    'Cargo crate · 4 versions · last installed Nov 9',
    '1–50 of 51',
    'Previous',
    'Next',
  ])
    assert.ok(html.includes(text), text);
  assert.ok(html.includes('/dashboard/packages/kept/npm/%40scope%2Fpackage'));
  assert.match(html, /role="menuitemcheckbox" aria-checked="true"/);
});

test('idle count, footer and remove action match PackagesKeptIdle and admins alone see removal', () => {
  const idle = {
    ...list,
    packages: 1,
    versions: 3,
    entries: [{ ...list.entries[0], needed: 0, neededBy: [] }],
  };
  const html = render('/dashboard/packages/kept?time=idle', {
    '/api/packages/cache/kept?time=idle': idle,
  });
  assert.ok(html.includes('3 versions of 1 packages · 1 KB'));
  assert.ok(html.includes('Versions a project needs are never listed here.'));
  assert.ok(html.includes('Remove 3 versions · 1 KB…'));
  assert.ok(!html.includes('Needed by forma'));
  assert.ok(
    !render('/dashboard/packages/kept?time=idle', {
      '/api/packages/cache/kept?time=idle': { ...idle, canRemove: false },
    }).includes('Remove 3 versions'),
  );
  assert.equal(
    removalDescription(1204, 611, true),
    '1,204 versions of 611 packages and crates that nothing has installed in 30 days.',
  );
  assert.equal(
    removalPromise,
    'Versions locked by a project on main or in a live release stay. Anything removed is fetched again the next time something installs it.',
  );
  assert.equal(removalNotice({ bytes: 1024, keptBytes: 2048 }), 'Removed 1 KB. 2 KB kept.');
});

test('empty, no match, and loading states use the approved copy', () => {
  assert.ok(render('/dashboard/packages/kept').includes('Counting…'));
  const empty = { ...list, packages: 0, versions: 0, bytes: 0, entries: [] };
  assert.ok(
    render('/dashboard/packages/kept', { '/api/packages/cache/kept': empty }).includes(
      'Nothing kept yet. The first install through deploy.local appears here.',
    ),
  );
  const noMatch = render('/dashboard/packages/kept?q=left-pad', {
    '/api/packages/cache/kept?q=left-pad': empty,
  });
  assert.ok(noMatch.includes('No package or crate matches left-pad'));
  assert.ok(noMatch.includes('Clear'));
  assert.equal(
    countLine({ packages: 2903, versions: 18412, bytes: 1024 }, false),
    '2,903 packages · 18,412 versions · 1 KB',
  );
});

test('PackageKept shows the first five versions, needed projects and unused removal', () => {
  const detail = {
    name: 'typescript',
    ecosystem: 'npm',
    totalVersions: 41,
    bytes: 412 * 1024 ** 2,
    neededVersions: 2,
    unusedVersions: 39,
    unusedBytes: 390 * 1024 ** 2,
    canRemove: true,
    neededBy: [{ id: 'p', name: 'forma' }],
    versions: Array.from({ length: 5 }, (_, i) => ({
      version: `5.${9 - i}.0`,
      bytes: 10 * 1024 ** 2,
      lastInstalled: '2026-11-14T11:00:00Z',
      needed: i === 0,
      neededBy: i === 0 ? [{ id: 'p', name: 'forma' }] : [],
    })),
  };
  const html = render('/dashboard/packages/kept/npm/typescript', {
    '/api/packages/cache/entry/npm/typescript': detail,
  });
  for (const text of [
    'npm package · in the copy',
    '41 versions, fetched from npmjs.org',
    '5 of 41, newest first',
    'Show all',
    '39 versions no project needs · 390 MB',
    'Remove unused versions…',
    'Needed by forma',
  ])
    assert.ok(html.includes(text), text);
});

test('PackagesSetup has the approved computer rows in order and uses the request origin', () => {
  const html = render('/dashboard/packages?tab=setup');
  const labels = [
    'Install without signing in',
    'Sign in to publish npm packages',
    'Publish a package by hand',
    'Sign in to publish crates',
    'Publish a crate by hand',
  ];
  let at = -1;
  for (const label of labels) {
    const next = html.indexOf(label);
    assert.ok(next > at, label);
    at = next;
  }
  for (const text of [
    'npm login --registry https://registry.example:8443/npm/',
    'pnpm publish',
    'deploy packages login',
    'cargo publish --registry deploy-local',
    'Lets npm, pnpm and Cargo trust Atlas',
    'Signs you in from the terminal and saves a publishing key for Cargo',
    'From the crate’s folder',
  ])
    assert.ok(html.includes(text), text);
});

test('PackagesCache shows physical storage, protected bytes, idle drill-in and the nothing-idle state', () => {
  const status = {
    sources: [
      { name: 'npmjs.org', reachable: true },
      { name: 'crates.io', reachable: true },
    ],
    projects: [],
    storage: {
      bytes: 6 * 1024 ** 3,
      limit: 20 * 1024 ** 3,
      pinned: 3 * 1024 ** 3,
      days: 90,
      ecosystems: { npm: 5 * 1024 ** 3, cargo: 1024 ** 3 },
    },
    kept: { packages: 2903, versions: 18412, idle: { versions: 1204, bytes: 1.9 * 1024 ** 3 } },
  };
  const html = render('/dashboard/packages?tab=copies', { '/api/packages/cache': status });
  for (const text of [
    'Projects',
    'What’s kept',
    'On Atlas',
    'npm 5 GB · Cargo 1 GB',
    '6 GB of 20 GB',
    'Needed by projects',
    '1,204 versions no project needs',
    'Everything kept',
    'Removes on its own',
    'This copy isn’t backed up. Anything removed is fetched again the next time something installs it.',
  ])
    assert.ok(html.includes(text), text);
  assert.ok(html.includes('/dashboard/packages/kept?time=idle'));
  const empty = render('/dashboard/packages?tab=copies', {
    '/api/packages/cache': { ...status, kept: { ...status.kept, idle: { versions: 0, bytes: 0 } } },
  });
  assert.ok(empty.includes('Everything was installed in the last 30 days'));
  assert.ok(!empty.includes('/dashboard/packages/kept?time=idle'));
});
