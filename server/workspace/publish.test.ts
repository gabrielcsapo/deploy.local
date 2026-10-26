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
const { db, save, list, get } = await import('./store.ts');
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
  assert.equal(get('task', 'alice', task.id).publishedMessageId, null);
  save('message', 'alice', {
    id: randomUUID(),
    taskId: task.id,
    role: 'user',
    content: 'Follow up after a publish without messages',
    createdAt: '2026-10-19T10:00:00.000Z',
  });
  writeFileSync(join(task.workspacePath, 'source.txt'), 'second\n');
  assert.equal((await request(`/tasks/${task.id}/diff`)).body.hasUnpublishedChanges, true);
  const second = await request(path, { revision: 1 });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.pull.id, first.body.pull.id);
  assert.equal(second.body.branch, first.body.branch);
  assert.notEqual(second.body.commit, first.body.commit);
  assert.equal(
    git(f.project.repositoryPath, ['show', '-s', '--format=%B', second.body.commit]),
    // The subject describes the change (the task's own title), not the latest message.
    `New task\n\n- Follow up after a publish without messages\n\nTask: ${task.id}`,
  );
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

test('publishing refuses a conflicting branch move with guidance the owner can act on', async () => {
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
  // Owner-facing guidance: no "rebase" instruction the owner has no button for.
  assert.match(result.body.error, /moved and this task's changes conflict.*Merge or revert/);
  assert.doesNotMatch(result.body.error, /rebase|refresh the task/i);
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

test('follow-up messages do not title the change, and a chatty final message yields the commit', async () => {
  const f = fixture();
  const prompt = 'Please make the published pull requests read well.';
  const task = createTask('alice', { projectId: f.project.id, title: prompt });
  const message = (role: string, content: string, createdAt: string) =>
    save('message', 'alice', { id: randomUUID(), taskId: task.id, role, content, createdAt });
  message('user', prompt, '2026-10-19T10:00:00Z');
  message('user', 'The 8 MiB checkpoint limit is fixed now, so retry.', '2026-10-19T11:00:00Z');
  message('assistant', 'No PR was created; nothing was merged.', '2026-10-19T12:00:00Z');
  writeFileSync(join(task.workspacePath, 'source.txt'), 'published\n');
  const defaults = (await request(`/tasks/${task.id}`)).body.publishDefaults;
  assert.equal(defaults.title, 'Make the published pull requests read well');
  assert.equal(
    defaults.body,
    [
      'Request: Please make the published pull requests read well.',
      '',
      'Changed 1 file across 1 area:',
      '- repository root: 1 file, +1 −1',
      '',
      '## Checks',
      '- Not run (no recorded checks or jobs).',
    ].join('\n'),
  );
  const published = await request(`/tasks/${task.id}/publish`, { revision: 0 });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.pull.title, defaults.title);
  assert.equal(
    git(f.project.repositoryPath, ['show', '-s', '--format=%s', published.body.commit]),
    defaults.title,
  );
});

test('updates fill untouched empty descriptions and preserve nonempty or edited descriptions', async () => {
  for (const [body, revision, shouldFill] of [
    ['', 0, true],
    [' \n\t ', 0, true],
    ['Original description', 0, false],
    ['', 1, false],
    ['Description edited by a reviewer', 1, false],
  ] as const) {
    const f = fixture();
    const task = createTask('alice', { projectId: f.project.id, title: 'Describe changes' });
    git(f.project.repositoryPath, ['branch', 'existing', f.base]);
    const created = await request(`/projects/${f.project.id}/pulls`, {
      title: 'Existing pull',
      body,
      sourceBranch: 'existing',
      taskIds: [task.id],
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    save('pull-request', 'alice', { ...created.body, revision });
    save('message', 'alice', {
      id: randomUUID(),
      taskId: task.id,
      role: 'assistant',
      content: `Updated [source](${task.workspacePath}/source.txt:1).`,
    });
    save('check', 'alice', {
      id: randomUUID(),
      taskId: task.id,
      command: 'test',
      status: 'succeeded',
      exitCode: 0,
    });
    writeFileSync(join(task.workspacePath, 'source.txt'), 'updated\n');
    const defaults = (await request(`/tasks/${task.id}`)).body.publishDefaults;
    const updated = await request(`/tasks/${task.id}/publish`, {
      revision: 0,
      body: 'Stale client description',
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.pull.body, shouldFill ? defaults.body : body);
    assert.equal(updated.body.pull.revision, revision + (shouldFill ? 1 : 0));
    assert.equal(get('pull-request', 'alice', created.body.id).body, updated.body.pull.body);
    if (shouldFill) {
      assert.match(updated.body.pull.body, /Updated source.txt\./);
      assert.match(updated.body.pull.body, /test: Passed/);
      assert.match(updated.body.pull.body, /^Request: Describe changes\n/);
    }
  }
});

test('publish commit messages cover requests since the previous publish and replay unchanged', async () => {
  const f = fixture();
  const task = createTask('alice', { projectId: f.project.id, title: 'Editorial PR title' });
  const path = `/tasks/${task.id}/publish`;
  const message = (content: string, role = 'user') =>
    save('message', 'alice', {
      id: randomUUID(),
      taskId: task.id,
      role,
      content,
      // The message ID, rather than a timestamp comparison, separates later requests.
      createdAt: '2026-10-19T10:00:00.000Z',
    });
  message(`Fix [source](${task.workspacePath}/source.txt:1).\nKeep the existing behavior.`);
  const latest = message(
    `Add regression coverage for ${task.workspacePath}/source.txt with a clear explanation of every edge case`,
  );
  message('Agent summary should not become a commit request', 'assistant');
  writeFileSync(join(task.workspacePath, 'source.txt'), 'first\n');
  const firstInput = { revision: 0, operationId: randomUUID() };
  const first = await request(path, firstInput);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const firstMessage = git(f.project.repositoryPath, [
    'show',
    '-s',
    '--format=%B',
    first.body.commit,
  ]);
  assert.equal(
    firstMessage,
    `Editorial PR title\n\n- Fix source.txt. Keep the existing behavior.\n- Add regression coverage for source.txt with a clear explanation of every edge case\n\nTask: ${task.id}`,
  );
  assert.ok([...firstMessage.split('\n')[0]].length <= 72);
  assert.equal(get('task', 'alice', task.id).publishedMessageId, latest.id);
  assert.equal(first.body.pull.title, 'Editorial PR title');

  message('Handle /Users/worker/private/extra.txt too.');
  const last = message('Verify\n\tthe follow-up changes.');
  writeFileSync(join(task.workspacePath, 'source.txt'), 'second\n');
  const secondInput = { revision: 1, operationId: randomUUID() };
  const second = await request(path, secondInput);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const secondMessage = git(f.project.repositoryPath, [
    'show',
    '-s',
    '--format=%B',
    second.body.commit,
  ]);
  // Later commits head with the same change title; their bodies list the requests they cover.
  assert.equal(
    secondMessage,
    `Editorial PR title\n\n- Handle extra.txt too.\n- Verify the follow-up changes.\n\nTask: ${task.id}`,
  );
  assert.equal(get('task', 'alice', task.id).publishedMessageId, last.id);

  message('A request after publishing must not change a replay.');
  assert.deepEqual((await request(path, firstInput)).body, first.body);
  assert.deepEqual((await request(path, secondInput)).body, second.body);
  // Exercise Git receipt recovery as well as the SQLite command journal.
  db.prepare('DELETE FROM operations WHERE owner=? AND id=?').run('alice', secondInput.operationId);
  save('task', 'alice', {
    ...get('task', 'alice', task.id),
    publishedAt: null,
    publishedMessageId: null,
  });
  assert.deepEqual((await request(path, secondInput)).body, second.body);
  assert.equal(get('task', 'alice', task.id).publishedMessageId, last.id);
  assert.equal(
    git(f.project.repositoryPath, ['rev-parse', second.body.branch]),
    second.body.commit,
  );
  assert.equal(
    git(f.project.repositoryPath, ['rev-list', '--count', `${f.base}..${second.body.branch}`]),
    '2',
  );
  assert.equal(
    git(f.project.repositoryPath, ['show', '-s', '--format=%B', second.body.commit]),
    secondMessage,
  );
});

test('legacy publishes use the recorded publish time as the request boundary', async () => {
  const f = fixture();
  const task = createTask('alice', { projectId: f.project.id });
  const path = `/tasks/${task.id}/publish`;
  save('message', 'alice', {
    id: randomUUID(),
    taskId: task.id,
    role: 'user',
    content: 'Earlier request',
    createdAt: '2026-10-19T10:00:00.000Z',
  });
  writeFileSync(join(task.workspacePath, 'source.txt'), 'first\n');
  const first = await request(path, { revision: 0 });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const legacy = get('task', 'alice', task.id);
  delete legacy.publishedMessageId;
  save('task', 'alice', { ...legacy, publishedAt: '2026-10-19T11:00:00.000Z' });
  save('message', 'alice', {
    id: randomUUID(),
    taskId: task.id,
    role: 'user',
    content: 'Later request',
    createdAt: '2026-10-19T12:00:00.000Z',
  });
  writeFileSync(join(task.workspacePath, 'source.txt'), 'second\n');
  const second = await request(path, { revision: 1 });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(
    git(f.project.repositoryPath, ['show', '-s', '--format=%B', second.body.commit]),
    `New task\n\n- Later request\n\nTask: ${task.id}`,
  );
});

async function checkpointFixture() {
  const f = fixture();
  const task = createTask('alice', { projectId: f.project.id, title: 'Publish complete app' });
  // A real Git workspace produces the checkpoint; timestamps model a capture after reporting.
  for (let i = 0; i < 43; i++)
    writeFileSync(join(task.workspacePath, `app-${i}.txt`), `file ${i}\n`.repeat(1500));
  const { captureSnapshot } = await import('./checkpoint.ts');
  const snapshot = captureSnapshot(task.workspacePath);
  const run = save('run', 'alice', {
    id: randomUUID(),
    taskId: task.id,
    status: 'succeeded',
    workerId: 'remote',
    completedAt: '2026-10-23T12:00:00.000Z',
    updatedAt: '2026-10-23T12:00:00.000Z',
  });
  const checkpoint = save('checkpoint', 'alice', {
    id: randomUUID(),
    taskId: task.id,
    runId: run.id,
    snapshot,
    createdAt: '2026-10-23T12:05:00.000Z',
  });
  save('task', 'alice', { ...task, workerId: 'remote' });
  save('remote-diff', 'alice', {
    id: task.id,
    taskId: task.id,
    baseRevision: task.baseRevision,
    patch: 'partial',
    truncated: true,
    excluded: [],
    files: [],
    status: '?? app-0.txt',
    hasUnpublishedChanges: false,
    receivedAt: '2026-10-23T12:01:00.000Z',
  });
  return { ...f, task, run, checkpoint };
}

test('checkpoint publish commits the exact full tree and replays both journal and receipt', async () => {
  const { project, task, checkpoint } = await checkpointFixture();
  const detail = (await request(`/tasks/${task.id}`)).body;
  assert.deepEqual(detail.latestCheckpoint, {
    id: checkpoint.id,
    createdAt: checkpoint.createdAt,
    fileCount: 44,
    // source.txt is unchanged from the base; only the 43 new files count as changes.
    changedFileCount: 43,
    fresh: true,
    reason: null,
  });
  assert.equal((await request(`/tasks/${task.id}/diff`)).body.hasUnpublishedChanges, true);
  const path = `/tasks/${task.id}/publish`;
  const input = { revision: 0, checkpointId: checkpoint.id, operationId: randomUUID() };
  const result = await request(path, input);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(get('task', 'alice', task.id).publishedCheckpointId, checkpoint.id);
  assert.deepEqual(result.body.pull.taskIds, [task.id]);
  assert.equal(result.body.branch, `task/${task.id.replaceAll('-', '').slice(0, 8)}`);
  const entries = git(project.repositoryPath, [
    'ls-tree',
    '-r',
    '--name-only',
    result.body.commit,
  ]).split('\n');
  assert.deepEqual(entries.sort(), checkpoint.snapshot.files.map((file: any) => file.path).sort());
  for (const file of checkpoint.snapshot.files) {
    assert.deepEqual(
      await repositoryGit(project.repositoryPath, ['show', `${result.body.commit}:${file.path}`]),
      Buffer.from(file.content, 'base64'),
    );
  }
  assert.equal(
    git(project.repositoryPath, ['show', '-s', '--format=%B', result.body.commit]),
    `${detail.publishDefaults.title}\n\n${detail.publishDefaults.body}\n\nTask: ${task.id}`,
  );
  assert.ok(
    list('pipeline-trigger-request', 'alice').some((row) => row.commit === result.body.commit),
  );
  assert.deepEqual((await request(path, input)).body, result.body);
  assert.equal((await request(path, { ...input, checkpointId: randomUUID() })).status, 409);
  db.prepare('DELETE FROM operations WHERE owner=? AND id=?').run('alice', input.operationId);
  save('task', 'alice', task);
  assert.deepEqual((await request(path, input)).body, result.body);
  assert.equal(
    git(project.repositoryPath, [
      'rev-list',
      '--count',
      `${task.baseRevision}..${result.body.branch}`,
    ]),
    '1',
  );
});

test('checkpoint publish validates owner, task and run provenance, freshness and active runs', async () => {
  const { task, run, checkpoint } = await checkpointFixture();
  const path = `/tasks/${task.id}/publish`;
  const input = { revision: 0, checkpointId: checkpoint.id };
  const foreign = save('checkpoint', 'bob', { ...checkpoint, id: randomUUID() });
  assert.equal((await request(path, { ...input, checkpointId: foreign.id })).status, 404);
  for (const fields of [{ taskId: randomUUID() }, { runId: randomUUID() }]) {
    save('checkpoint', 'alice', { ...checkpoint, ...fields });
    assert.equal((await request(path, input)).status, 403);
  }
  save('checkpoint', 'alice', checkpoint);
  const staleReason =
    'Commands or edits ran after this checkpoint; ask the agent to capture a new checkpoint as its last step';
  const expectStale = async (pattern: RegExp) => {
    const result = await request(path, input);
    assert.equal(result.status, 409);
    assert.match(result.body.error, pattern);
    assert.equal((await request(`/tasks/${task.id}`)).body.latestCheckpoint.fresh, false);
  };
  // A finished run that ends after its own final checkpoint is still publishable.
  save('run', 'alice', { ...run, completedAt: '2026-10-23T12:30:00.000Z' });
  assert.equal((await request(`/tasks/${task.id}`)).body.latestCheckpoint.fresh, true);
  save('run', 'alice', { ...run, status: 'running' });
  await expectStale(/active/);
  save('run', 'alice', run);
  const recordItem = (type: string, createdAt: string) =>
    db
      .prepare('INSERT INTO events(owner,taskId,runId,type,payload,createdAt) VALUES(?,?,?,?,?,?)')
      .run(
        'alice',
        task.id,
        run.id,
        'item.started',
        JSON.stringify({ item: { id: randomUUID(), type } }),
        createdAt,
      );
  // Activity before the checkpoint, and non-writing tool calls after it, keep it fresh.
  recordItem('command_execution', '2026-10-23T12:04:00.000Z');
  recordItem('mcp_tool_call', '2026-10-23T12:07:00.000Z');
  assert.equal((await request(`/tasks/${task.id}`)).body.latestCheckpoint.fresh, true);
  // A shell command after the checkpoint may have written files.
  recordItem('command_execution', '2026-10-23T12:06:00.000Z');
  await expectStale(/Commands or edits ran after this checkpoint/);
  const stale = (await request(`/tasks/${task.id}`)).body.latestCheckpoint;
  assert.equal(stale.reason, staleReason);
  db.prepare("DELETE FROM events WHERE taskId=? AND createdAt='2026-10-23T12:06:00.000Z'").run(
    task.id,
  );
  // A later run may have changed the workspace.
  const later = save('run', 'alice', {
    id: randomUUID(),
    taskId: task.id,
    status: 'succeeded',
    workerId: 'remote',
    createdAt: '2026-10-23T12:10:00.000Z',
    updatedAt: '2026-10-23T12:20:00.000Z',
  });
  save('run', 'alice', { ...run, createdAt: '2026-10-23T11:00:00.000Z' });
  await expectStale(/Commands or edits ran after this checkpoint/);
  db.prepare("DELETE FROM records WHERE kind='run' AND id=?").run(later.id);
  assert.equal((await request(path, input)).status, 200);
});

test('checkpoint publish updates the existing source branch and rejects moved trees', async () => {
  const { project, task, checkpoint } = await checkpointFixture();
  git(project.repositoryPath, ['branch', 'review-app', task.baseRevision]);
  const pull = (
    await request(`/projects/${project.id}/pulls`, {
      title: 'App review',
      sourceBranch: 'review-app',
      taskIds: [task.id],
    })
  ).body;
  const input = { revision: 0, checkpointId: checkpoint.id };
  const path = `/tasks/${task.id}/publish`;
  const first = await request(path, input);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.branch, 'review-app');
  assert.equal(first.body.pull.id, pull.id);
  const { captureSnapshot } = await import('./checkpoint.ts');
  writeFileSync(join(task.workspacePath, 'source.txt'), 'updated\n');
  const secondCheckpoint = save('checkpoint', 'alice', {
    ...checkpoint,
    id: randomUUID(),
    snapshot: captureSnapshot(task.workspacePath),
  });
  const second = await request(path, { revision: 1, checkpointId: secondCheckpoint.id });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.pull.id, pull.id);
  assert.equal(
    git(project.repositoryPath, ['rev-parse', `${second.body.commit}^`]),
    first.body.commit,
  );
  assert.equal(
    list('project-comment', 'alice').filter((row) => row.parentId === pull.id).length,
    2,
  );
  // Move the branch to a different tree while preserving ancestry.
  const external = git(project.repositoryPath, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit-tree',
    `${first.body.commit}^{tree}`,
    '-p',
    second.body.commit,
    '-m',
    'External edit',
  ]);
  git(project.repositoryPath, ['update-ref', 'refs/heads/review-app', external]);
  const moved = await request(path, { revision: 2, checkpointId: checkpoint.id });
  assert.equal(moved.status, 409);
  assert.match(
    moved.body.error,
    /target branch review-app moved to commits this task does not have/,
  );
});

test('legacy false diff reports cannot hide untracked or modified paths', async () => {
  const { task } = await checkpointFixture();
  const path = `/tasks/${task.id}/diff`;
  const report = get('remote-diff', 'alice', task.id);
  for (const status of ['?? new-file', ' M tracked-file', 'M  staged-file']) {
    save('remote-diff', 'alice', { ...report, patch: '', truncated: false, status });
    assert.equal((await request(path)).body.hasUnpublishedChanges, true);
  }
  save('remote-diff', 'alice', {
    ...report,
    patch: '',
    status: '',
    files: [{ path: 'new-file', status: '??' }],
  });
  assert.equal((await request(path)).body.hasUnpublishedChanges, true);
});
