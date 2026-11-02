import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sidebarKind, sidebarCollapsed } from './sidebar-preference';

test('wide work surfaces have separate preferences from ordinary pages', () => {
  for (const path of [
    '/dashboard',
    '/dashboard/projects',
    '/dashboard/live',
    '/dashboard/tasks/a',
    '/dashboard/tasks/a/checks',
  ]) {
    assert.equal(sidebarKind(path), 'pages');
  }
  assert.equal(sidebarKind('/dashboard/design'), 'design');
  assert.equal(sidebarKind('/dashboard/tasks/a/changes'), 'changes');
  assert.equal(sidebarKind('/dashboard/projects/a/code'), 'code');
  assert.equal(sidebarKind('/dashboard/projects/a/code/src/app.ts'), 'code');
});

test('defaults and saved choices survive unavailable or invalid storage', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    assert.equal(sidebarCollapsed('pages'), false);
    for (const kind of ['design', 'changes', 'code'] as const)
      assert.equal(sidebarCollapsed(kind), true);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) =>
          ({
            'deploy.sidebar.pages': 'true',
            'deploy.sidebar.design': 'false',
            'deploy.sidebar.code': 'invalid',
          })[key],
      },
    });
    assert.equal(sidebarCollapsed('pages'), true);
    assert.equal(sidebarCollapsed('design'), false);
    assert.equal(sidebarCollapsed('code'), true);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
