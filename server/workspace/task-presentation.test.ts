import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'publish-presentation-'));
process.env.DEPLOY_DATA_DIR = directory;
const { taskPullSummary, publishDescription, stripWorkspaceLinks } =
  await import('./task-presentation.ts');
const { db } = await import('./store.ts');
after(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

test('task summary derives only same-project linked open or merged pulls', () => {
  const task = { id: 'task', projectId: 'project', status: 'review' };
  const pull = { id: 'pull', projectId: 'project', taskIds: ['task'], number: 5, status: 'open' };
  assert.equal(taskPullSummary(task, []).pull, null);
  assert.equal(taskPullSummary(task, [{ ...pull, status: 'closed' }]).pull, null);
  assert.equal(taskPullSummary(task, [{ ...pull, projectId: 'other' }]).pull, null);
  assert.deepEqual(taskPullSummary(task, [{ ...pull, status: 'merged' }, pull]).pull, {
    id: 'pull',
    number: 5,
    status: 'open',
  });
  assert.equal(taskPullSummary(task, [{ ...pull, status: 'merged' }]).pull?.status, 'merged');
  assert.equal(taskPullSummary(task, [pull]).status, 'review');
});

test('description uses latest final Markdown and recorded checks without inventing success', () => {
  const task = { title: 'Editorial title', workspacePath: '/Users/worker/task' };
  const messages = [
    { role: 'user', content: 'Opening prompt' },
    { role: 'assistant', content: 'Old summary' },
    { role: 'assistant', content: '**Done** in [app.ts](/Users/worker/task/src/app.ts:12).' },
    { role: 'assistant', content: 'Still inspecting', isProgress: true },
  ];
  const body = publishDescription(
    task,
    messages,
    [
      { command: 'lint', status: 'succeeded', exitCode: 0 },
      { command: 'test', status: 'failed', exitCode: 1 },
      { command: 'build', status: 'cancelled', exitCode: 0 },
      { command: 'unknown', status: 'unknown' },
      { command: 'legacy', exitCode: 0 },
    ],
    [{ name: 'iOS', status: 'queued' }],
  );
  assert.match(body, /\*\*Done\*\* in src\/app.ts\./);
  assert.doesNotMatch(body, /Old summary|Still inspecting|\/Users\//);
  assert.match(body, /lint: Passed/);
  assert.match(body, /test: Failed/);
  assert.match(body, /build: Not run \(cancelled\)/);
  assert.match(body, /unknown: Not run \(unknown\)/);
  assert.match(body, /legacy: Passed/);
  assert.match(body, /iOS: Not run \(queued\)/);
  assert.match(body, /Task: Editorial title/);
  const empty = publishDescription(task, [], [], []);
  assert.match(empty, /Not run \(no recorded checks or jobs\)/);
  assert.doesNotMatch(empty, /Passed|Failed/);
});

test('workspace links become plain relative paths and external links survive', () => {
  assert.equal(
    stripWorkspaceLinks(
      '[file](</work/task/a b.ts:2>) [encoded](file:///work/task/a%20b.ts#L4) [other](/private/other/secret.ts:1) [site](https://example.com/doc)',
      '/work/task',
    ),
    'a b.ts a b.ts secret.ts [site](https://example.com/doc)',
  );
});

test('reference links become plain paths, including remote worker workspaces', () => {
  const body = publishDescription(
    { title: 'Task', workspacePath: '/server/task', remoteWorkspacePath: '/mac/task' },
    [
      {
        role: 'assistant',
        content: '[source][code] and [code].\n\n[code]: /mac/task/src/main.ts:5',
      },
    ],
    [],
    [],
  );
  assert.match(body, /src\/main.ts and src\/main.ts\./);
  assert.doesNotMatch(body, /\[code\]|\/mac\/task/);
});
