import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
const data = mkdtempSync(join(tmpdir(), 'deploy-publish-test-'));
process.env.DEPLOY_DATA_DIR = data;
const { workspaceApi } = await import('./api.ts');
const { createProject, createTask } = await import('./test-repository.ts');
const { git } = await import('./service.ts');
const { repositoryGit } = await import('./repository-git.ts');
const { db, save, list } = await import('./store.ts');
after(() => {
  db.close();
  rmSync(data, { recursive: true, force: true });
});
// Exercise routing, authentication scope and the command journal without binding a TCP port.
async function request(path: string, body?: any, headers: Record<string, string> = {}) {
  const req = Object.assign(
    Readable.from(
      body === undefined ? [] : [JSON.stringify({ operationId: randomUUID(), ...body })],
    ),
    {
      url: '/api/workspace' + path,
      method: body === undefined ? 'GET' : 'POST',
      headers,
    },
  );
  let status = 0,
    result = '';
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(value: string) {
      result = value;
    },
  };
  await workspaceApi(
    req as any,
    res as any,
    headers['x-owner'] || 'alice',
    headers['x-worker'] ? 'limited-worker' : undefined,
  );
  return { status, body: JSON.parse(result) as any };
}
function fixture() {
  const source = join(data, randomUUID());
  mkdirSync(source);
  git(source, ['init', '--initial-branch=main']);
  git(source, ['config', 'user.name', 'Test']);
  git(source, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(source, 'source.txt'), 'base\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'Base']);
  const base = git(source, ['rev-parse', 'HEAD']);
  const project = createProject('alice', { name: 'Project', sourcePath: source });
  return { project, source, base };
}

test('publishing creates a task branch and linked pull, supports binaries, deletions and new directories, and replays idempotently', async () => {
  const f = fixture();
  const task = createTask('alice', { projectId: f.project.id, title: 'Publish these changes' });
  mkdirSync(join(task.workspacePath, 'new', 'nested'), { recursive: true });
  writeFileSync(join(task.workspacePath, 'new', 'nested', 'hello.txt'), 'hello\n');
  writeFileSync(join(task.workspacePath, 'new', 'picture.bin'), Buffer.from([0, 1, 255, 0, 42]));
  rmSync(join(task.workspacePath, 'source.txt'));
  const input = {
    operationId: randomUUID(),
    revision: task.revision,
    title: 'Publish changes',
    body: 'Description',
  };
  const path = `/tasks/${task.id}/publish`;
  assert.equal((await request(path, input, { 'x-owner': 'bob' })).status, 404);
  assert.equal((await request(path, input, { 'x-worker': '1' })).status, 403);
  const result = await request(path, input);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const { pull, branch, commit } = result.body;
  assert.equal(branch, `task/${task.id.replaceAll('-', '').slice(0, 8)}`);
  assert.equal(pull.sourceBranch, branch);
  assert.equal(pull.targetBranch, 'main');
  assert.deepEqual(pull.taskIds, [task.id]);
  assert.equal(pull.title, 'Publish changes');
  assert.equal(git(f.project.repositoryPath, ['show', `${commit}:new/nested/hello.txt`]), 'hello');
  assert.deepEqual(
    await repositoryGit(f.project.repositoryPath, ['show', `${commit}:new/picture.bin`]),
    Buffer.from([0, 1, 255, 0, 42]),
  );
  assert.throws(() => git(f.project.repositoryPath, ['show', `${commit}:source.txt`]));
  assert.equal(
    git(f.project.repositoryPath, ['show', '-s', '--format=%an <%ae>', commit]),
    'alice <alice@deploy.local>',
  );
  assert.match(
    git(f.project.repositoryPath, ['show', '-s', '--format=%B', commit]),
    new RegExp(`Task: ${task.id}`),
  );
  assert.equal(git(f.project.repositoryPath, ['rev-parse', 'main']), f.base);
  assert.deepEqual((await request(path, input)).body, result.body);
  assert.equal((await request(path, { ...input, title: 'Different' })).status, 409);
  assert.equal((await request(`/tasks/${task.id}/diff`)).body.hasUnpublishedChanges, false);
  assert.ok(list('pipeline-trigger-request', 'alice').some((r) => r.commit === commit));
});

test('republishing adds a commit to the same pull request and queues fresh checks', async () => {
  const f = fixture();
  const task = createTask('alice', { projectId: f.project.id });
  writeFileSync(join(task.workspacePath, 'source.txt'), 'first\n');
  const path = `/tasks/${task.id}/publish`;
  const first = await request(path, { revision: 0 });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  writeFileSync(join(task.workspacePath, 'source.txt'), 'second\n');
  assert.equal((await request(`/tasks/${task.id}/diff`)).body.hasUnpublishedChanges, true);
  const second = await request(path, { revision: 1 });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.pull.id, first.body.pull.id);
  assert.equal(second.body.branch, first.body.branch);
  assert.notEqual(second.body.commit, first.body.commit);
  assert.equal(
    git(f.project.repositoryPath, ['rev-parse', `${second.body.commit}^`]),
    first.body.commit,
  );
  assert.equal(
    git(f.project.repositoryPath, ['show', `${second.body.commit}:source.txt`]),
    'second',
  );
  assert.equal((await request(path, { revision: 2 })).status, 409);
});

test('publish refuses empty, busy, unready, truncated and missing remote diffs', async () => {
  const f = fixture();
  const task = createTask('alice', { projectId: f.project.id });
  const path = `/tasks/${task.id}/publish`;
  const empty = await request(path, { revision: 0 });
  assert.equal(empty.status, 409);
  assert.match(empty.body.error, /empty/);
  writeFileSync(join(task.workspacePath, 'source.txt'), 'change\n');
  for (const kind of ['run', 'check', 'job']) {
    const record = { id: randomUUID(), taskId: task.id, status: 'running' };
    save(kind, 'alice', record);
    const busy = await request(path, { revision: 0 });
    assert.equal(busy.status, 409);
    assert.match(busy.body.error, /active/);
    save(kind, 'alice', { ...record, status: 'succeeded' });
  }
  save('task', 'alice', { ...task, workspaceStatus: 'preparing' });
  assert.match((await request(path, { revision: 0 })).body.error, /not ready/);
  save('task', 'alice', { ...task, workerId: 'remote', workspaceStatus: 'ready' });
  assert.match((await request(path, { revision: 0 })).body.error, /unavailable/);
  const { diff } = await import('./service.ts');
  save('task', 'alice', task);
  const snapshot = diff('alice', task.id);
  save('task', 'alice', { ...task, workerId: 'remote', workspaceStatus: 'ready' });
  save('remote-diff', 'alice', { ...snapshot, id: task.id, truncated: true });
  assert.match((await request(path, { revision: 0 })).body.error, /truncated/);
  save('remote-diff', 'alice', { ...snapshot, id: task.id });
  assert.equal((await request(path, { revision: 0 })).status, 200);
});

test('publishing refuses a conflicting branch move with rebase guidance', async () => {
  const f = fixture();
  const task = createTask('alice', { projectId: f.project.id });
  writeFileSync(join(task.workspacePath, 'source.txt'), 'first\n');
  const path = `/tasks/${task.id}/publish`;
  const first = (await request(path, { revision: 0 })).body;
  git(f.source, ['fetch', f.project.repositoryPath, first.branch]);
  git(f.source, ['checkout', '-b', 'other', 'FETCH_HEAD']);
  writeFileSync(join(f.source, 'source.txt'), 'external\n');
  git(f.source, ['commit', '-am', 'External change']);
  git(f.source, ['push', f.project.repositoryPath, `HEAD:${first.branch}`]);
  writeFileSync(join(task.workspacePath, 'source.txt'), 'second\n');
  const result = await request(path, { revision: 1 });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /branch moved.*rebase/);
});

test('publish receipts recover a lost command acknowledgment without adding a commit or replacing later PR edits', async () => {
  const f = fixture();
  const task = createTask('alice', { projectId: f.project.id });
  writeFileSync(join(task.workspacePath, 'source.txt'), 'first\n');
  const path = `/tasks/${task.id}/publish`;
  const input = { revision: 0, operationId: randomUUID() };
  const first = await request(path, input);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const edited = { ...first.body.pull, title: 'Later editorial change', revision: 1 };
  save('pull-request', 'alice', edited);
  // A ref receipt survives even if SQLite never recorded the command result.
  db.prepare('DELETE FROM operations WHERE owner=? AND id=?').run('alice', input.operationId);
  save('task', 'alice', task);
  const replay = await request(path, input);
  assert.deepEqual(replay.body, first.body);
  assert.equal((await request(`/tasks/${task.id}`)).body.task.publishedCommit, first.body.commit);
  assert.equal(
    (await request(`/projects/${f.project.id}/pulls/${edited.id}`)).body.record.title,
    edited.title,
  );
  assert.equal(git(f.project.repositoryPath, ['rev-parse', first.body.branch]), first.body.commit);
});

test('publish retains blank patch context and tracked binary contents on later updates', async () => {
  const f = fixture();
  const task = createTask('alice', { projectId: f.project.id });
  const binary = join(task.workspacePath, 'file.bin');
  writeFileSync(binary, Buffer.from([0, 1, 2]));
  writeFileSync(join(task.workspacePath, 'source.txt'), 'first\n\n');
  const first = await request(`/tasks/${task.id}/publish`, { revision: 0 });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  writeFileSync(binary, Buffer.from([0, 255, 3]));
  writeFileSync(join(task.workspacePath, 'source.txt'), 'second\n\n');
  const second = await request(`/tasks/${task.id}/publish`, { revision: 1 });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.deepEqual(
    await repositoryGit(f.project.repositoryPath, ['show', `${second.body.commit}:source.txt`]),
    Buffer.from('second\n\n'),
  );
  assert.deepEqual(
    await repositoryGit(f.project.repositoryPath, ['show', `${second.body.commit}:file.bin`]),
    Buffer.from([0, 255, 3]),
  );
});

test('publishing updates an existing linked pull branch and preserves unrelated branch changes', async () => {
  const f = fixture();
  const task = createTask('alice', { projectId: f.project.id });
  git(f.project.repositoryPath, ['branch', 'hand-pushed', f.base]);
  const pull = await request(`/projects/${f.project.id}/pulls`, {
    title: 'Existing review',
    sourceBranch: 'hand-pushed',
    taskIds: [task.id],
  });
  assert.equal(pull.status, 200);
  writeFileSync(join(task.workspacePath, 'source.txt'), 'task change\n');
  const first = await request(`/tasks/${task.id}/publish`, { revision: 0 });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.pull.id, pull.body.id);
  assert.equal(first.body.branch, 'hand-pushed');
  git(f.source, ['fetch', f.project.repositoryPath, 'hand-pushed']);
  git(f.source, ['checkout', '-b', 'external', 'FETCH_HEAD']);
  writeFileSync(join(f.source, 'external.txt'), 'external\n');
  git(f.source, ['add', '.']);
  git(f.source, ['commit', '-m', 'External addition']);
  const external = git(f.source, ['rev-parse', 'HEAD']);
  git(f.source, ['push', f.project.repositoryPath, 'HEAD:hand-pushed']);
  writeFileSync(join(task.workspacePath, 'source.txt'), 'next task change\n');
  const next = await request(`/tasks/${task.id}/publish`, { revision: 1 });
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.equal(git(f.project.repositoryPath, ['rev-parse', `${next.body.commit}^`]), external);
  assert.equal(
    git(f.project.repositoryPath, ['show', `${next.body.commit}:external.txt`]),
    'external',
  );
  assert.ok(list('pipeline-trigger-request', 'alice').some((r) => r.commit === next.body.commit));
});

test('publishing refuses excluded files rather than silently omitting their contents', async () => {
  const f = fixture();
  const task = createTask('alice', { projectId: f.project.id });
  writeFileSync(join(task.workspacePath, 'source.txt'), 'task change\n');
  writeFileSync(join(task.workspacePath, 'large.bin'), Buffer.alloc(256001));
  const result = await request(`/tasks/${task.id}/publish`, { revision: 0 });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /excluded files/);
});

test('publish defaults come from real task records; listings and detail expose linked review; updates preserve editorial descriptions', async () => {
  const f = fixture();
  const prompt =
    'Show elapsed time as HH:MM:SS in 24 hour format with a clear label for every task';
  const task = createTask('alice', { projectId: f.project.id, title: prompt.slice(0, 72) });
  save('message', 'alice', {
    id: randomUUID(),
    taskId: task.id,
    role: 'user',
    content: prompt,
    createdAt: '2026-10-19T10:00:00Z',
  });
  save('message', 'alice', {
    id: randomUUID(),
    taskId: task.id,
    role: 'assistant',
    content: `Updated [source](${task.workspacePath}/source.txt:1).`,
    createdAt: '2026-10-19T11:00:00Z',
  });
  save('check', 'alice', {
    id: randomUUID(),
    taskId: task.id,
    command: 'test',
    status: 'failed',
    exitCode: 1,
  });
  writeFileSync(join(task.workspacePath, 'source.txt'), 'published\n');
  const detail = (await request(`/tasks/${task.id}`)).body;
  const { taskTitle } = await import('../../shared/task-title.ts');
  assert.equal(detail.publishDefaults.title, taskTitle(prompt));
  assert.match(detail.publishDefaults.body, /Updated source.txt\./);
  assert.match(detail.publishDefaults.body, /test: Failed/);
  const first = await request(`/tasks/${task.id}/publish`, { revision: 0 });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.pull.title, detail.publishDefaults.title);
  assert.equal(first.body.pull.body, detail.publishDefaults.body);
  const summary = { id: first.body.pull.id, number: first.body.pull.number, status: 'open' };
  assert.deepEqual((await request(`/tasks/${task.id}`)).body.task.pull, summary);
  assert.deepEqual(
    (await request('/state')).body.tasks.find((t: any) => t.id === task.id).pull,
    summary,
  );
  save('pull-request', 'alice', {
    ...first.body.pull,
    revision: 1,
    body: 'Description edited by a reviewer',
  });
  writeFileSync(join(task.workspacePath, 'source.txt'), 'updated\n');
  const input = { revision: 1, body: 'Stale client description', operationId: randomUUID() };
  const updated = await request(`/tasks/${task.id}/publish`, input);
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.pull.body, 'Description edited by a reviewer');
  await request(`/tasks/${task.id}/publish`, input);
  const comments = (await request(`/projects/${f.project.id}/pulls/${summary.id}`)).body.comments;
  assert.deepEqual(
    comments.map((c: any) => c.body),
    ['Updated: 1 file changed in this turn'],
  );
  save('pull-request', 'alice', { ...updated.body.pull, status: 'closed' });
  assert.equal((await request(`/tasks/${task.id}`)).body.task.pull, null);
});
