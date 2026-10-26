import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachmentForPath,
  isLocalFilePath,
  rewriteMessagePaths,
  taskFileReference,
} from './task-file-link.ts';

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

test('disk paths are told apart from dashboard routes and web links', () => {
  assert.equal(isLocalFilePath('/var/home/bazzite/.config/deploy.local Node/a.md'), true);
  assert.equal(isLocalFilePath('file:///Users/me/a.md'), true);
  assert.equal(isLocalFilePath('/dashboard?task=1'), false);
  assert.equal(isLocalFilePath('/api/workspace/attachments/1'), false);
  assert.equal(isLocalFilePath('/docs'), false);
  assert.equal(isLocalFilePath('//cdn.example.com/a.js'), false);
  assert.equal(isLocalFilePath('https://example.com/a'), false);
  assert.equal(isLocalFilePath('docs/a.md'), false);
});

const attachments = [
  { id: 'att-1', name: 'phone-task.png', kind: 'image' },
  { id: 'att-2', name: 'build.log', kind: 'text' },
];

test('bare workspace paths in a message become links the task opens', () => {
  assert.equal(
    rewriteMessagePaths('Edited /srv/deploy/workspace/tasks/9f1c2e/app/main.ts:12 today.', {
      task,
    }),
    'Edited [/srv/deploy/workspace/tasks/9f1c2e/app/main.ts:12](</srv/deploy/workspace/tasks/9f1c2e/app/main.ts:12>) today.',
  );
  // A sentence-ending period stays prose, outside the link.
  assert.equal(
    rewriteMessagePaths('See /srv/deploy/workspace/tasks/9f1c2e/README.md.', { task }),
    'See [/srv/deploy/workspace/tasks/9f1c2e/README.md](</srv/deploy/workspace/tasks/9f1c2e/README.md>).',
  );
});

test('bare paths outside the workspace become code, never dead links', () => {
  assert.equal(
    rewriteMessagePaths('Wrote /var/home/bazzite/.config/deploy.local/out.txt there.', { task }),
    'Wrote `/var/home/bazzite/.config/deploy.local/out.txt` there.',
  );
  assert.equal(
    rewriteMessagePaths('/etc/hosts and /var/log/app/run.log', { task }),
    '`/etc/hosts` and `/var/log/app/run.log`',
  );
});

test('bare paths naming attached media open the attachment viewer', () => {
  assert.equal(
    rewriteMessagePaths('Screenshot: /var/home/bazzite/.config/deploy.local/phone-task.png', {
      task,
      attachments,
    }),
    'Screenshot: ![phone-task.png](/api/workspace/attachments/att-1)',
  );
  // An attachment with no viewer still must not look openable.
  assert.equal(
    rewriteMessagePaths('Log at /var/home/bazzite/jobs/build.log', { task, attachments }),
    'Log at `/var/home/bazzite/jobs/build.log`',
  );
  assert.deepEqual(attachmentForPath('/a/b/phone-task.png:3', attachments), attachments[0]);
  assert.equal(attachmentForPath('/a/b/other.png', attachments), null);
});

test('code, links, dashboard routes and web URLs are left exactly as written', () => {
  for (const content of [
    '`/var/home/me/a.txt`',
    '```\n/var/home/me/a.txt\n```',
    '~~~\n/var/home/me/a.txt\n~~~',
    '[report](</var/home/me/a.txt>)',
    '![shot](/api/workspace/attachments/att-1)',
    'Open /dashboard?task=9f1c2e to review',
    'See https://deploy.local/docs/guide/intro for more',
    'Fetched from https://example.com/a/b/c.json',
    'No paths here at all',
  ])
    assert.equal(rewriteMessagePaths(content, { task, attachments }), content, content);
});

test('a path inside a fenced block that reopens is still protected', () => {
  const content = [
    'Before /srv/deploy/workspace/tasks/9f1c2e/a.ts',
    '```ts',
    'const path = "/srv/deploy/workspace/tasks/9f1c2e/a.ts";',
    '```',
    'After /etc/x/y.conf',
  ].join('\n');
  const rewritten = rewriteMessagePaths(content, { task });
  assert.match(rewritten, /^Before \[\/srv/);
  assert.ok(rewritten.includes('const path = "/srv/deploy/workspace/tasks/9f1c2e/a.ts";'));
  assert.ok(rewritten.endsWith('After `/etc/x/y.conf`'));
});
