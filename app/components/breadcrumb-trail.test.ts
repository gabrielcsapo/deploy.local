import assert from 'node:assert/strict';
import test from 'node:test';
import { dashboardBreadcrumbs } from './breadcrumb-trail.ts';

test('computers and legacy nodes have one capitalized crumb and no implicit Overview', () => {
  for (const route of ['computers', 'nodes']) {
    assert.deepEqual(dashboardBreadcrumbs(`/dashboard/${route}`), [
      { label: 'Computers', href: `/dashboard/${route}`, current: true },
    ]);
  }
});

test('known dashboard segments are labeled while app names keep their identity and Overview', () => {
  for (const [route, label] of [
    ['projects', 'Projects'],
    ['repositories', 'Repositories'],
    ['settings', 'Settings'],
  ]) {
    assert.deepEqual(
      dashboardBreadcrumbs(`/dashboard/${route}`).map((c) => c.label),
      ['Workspace', label],
    );
  }
  assert.deepEqual(
    dashboardBreadcrumbs('/dashboard/my-app').map((c) => [c.label, c.current]),
    [
      ['Workspace', false],
      ['my-app', false],
      ['Overview', true],
    ],
  );
});
