import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
const data = mkdtempSync(join(tmpdir(), 'deploy-project-collaboration-'));
process.env.DEPLOY_DATA_DIR = data;
const { workspaceApi } = await import('./api.ts');
const { createProject, createTask } = await import('./test-repository.ts');
const { git } = await import('./service.ts');
const { gitText } = await import('./repository-git.ts');
const { db, get, list, save } = await import('./store.ts');
const { RepositoryRunner } = await import('./repository-runner.ts');
const { executePullMerge } = await import('./project-collaboration.ts');
const { projectTool } = await import('./project-tools.ts');
const server = createServer((req, res) => {
  void workspaceApi(
    req,
    res,
    String(req.headers['x-owner'] || 'alice'),
    req.headers['x-worker'] ? 'limited-worker' : undefined,
  );
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as any).port}/api/workspace`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  rmSync(data, { recursive: true, force: true });
});
async function request(path: string, body?: any, headers: Record<string, string> = {}) {
  const response = await fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify({ operationId: randomUUID(), ...body }),
  });
  return { status: response.status, body: (await response.json()) as any };
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
  git(source, ['checkout', '-b', 'feature']);
  writeFileSync(join(source, 'source.txt'), 'feature\n');
  git(source, ['commit', '-am', 'Feature']);
  const head = git(source, ['rev-parse', 'HEAD']);
  git(source, ['checkout', 'main']);
  const project = createProject('alice', { name: 'Project', sourcePath: source });
  return { project, source, base, head, path: `/projects/${project.id}` };
}
async function createPull(f: ReturnType<typeof fixture>, extra = {}) {
  const r = await request(f.path + '/pulls', {
    title: 'A change',
    sourceBranch: 'feature',
    targetBranch: 'main',
    ...extra,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function queueMerge(f: ReturnType<typeof fixture>, pull: any, extra = {}) {
  const r = await request(f.path + `/pulls/${pull.id}/merge`, {
    revision: pull.revision,
    baseCommit: f.base,
    headCommit: f.head,
    ...extra,
  });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  return r.body;
}

test('issues, comments and task links use project ownership, revisions, shared numbering and idempotency', async () => {
  const f = fixture(),
    other = fixture();
  const task = createTask('alice', { projectId: f.project.id });
  const foreignTask = createTask('alice', { projectId: other.project.id });
  assert.equal((await request(f.path + '/issues', { title: ' ' })).status, 400);
  assert.equal(
    (await request(f.path + '/issues', { title: 'Cross project', taskIds: [foreignTask.id] }))
      .status,
    400,
  );
  const input = {
    operationId: 'issue-once',
    title: 'Fix build',
    body: 'Description',
    taskIds: [task.id],
  };
  const created = await request(f.path + '/issues', input);
  assert.equal(created.status, 200);
  const issue = created.body;
  assert.equal(issue.number, 1);
  assert.equal((await request(f.path + '/issues', input)).body.id, issue.id);
  assert.equal((await request(f.path + '/issues', { ...input, title: 'Changed' })).status, 409);
  const p = `${f.path}/issues/${issue.id}`;
  assert.equal((await request(p, undefined, { 'x-owner': 'bob' })).status, 404);
  assert.equal((await request(p, undefined, { 'x-worker': '1' })).status, 403);
  assert.equal((await request(`${other.path}/issues/${issue.id}`)).status, 404);
  assert.equal((await request(p + '/close', { revision: 99 })).status, 409);
  const closed = await request(p + '/close', { revision: 0 });
  assert.equal(closed.body.status, 'closed');
  assert.equal((await request(p + '/reopen', { revision: 1 })).body.status, 'open');
  const commentInput = { operationId: 'comment-once', body: 'Build fails on Linux' };
  const comment = await request(p + '/comments', commentInput);
  assert.equal((await request(p + '/comments', commentInput)).body.id, comment.body.id);
  assert.equal((await request(p)).body.comments.length, 1);
  const pull = await createPull(f, { taskIds: [task.id], issueIds: [issue.id] });
  assert.equal(pull.number, 2);
  const detail = (await request(`/tasks/${task.id}`)).body;
  assert.equal(detail.issues[0].id, issue.id);
  assert.equal(detail.pullRequests[0].id, pull.id);
  const concurrent = await Promise.all(
    Array.from({ length: 4 }, (_, i) => request(f.path + '/issues', { title: `Issue ${i}` })),
  );
  assert.deepEqual(concurrent.map((r) => r.body.number).sort(), [3, 4, 5, 6]);
  const page = (await request(f.path + '/issues?limit=2')).body;
  assert.equal(page.items.length, 2);
  assert.equal(page.nextBefore, 5);
  assert.equal((await request(f.path + '/issues?before=5')).body.items.length, 3);
});

test('pull request compares real branches and merges atomically; retry never performs a second merge', async () => {
  const f = fixture();
  assert.equal(
    (
      await request(f.path + '/pulls', {
        title: 'Bad',
        sourceBranch: 'feature\nupdate refs/heads/main',
        targetBranch: 'main',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(f.path + '/pulls', {
        title: 'Missing',
        sourceBranch: 'missing',
        targetBranch: 'main',
      })
    ).status,
    400,
  );
  const input = {
    operationId: 'pull-once',
    title: 'A change',
    sourceBranch: 'feature',
    targetBranch: 'main',
  };
  const pull = (await request(f.path + '/pulls', input)).body;
  const diff = (await request(f.path + `/pulls/${pull.id}/diff`)).body;
  assert.equal(diff.baseCommit, f.base);
  assert.equal(diff.headCommit, f.head);
  assert.equal(diff.fastForward, true);
  assert.match(diff.patch, /\+feature/);
  const mergeInput = {
    operationId: 'merge-once',
    revision: 0,
    baseCommit: f.base,
    headCommit: f.head,
  };
  const merged = await queueMerge(f, pull, mergeInput);
  assert.equal((await request(f.path + `/pulls/${pull.id}/close`, { revision: 1 })).status, 409);
  await new RepositoryRunner().tick();
  assert.equal(get('repository-operation', 'alice', merged.mergeOperationId).status, 'succeeded');
  assert.equal(git(f.project.repositoryPath, ['rev-parse', 'main']), f.head);
  assert.equal(git(f.source, ['rev-parse', 'main']), f.base);
  assert.equal((await request(f.path + `/pulls/${pull.id}`)).body.record.status, 'merged');
  assert.equal(
    (await request(f.path + `/pulls/${pull.id}/merge`, mergeInput)).body.mergeOperationId,
    merged.mergeOperationId,
  );
  git(f.project.repositoryPath, ['branch', '-D', 'feature']);
  assert.equal((await request(f.path + '/pulls', input)).body.id, pull.id);
  assert.match((await request(f.path + `/pulls/${pull.id}/diff`)).body.patch, /\+feature/);
});

test('a changed source or target cannot be merged from a stale comparison', async () => {
  for (const change of ['source', 'target']) {
    const f = fixture();
    const pull = await createPull(f);
    const queued = await queueMerge(f, pull);
    git(f.source, ['checkout', change === 'source' ? 'feature' : 'main']);
    writeFileSync(join(f.source, 'extra.txt'), change);
    git(f.source, ['add', '.']);
    git(f.source, ['commit', '-m', change]);
    const newCommit = git(f.source, ['rev-parse', 'HEAD']);
    git(f.source, [
      'push',
      f.project.repositoryPath,
      `HEAD:${change === 'source' ? 'feature' : 'main'}`,
    ]);
    await new RepositoryRunner().tick();
    assert.equal(get('repository-operation', 'alice', queued.mergeOperationId).status, 'failed');
    assert.equal(
      git(f.project.repositoryPath, ['rev-parse', 'main']),
      change === 'source' ? f.base : newCommit,
    );
    assert.equal((await request(f.path + `/pulls/${pull.id}`)).body.record.status, 'open');
  }
});

test('a fast-forward pull request still fast-forwards without manufacturing a merge commit', async () => {
  const f = fixture();
  const pull = await createPull(f);
  const comparison = (await request(f.path + `/pulls/${pull.id}/diff`)).body;
  assert.equal(comparison.fastForward, true);
  assert.deepEqual(comparison.conflicts, []);
  assert.equal(comparison.mergeable, true);
  assert.equal(comparison.mergeBlock, null);
  await queueMerge(f, pull);
  await new RepositoryRunner().tick();
  const record = get('pull-request', 'alice', pull.id);
  assert.equal(record.status, 'merged');
  assert.equal(record.mergedCommit, f.head);
  assert.equal(record.mergedTargetCommit, f.head);
  assert.equal(git(f.project.repositoryPath, ['rev-parse', 'main']), f.head);
  assert.equal(git(f.project.repositoryPath, ['show', '-s', '--format=%P', f.head]), f.base);
});

test('a diverged pull request that merges cleanly lands as a merge commit on the target', async () => {
  const f = fixture();
  const pull = await createPull(f);
  // main gains an unrelated file while the pull request is open.
  git(f.source, ['checkout', 'main']);
  writeFileSync(join(f.source, 'unrelated.txt'), 'from main\n');
  git(f.source, ['add', '.']);
  git(f.source, ['commit', '-m', 'Unrelated main change']);
  const movedMain = git(f.source, ['rev-parse', 'HEAD']);
  git(f.source, ['push', f.project.repositoryPath, 'HEAD:main']);

  const comparison = (await request(f.path + `/pulls/${pull.id}/diff`)).body;
  assert.equal(comparison.fastForward, false);
  assert.deepEqual(comparison.conflicts, []);
  assert.equal(comparison.mergeable, true);
  assert.equal(comparison.mergeBlock, null);

  await queueMerge(f, pull, { baseCommit: movedMain, headCommit: f.head });
  await new RepositoryRunner().tick();
  const record = get('pull-request', 'alice', pull.id);
  assert.equal(record.status, 'merged');
  assert.equal(record.mergedCommit, f.head);
  assert.equal(record.mergedBaseCommit, movedMain);
  const tip = git(f.project.repositoryPath, ['rev-parse', 'main']);
  assert.equal(record.mergedTargetCommit, tip);
  assert.deepEqual(git(f.project.repositoryPath, ['show', '-s', '--format=%P', tip]).split(' '), [
    movedMain,
    f.head,
  ]);
  assert.match(
    git(f.project.repositoryPath, ['show', '-s', '--format=%B', tip]),
    new RegExp(`^Merge pull request #${record.number} from feature\\n\\nA change`),
  );
  // Neither side is discarded, and the push pipeline runs on the commit the target now has.
  assert.equal(git(f.project.repositoryPath, ['show', `${tip}:source.txt`]), 'feature');
  assert.equal(git(f.project.repositoryPath, ['show', `${tip}:unrelated.txt`]), 'from main');
  assert.equal(
    list('pipeline-trigger-request', 'alice').filter(
      (r) => r.commit === tip && r.ref === 'refs/heads/main',
    ).length,
    1,
  );
});

test('a diverged pull request that conflicts is refused, naming the conflicting files', async () => {
  const f = fixture();
  const pull = await createPull(f);
  // main edits the same file the source branch did.
  git(f.source, ['checkout', 'main']);
  writeFileSync(join(f.source, 'source.txt'), 'main edit\n');
  git(f.source, ['commit', '-am', 'Main edits the same file']);
  const movedMain = git(f.source, ['rev-parse', 'HEAD']);
  git(f.source, ['push', f.project.repositoryPath, 'HEAD:main']);

  const comparison = (await request(f.path + `/pulls/${pull.id}/diff`)).body;
  assert.equal(comparison.fastForward, false);
  assert.deepEqual(comparison.conflicts, ['source.txt']);
  assert.equal(comparison.mergeable, false);
  assert.match(
    comparison.mergeBlock,
    /main has moved and feature conflicts with it in source\.txt/,
  );

  const queued = await queueMerge(f, pull, { baseCommit: movedMain, headCommit: f.head });
  await new RepositoryRunner().tick();
  const operation = get('repository-operation', 'alice', queued.mergeOperationId);
  assert.equal(operation.status, 'failed');
  assert.match(operation.error, /conflicts with it in source\.txt/);
  assert.equal(git(f.project.repositoryPath, ['rev-parse', 'main']), movedMain);
  assert.equal(get('pull-request', 'alice', pull.id).status, 'open');
});

test('merge receipt recovers a crash after Git commit without moving a subsequently advanced target', async () => {
  const f = fixture(),
    pull = await createPull(f);
  const queued = await queueMerge(f, pull);
  const operation = get('repository-operation', 'alice', queued.mergeOperationId);
  save('repository-operation', 'alice', { ...operation, status: 'running' });
  await assert.rejects(
    executePullMerge('alice', operation, async (cwd, args, options) => {
      const result = await gitText(cwd, args, options);
      if (args[0] === 'update-ref') throw new Error('simulated process loss after Git commit');
      return result;
    }),
    /simulated/,
  );
  assert.equal(get('pull-request', 'alice', pull.id).status, 'open');
  assert.equal(git(f.project.repositoryPath, ['rev-parse', 'main']), f.head);
  git(f.source, ['checkout', 'feature']);
  writeFileSync(join(f.source, 'later.txt'), 'later');
  git(f.source, ['add', '.']);
  git(f.source, ['commit', '-m', 'Later']);
  const later = git(f.source, ['rev-parse', 'HEAD']);
  git(f.source, ['push', f.project.repositoryPath, 'HEAD:main']);
  const runner = new RepositoryRunner();
  runner.recover();
  assert.equal(get('repository-operation', 'alice', queued.mergeOperationId).status, 'unknown');
  assert.equal((await request(f.path + `/pulls/${pull.id}/close`, { revision: 1 })).status, 409);
  assert.equal(
    (await request(f.path + `/pulls/${pull.id}/retry-merge`, { revision: 1 })).status,
    202,
  );
  await runner.tick();
  assert.equal(get('repository-operation', 'alice', queued.mergeOperationId).status, 'succeeded');
  assert.equal(git(f.project.repositoryPath, ['rev-parse', 'main']), later);
  assert.equal(get('pull-request', 'alice', pull.id).mergedCommit, f.head);
});

test('recovery also completes when PR metadata was saved before the worker stopped', async () => {
  const f = fixture(),
    pull = await createPull(f),
    queued = await queueMerge(f, pull);
  const operation = get('repository-operation', 'alice', queued.mergeOperationId);
  save('repository-operation', 'alice', { ...operation, status: 'running' });
  await executePullMerge('alice', operation, gitText);
  const before = get('pull-request', 'alice', pull.id);
  const runner = new RepositoryRunner();
  runner.recover();
  const retried = await request(f.path + `/pulls/${pull.id}/retry-merge`, {
    revision: before.revision,
  });
  assert.equal(retried.status, 202, JSON.stringify(retried.body));
  await runner.tick();
  assert.equal(get('repository-operation', 'alice', queued.mergeOperationId).status, 'succeeded');
  assert.equal(get('pull-request', 'alice', pull.id).mergedAt, before.mergedAt);
});

test('issue task creation is replay-safe and project tools cannot escape the conversation project', async () => {
  const f = fixture(),
    other = fixture();
  const task = createTask('alice', { projectId: f.project.id });
  const scope = { owner: 'alice', taskId: task.id, runId: 'scoped-run' };
  const input = {
    resource: 'issues',
    action: 'create',
    title: 'Fix build',
    body: 'Linux fails',
    operationId: randomUUID(),
    projectId: other.project.id,
  };
  const issue = await projectTool(scope, input);
  assert.equal(issue.projectId, f.project.id);
  assert.deepEqual(issue.taskIds, [task.id]);
  assert.equal((await projectTool(scope, input)).id, issue.id);
  const foreign = (await request(other.path + '/issues', { title: 'Other' })).body;
  await assert.rejects(
    projectTool(scope, { resource: 'issues', action: 'get', id: foreign.id }),
    /Not found/,
  );
  const payload = { operationId: randomUUID(), revision: issue.revision };
  const started = await request(`${f.path}/issues/${issue.id}/task`, payload);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(
    (await request(`${f.path}/issues/${issue.id}/task`, payload)).body.task.id,
    started.body.task.id,
  );
  assert.equal(get('task', 'alice', started.body.task.id).issueId, issue.id);
  assert.equal((await request(`${f.path}/issues/${issue.id}`)).body.record.taskIds.length, 2);
});

test('PR merge requires successful checks for its current commit, not an earlier commit', async () => {
  const f = fixture();
  git(f.source, ['checkout', 'feature']);
  writeFileSync(
    join(f.source, 'deploy.yaml'),
    'apiVersion: deploy.local/v1\nkind: Application\npipeline:\n  on: [manual, pull_request]\n  jobs:\n    check:\n      runsOn: {os: linux}\n      container: node:22-slim\n      run: node --version\n',
  );
  git(f.source, ['add', '.']);
  git(f.source, ['commit', '-m', 'Checks']);
  f.head = git(f.source, ['rev-parse', 'HEAD']);
  git(f.source, ['push', f.project.repositoryPath, 'HEAD:feature']);
  const pull = await createPull(f);
  const queued = await queueMerge(f, pull);
  const operation = get('repository-operation', 'alice', queued.mergeOperationId);
  save('pipeline-run', 'alice', {
    id: randomUUID(),
    projectId: f.project.id,
    commit: f.base,
    status: 'succeeded',
  });
  await assert.rejects(executePullMerge('alice', operation, gitText), /checks have not passed/);
  save('pipeline-run', 'alice', {
    id: randomUUID(),
    projectId: f.project.id,
    commit: f.head,
    status: 'failed',
  });
  await assert.rejects(executePullMerge('alice', operation, gitText), /checks have not passed/);
  save('pipeline-run', 'alice', {
    id: randomUUID(),
    projectId: f.project.id,
    commit: f.head,
    status: 'succeeded',
  });
  await executePullMerge('alice', operation, gitText);
  assert.equal(git(f.project.repositoryPath, ['rev-parse', 'main']), f.head);
});

test('merging a pull request closes its linked tasks, and tasks can be closed and reopened by hand', async () => {
  const f = fixture();
  const linked = createTask('alice', { projectId: f.project.id, title: 'Linked' });
  const running = createTask('alice', { projectId: f.project.id, title: 'Running again' });
  for (const task of [linked, running])
    save('task', 'alice', {
      ...get('task', 'alice', task.id),
      status: task === running ? 'running' : 'review',
    });
  const pull = await createPull(f, { taskIds: [linked.id, running.id] });
  const queued = await queueMerge(f, pull);
  // Task workspace preparation is queued ahead of the merge; the runner takes one per tick.
  const runner = new RepositoryRunner();
  for (let i = 0; i < 5; i++) {
    if (get('repository-operation', 'alice', queued.mergeOperationId).status === 'succeeded') break;
    await runner.tick();
  }
  const merged = get('task', 'alice', linked.id);
  assert.equal(merged.status, 'merged');
  assert.equal(merged.mergedPullId, pull.id);
  assert.equal(get('task', 'alice', running.id).status, 'running');

  // Reopening after the merge sticks: the startup backfill does not close it again.
  const reopened = await request(`/tasks/${linked.id}/reopen`, { revision: merged.revision });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal(reopened.body.status, 'review');
  const { closeTasksForMergedPulls } = await import('./project-collaboration.ts');
  closeTasksForMergedPulls();
  assert.equal(get('task', 'alice', linked.id).status, 'review');

  const closed = await request(`/tasks/${linked.id}/close`, { revision: reopened.body.revision });
  assert.equal(closed.body.status, 'done');
  assert.ok(closed.body.closedAt);
  assert.equal(
    (await request(`/tasks/${linked.id}/close`, { revision: reopened.body.revision })).status,
    409,
  );
});
