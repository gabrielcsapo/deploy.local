import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  idleProject,
  readPinned,
  recentTasks,
  sidebarStorageKey,
  taskRunning,
} from './task-tree.ts';
import {
  setSidebarTaskClosed,
  sidebarRecentsCollapsed,
  toggleTaskPin,
  writeSidebarPreference,
} from './task-sidebar-state.ts';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
test('pins persist per account, remove tasks from Recents and unpin restores membership', () => {
  const storage = memoryStorage();
  const tasks = [
    { id: 'one', title: 'One', status: 'review' },
    { id: 'two', title: 'Two', status: 'running' },
    { id: 'done', title: 'Done', status: 'done' },
  ];
  let pins = toggleTaskPin(readPinned(storage, 'workspace:alice'), 'one');
  writeSidebarPreference(storage, sidebarStorageKey('workspace:alice', 'pinned'), pins);
  assert.deepEqual(readPinned(storage, 'workspace:alice'), ['one']);
  assert.deepEqual(readPinned(storage, 'workspace:bob'), []);
  assert.deepEqual(
    recentTasks(tasks, pins).map((task) => task.id),
    ['two'],
  );
  pins = toggleTaskPin(pins, 'one');
  writeSidebarPreference(storage, sidebarStorageKey('workspace:alice', 'pinned'), pins);
  assert.deepEqual(readPinned(storage, 'workspace:alice'), []);
  assert.deepEqual(
    recentTasks(tasks, pins).map((task) => task.id),
    ['one', 'two'],
  );
});
test('Recents collapse persists and malformed or denied storage remains usable', () => {
  const storage = memoryStorage(),
    key = sidebarStorageKey('workspace:alice', 'recents-collapsed');
  assert.equal(sidebarRecentsCollapsed(storage, key), false);
  writeSidebarPreference(storage, key, true);
  assert.equal(sidebarRecentsCollapsed(storage, key), true);
  writeSidebarPreference(storage, key, false);
  assert.equal(sidebarRecentsCollapsed(storage, key), false);
  storage.setItem(sidebarStorageKey('workspace:alice', 'pinned'), '{');
  assert.deepEqual(readPinned(storage, 'workspace:alice'), []);
  const denied = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
  };
  assert.deepEqual(readPinned(denied, 'workspace:alice'), []);
  assert.equal(sidebarRecentsCollapsed(denied, key), false);
  assert.doesNotThrow(() => writeSidebarPreference(denied, key, true));
});
test('Mark done and Undo call close/reopen with a fresh revision each time', async () => {
  const calls: unknown[] = [];
  let revision = 2;
  const api = async (path: string, body?: Record<string, unknown>) => {
    calls.push([path, body]);
    return body ? { revision: ++revision } : { task: { revision } };
  };
  await setSidebarTaskClosed(api, 'one', true);
  await setSidebarTaskClosed(api, 'one', false);
  assert.deepEqual(calls, [
    ['/tasks/one', undefined],
    ['/tasks/one/close', { revision: 2 }],
    ['/tasks/one', undefined],
    ['/tasks/one/reopen', { revision: 3 }],
  ]);
  await assert.rejects(
    setSidebarTaskClosed(
      async () => {
        throw new Error('offline');
      },
      'one',
      true,
    ),
    /offline/,
  );
});
test('active tasks disable Mark done; idle-project dimming starts at the 30-day boundary', () => {
  for (const status of ['queued', 'starting', 'running', 'checking'])
    assert.equal(taskRunning(status), true);
  for (const status of ['review', 'done', 'failed', 'stopped'])
    assert.equal(taskRunning(status), false);
  const now = Date.parse('2026-10-21T12:00:00Z');
  const age = 30 * 24 * 60 * 60 * 1000;
  const task = (at: number) => ({ id: 'one', title: 'One', updatedAt: new Date(at).toISOString() });
  assert.equal(idleProject([task(now - age + 1)], now), false);
  assert.equal(idleProject([task(now - age)], now), true);
  assert.equal(idleProject([task(now - age - 1)], now), true);
  assert.equal(idleProject([task(now - age - 1), task(now)], now), false);
  assert.equal(idleProject([], now), true);
});
test('row actions preserve selection anchors, prefetch, disabled tooltip and five-second Undo', () => {
  const source = readFileSync(new URL('./task-tree.client.tsx', import.meta.url), 'utf8');
  assert.match(source, /onMouseEnter=\{\(\) => schedulePrefetch\(task.id\)\}/);
  assert.match(source, /<\/a>\s*<ActionCluster/);
  assert.match(source, /disabled=\{running\(task\) \|\| pending === task.id\}/);
  assert.match(source, /Stop active work before marking done/);
  assert.match(source, /setTimeout\(\(\) => setUndo\(undefined\), 5000\)/);
  assert.match(source, /close\(undo, false\)/);
  assert.match(source, /aria-expanded=\{!recentsCollapsed\}/);
});
