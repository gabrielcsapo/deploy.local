import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const root = mkdtempSync(join(tmpdir(), 'task-delete-'));
process.env.DEPLOY_DATA_DIR = root;
const { db, save, get, list, event, events, command } = await import('./store.ts');
const { createProject, createTask } = await import('./test-repository.ts');
const { deleteTask, taskDeletion } = await import('./task-delete.ts');
const { gitSync } = await import('./repository-git.ts');
const { readWorkspaceState } = await import('./read-state.ts');
const { waitForV2Events } = await import('../v2/events.ts');
const owner = 'task-delete';
const project = createProject(owner, { name: 'deletes' });
const repo = project.repositoryPath;
const main = gitSync(repo, ['rev-parse', 'refs/heads/main'])!;
test.after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const exists = (ref: string) => gitSync(repo, ['rev-parse', '--verify', '--quiet', ref]) !== null;
/** A commit on top of main that main does not have. */
function commit(parent: string, message: string) {
  const tree = gitSync(repo, ['rev-parse', `${parent}^{tree}`])!;
  return gitSync(repo, [
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit-tree',
    tree,
    '-p',
    parent,
    '-m',
    message,
  ])!;
}
function fixture(title = 'Cache Discover images on SER') {
  const task = createTask(owner, { projectId: project.id, title });
  const short = task.id.replaceAll('-', '').slice(0, 8);
  const branch = `task/${short}`;
  const head = commit(commit(main, 'one'), 'two');
  gitSync(repo, ['update-ref', `refs/heads/${branch}`, head]);
  save('task', owner, { ...task, workspaceCommit: { branch, commit: head } });
  const runId = `run-${task.id}`;
  save('run', owner, {
    id: runId,
    taskId: task.id,
    status: 'succeeded',
    createdAt: task.createdAt,
  });
  save('message', owner, {
    id: `message-${task.id}`,
    taskId: task.id,
    role: 'user',
    content: 'hi',
  });
  save('question', owner, { id: `question-${task.id}`, taskId: task.id, status: 'open' });
  save('remote-turn-diff', owner, { id: runId, taskId: task.id, patch: '' });
  save('queued-message', owner, { id: task.id, content: 'later' });
  event(owner, task.id, runId, 'message', { role: 'user', content: 'hi' });
  const checkpointRef = `refs/deploy/checkpoint/${createHash('sha256').update(task.id).digest('hex')}`;
  gitSync(repo, ['update-ref', checkpointRef, main]);
  save('checkpoint', owner, {
    id: `checkpoint-${task.id}`,
    taskId: task.id,
    projectId: project.id,
    baseRef: checkpointRef,
    snapshot: { base: { commit: main } },
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const pull = save('pull-request', owner, {
    id: `pull-${task.id}`,
    projectId: project.id,
    number: 1,
    status: 'open',
    revision: 0,
    taskIds: [task.id],
    sourceBranch: branch,
    targetBranch: 'main',
  });
  return { task: get('task', owner, task.id), branch, head, runId, checkpointRef, pull };
}
const remove = (taskId: string, revision: number) =>
  command(owner, crypto.randomUUID(), () => deleteTask(owner, taskId, { revision }));

test('the confirmation names the branch and counts commits that are not on main', () => {
  const { task, branch } = fixture();
  assert.deepEqual(taskDeletion(owner, task.id), {
    id: task.id,
    title: 'Cache Discover images on SER',
    revision: task.revision,
    branch,
    unmergedCommits: 2,
    running: false,
  });
  // A task that never committed has no branch to name.
  const fresh = createTask(owner, { projectId: project.id, title: 'Fresh' });
  assert.equal(taskDeletion(owner, fresh.id).branch, null);
  assert.equal(taskDeletion(owner, fresh.id).unmergedCommits, 0);
});

test('delete removes the conversation, checkpoints and branch, and closes its open pull', async () => {
  const { task, branch, head, runId, checkpointRef, pull } = fixture();
  const after = (db.prepare('SELECT MAX(cursor) AS n FROM events').get() as any).n;
  assert.deepEqual(remove(task.id, task.revision), { id: task.id, deleted: true });

  assert.throws(() => get('task', owner, task.id), /Not found/);
  for (const [kind, id] of [
    ['run', runId],
    ['message', `message-${task.id}`],
    ['question', `question-${task.id}`],
    ['remote-turn-diff', runId],
    ['queued-message', task.id],
    ['checkpoint', `checkpoint-${task.id}`],
  ])
    assert.throws(() => get(kind, owner, id), /Not found/, kind);
  assert.equal(exists(`refs/heads/${branch}`), false);
  assert.equal(exists(`refs/heads/task/${task.id}`), false);
  assert.equal(exists(checkpointRef), false);
  // The commits themselves are unreachable now; main is untouched.
  assert.equal(gitSync(repo, ['rev-parse', 'refs/heads/main']), main);

  const closed = get('pull-request', owner, pull.id);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.revision, 1);
  assert.equal(closed.closedHeadCommit, head);
  assert.equal(closed.closedBaseCommit, main);

  // Only the notice that it was deleted is left of its history, and clients hear it.
  assert.deepEqual(
    events(owner, 0, task.id).map((row) => row.type),
    ['task.deleted'],
  );
  const page = await waitForV2Events(owner, after, 0, new AbortController().signal);
  assert.ok(page.events.some((item) => item.type === 'task-deleted' && item.taskId === task.id));

  const state = await readWorkspaceState(owner);
  assert.equal(
    state.tasks.some((row: any) => row.id === task.id),
    false,
  );
  assert.equal(
    list('run', owner).some((run) => run.taskId === task.id),
    false,
  );
  await new Promise((done) => setImmediate(done));
  assert.equal(existsSync(task.workspacePath), false);
});

test('merged work and releases stay', () => {
  const { task, checkpointRef } = fixture('Merged once');
  const merged = save('pull-request', owner, {
    id: `merged-${task.id}`,
    projectId: project.id,
    number: 2,
    status: 'merged',
    revision: 3,
    taskIds: [task.id],
    sourceBranch: 'task/merged-source',
    targetBranch: 'main',
  });
  gitSync(repo, ['update-ref', 'refs/heads/task/merged-source', main]);
  save('application-deployment', owner, {
    id: `deploy-${task.id}`,
    taskId: task.id,
    checkpointId: `checkpoint-${task.id}`,
    completedAt: '2026-01-02T00:00:00.000Z',
  });
  remove(task.id, task.revision);
  assert.deepEqual(get('pull-request', owner, merged.id), merged);
  assert.equal(get('application-deployment', owner, `deploy-${task.id}`).taskId, task.id);
  // The release's checkpoint record stays; its ref is released like a closed task's.
  assert.equal(get('checkpoint', owner, `checkpoint-${task.id}`).taskId, task.id);
  assert.equal(exists(checkpointRef), false);
  assert.equal(exists('refs/heads/task/merged-source'), true);
});

test('delete refuses while the task works and when the task changed', () => {
  const { task, runId } = fixture('Still running');
  save('run', owner, { ...get('run', owner, runId), status: 'running' });
  assert.equal(taskDeletion(owner, task.id).running, true);
  assert.throws(
    () => remove(task.id, task.revision),
    (error: any) => error.status === 409 && error.message === 'Stop the task before deleting it',
  );
  save('run', owner, { ...get('run', owner, runId), status: 'succeeded' });
  save('check', owner, { id: `check-${task.id}`, taskId: task.id, status: 'queued' });
  assert.throws(() => remove(task.id, task.revision), /Stop the task before deleting it/);
  save('check', owner, { id: `check-${task.id}`, taskId: task.id, status: 'succeeded' });
  assert.throws(
    () => remove(task.id, task.revision - 1),
    (error: any) => error.status === 409 && /refresh/.test(error.message),
  );
  // Nothing was removed by the refusals.
  assert.equal(get('task', owner, task.id).id, task.id);
  assert.equal(get('run', owner, runId).taskId, task.id);
  remove(task.id, task.revision);
  assert.throws(() => get('task', owner, task.id), /Not found/);
  assert.throws(() => taskDeletion(owner, task.id), /Not found/);
});
