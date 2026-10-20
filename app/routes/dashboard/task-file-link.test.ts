import assert from 'node:assert/strict';
import test from 'node:test';
import { taskFileReference } from './task-file-link.ts';

const task = {
  id: '9f1c2e',
  workspacePath: '/srv/deploy/workspace/tasks/9f1c2e',
  remoteWorkspacePath:
    '/home/gabrielcsapo/.local/share/deploy.local/task-workers/managed-77be/tasks/9f1c2e',
};

test('worker paths inside the task workspace become repository paths with a line', () => {
  assert.deepEqual(
    taskFileReference(
      '/home/gabrielcsapo/.local/share/deploy.local/task-workers/managed-77be/tasks/9f1c2e/web/format-time.mjs:1',
      task,
    ),
    { path: 'web/format-time.mjs', line: 1 },
  );
  assert.deepEqual(taskFileReference('/srv/deploy/workspace/tasks/9f1c2e/src/app.ts:12:5', task), {
    path: 'src/app.ts',
    line: 12,
  });
  assert.deepEqual(
    taskFileReference('file:///srv/deploy/workspace/tasks/9f1c2e/README.md#L40-L44', task),
    { path: 'README.md', line: 40 },
  );
  assert.deepEqual(taskFileReference('/srv/deploy/workspace/tasks/9f1c2e/My%20File.md', task), {
    path: 'My File.md',
  });
});

test('a worker root the client has not seen still maps through the task id', () => {
  assert.deepEqual(
    taskFileReference(
      '/Users/me/.local/share/deploy.local/task-workers/mac/tasks/9f1c2e/a/b.swift:7',
      {
        id: '9f1c2e',
      },
    ),
    { path: 'a/b.swift', line: 7 },
  );
});

test('relative links are repository paths', () => {
  assert.deepEqual(taskFileReference('./server/api.ts:3', task), {
    path: 'server/api.ts',
    line: 3,
  });
  assert.deepEqual(taskFileReference('package.json', task), { path: 'package.json' });
});

test('external links, anchors and paths outside the workspace are left alone', () => {
  for (const href of [
    'https://example.com/tasks/9f1c2e/a.ts',
    'mailto:me@example.com',
    '#section',
    '//cdn.example.com/a.js',
    '/srv/deploy/workspace/tasks/other/a.ts',
    '/etc/hosts',
    '/srv/deploy/workspace/tasks/9f1c2e/../secret',
    '/srv/deploy/workspace/tasks/9f1c2e/',
    '',
    undefined,
  ])
    assert.equal(taskFileReference(href, task), null, String(href));
});
