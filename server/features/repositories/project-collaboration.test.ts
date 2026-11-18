import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
const data = mkdtempSync(join(tmpdir(), 'deploy-project-collaboration-'));
process.env.DEPLOY_DATA_DIR = data;
await import('../../test-ports.ts');
const { workspaceApi } = await import('../../workspace/api.ts');
const { createProject, createTask } = await import('../../workspace/test-repository.ts');
const { git } = await import('../../workspace/service.ts');
const { gitText } = await import('../../workspace/repository-git.ts');
const { db, get, list, save } = await import('../../workspace/store.ts');
const { RepositoryRunner } = await import('./repository-runner.ts');
const { executePullMerge, conflictSummary } = await import('./project-collaboration.ts');
const { projectTool } = await import('./project-tools.ts');
const { coordinationApi } = await import('../../workspace/coordination-api.ts');
const { issueAgentToken } = await import('../../workspace/coordination.ts');
const { putAgentControl } = await import('../../v2/phone-preferences.ts');
after(() => {
  db.close();
  rmSync(data, { recursive: true, force: true });
});
// Exercise the HTTP handler in process so this suite also runs without permission to bind a port.
async function request(path: string, body?: any, headers: Record<string, string> = {}) {
  const req = Object.assign(
    Readable.from(
      body === undefined ? [] : [JSON.stringify({ operationId: randomUUID(), ...body })],
    ),
    {
      url: `/api${path}`,
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      complete: true,
    },
  );
  let status = 200;
  let result: any;
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(value: string) {
      result = JSON.parse(value);
    },
  };
  await workspaceApi(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    headers['x-owner'] || 'alice',
    headers['x-worker'] ? 'limited-worker' : undefined,
  );
  return { status, body: result };
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
  // A pull request no task opened shows the conflict alone, without asking a task.
  assert.equal(comparison.mergeBlockKind, 'conflicts');
  assert.equal(
    comparison.conflictSummary,
    'main has moved and feature conflicts with it in source.txt.',
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

test('an issue an agent writes down is found by its task until the owner accepts or dismisses it', async () => {
  const f = fixture();
  const task = createTask('alice', { projectId: f.project.id });
  const scope = { owner: 'alice', taskId: task.id, runId: 'found-run' };
  const found = await projectTool(scope, {
    resource: 'issues',
    action: 'create',
    title: 'Checks read as earlier',
    operationId: randomUUID(),
  });
  assert.deepEqual(found.foundBy, { taskId: task.id });
  // A person's issue, even one that names foundBy, is theirs.
  const mine = await request(f.path + '/issues', {
    operationId: randomUUID(),
    title: 'Mine',
    foundBy: { taskId: task.id },
  });
  assert.equal(mine.body.foundBy, undefined);
  const accepted = await request(`${f.path}/issues/${found.id}/accept`, {
    operationId: randomUUID(),
    revision: found.revision,
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.accepted.by, 'alice');
  assert.deepEqual(accepted.body.foundBy, { taskId: task.id });
  const stale = await request(`${f.path}/issues/${found.id}/accept`, {
    operationId: randomUUID(),
    revision: found.revision,
  });
  assert.equal(stale.status, 409);
  const dismissed = await request(`${f.path}/issues/${mine.body.id}/close`, {
    operationId: randomUUID(),
    revision: mine.body.revision,
  });
  assert.equal(dismissed.body.status, 'closed');
  const closedAccept = await request(`${f.path}/issues/${mine.body.id}/accept`, {
    operationId: randomUUID(),
    revision: dismissed.body.revision,
  });
  assert.equal(closedAccept.status, 409);
  const pullAccept = await request(`${f.path}/pulls/${found.id}/accept`, {
    operationId: randomUUID(),
    revision: 0,
  });
  assert.notEqual(pullAccept.status, 200);
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

test('pull list totals span pages and filters and name linked agents and matching checks', async () => {
  const f = fixture();
  const task = createTask('alice', { projectId: f.project.id });
  save('agent', 'alice', { id: 'scout', name: 'Scout' });
  save('task', 'alice', { ...task, agentId: 'scout' });
  const first = await createPull(f, { taskIds: [task.id] });
  const second = await createPull(f);
  await request(`${f.path}/pulls/${second.id}/close`, { revision: second.revision });
  save('pipeline-run', 'alice', {
    id: 'checks-current',
    projectId: f.project.id,
    pullId: first.id,
    commit: f.head,
  });
  save('job', 'alice', { id: 'check-passed', pipelineId: 'checks-current', status: 'succeeded' });
  save('pipeline-run', 'alice', {
    id: 'checks-old',
    projectId: f.project.id,
    pullId: first.id,
    commit: f.base,
  });
  save('job', 'alice', { id: 'old-check', pipelineId: 'checks-old', status: 'succeeded' });
  const page = (await request(`${f.path}/pulls?status=open&limit=1`)).body;
  assert.deepEqual(page.counts, { open: 1, merged: 0, closed: 1 });
  assert.equal(page.items[0].taskAuthor, 'Scout');
  assert.equal(page.items[0].checksPassed, 1);
  assert.equal(page.items[0].checksCommit, f.head);
  assert.equal((await request(`${f.path}/pulls?limit=1`)).body.nextBefore, second.number);
  const found = (await request(`${f.path}/pulls?status=all&limit=1&q=%23${first.number}`)).body;
  assert.equal(found.items[0].id, first.id, 'search runs before pagination');
  assert.deepEqual(found.counts, page.counts, 'search does not change state totals');
  const detail = (await request(`${f.path}/pulls/${first.id}`)).body;
  assert.equal(detail.record.taskAuthor, 'Scout');
  assert.equal((await request(`${f.path}/pulls`, undefined, { 'x-owner': 'bob' })).status, 404);
});

test('closed pull commits and diffs stay pinned after branch deletion', async () => {
  const f = fixture();
  const pull = await createPull(f);
  const path = `${f.path}/pulls/${pull.id}`;
  const closed = (await request(path + '/close', { revision: pull.revision })).body;
  assert.equal(closed.closedHeadCommit, f.head);
  assert.equal(closed.closedBy, 'alice');
  await gitText(f.project.repositoryPath, ['update-ref', '-d', 'refs/heads/feature']);
  const diff = (await request(path + '/diff')).body;
  assert.equal(diff.headCommit, f.head);
  assert.equal(diff.commitCount, 1);
  assert.equal(diff.commits[0].subject, 'Feature');
  assert.equal(diff.commits[0].author, 'Test');
  assert.match(diff.patch, /\+feature/);
  save('pull-request', 'alice', { ...closed, closedHeadCommit: undefined });
  assert.equal(
    (await request(path + '/diff')).status,
    409,
    'legacy closed records do not show a moving branch',
  );
});

test('merged pull history and release evidence survive source branch deletion', async () => {
  const f = fixture();
  const pull = await createPull(f);
  const queued = await queueMerge(f, pull);
  await executePullMerge(
    'alice',
    get('repository-operation', 'alice', queued.mergeOperationId),
    gitText,
  );
  await gitText(f.project.repositoryPath, ['update-ref', '-d', 'refs/heads/feature']);
  const path = `${f.path}/pulls/${pull.id}`;
  const diff = (await request(path + '/diff')).body;
  assert.equal(diff.commitCount, 1);
  assert.equal(diff.commits[0].oid, f.head);
  const release = {
    id: 'release-receipt',
    projectId: f.project.id,
    source: { kind: 'ship', ref: f.head },
    steps: [{ name: 'activate', state: 'done', endedAt: '2026-11-01T12:00:00Z' }],
  };
  save('v2-release', 'alice', { id: release.id, release });
  const record = (await request(path)).body.record;
  assert.equal(record.mergedBy, 'alice');
  assert.equal(record.release.commit, f.head);
  assert.equal(record.release.id, release.id);
  save('v2-release', 'alice', {
    id: release.id,
    release: { ...release, source: { kind: 'ship', ref: 'main' } },
  });
  assert.equal(
    (await request(path)).body.record.release,
    undefined,
    'a moving release ref is not evidence of the merged version',
  );
});

test('a deleted source branch can still be closed without inventing history', async () => {
  const f = fixture();
  const pull = await createPull(f);
  await gitText(f.project.repositoryPath, ['update-ref', '-d', 'refs/heads/feature']);
  const path = `${f.path}/pulls/${pull.id}`;
  const closed = await request(path + '/close', { revision: pull.revision });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.status, 'closed');
  assert.equal((await request(path + '/diff')).status, 409);
});

test('pull presentation uses account names while preserving actor identifiers', async () => {
  const { authDb, updatePreferences } = await import('../../v2/auth-store.ts');
  authDb()
    .prepare('INSERT INTO users (username, password, role, created_at) VALUES (?, ?, ?, ?)')
    .run('alice', '', 'admin', new Date().toISOString());
  updatePreferences('alice', { name: 'Alice Example' });
  const f = fixture();
  const pull = await createPull(f);
  const record = (await request(`${f.path}/pulls/${pull.id}`)).body.record;
  assert.equal(record.author, 'alice');
  assert.equal(record.authorName, 'Alice Example');
});

// A real agent turn reaches deploy_project through the coordinator endpoint with its run
// credential, the same request the worker's MCP server posts.
async function agentTool(token: string, args: any) {
  const req = Object.assign(Readable.from([JSON.stringify({ name: 'deploy_project', args })]), {
    method: 'POST',
    url: '/api/agent/tools',
    headers: { 'x-deploy-agent-token': token },
  });
  let status = 0;
  let body: any;
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(value: string) {
      body = JSON.parse(value);
    },
  };
  await coordinationApi(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return { status, body };
}
function agentTurn(projectId: string, agentId?: string) {
  const task = createTask('alice', { projectId });
  if (agentId) save('task', 'alice', { ...get('task', 'alice', task.id), agentId });
  const run = save('run', 'alice', {
    id: randomUUID(),
    taskId: task.id,
    workerId: 'local',
    adapter: 'codex',
    status: 'running',
    generation: randomUUID(),
  });
  return issueAgentToken({ owner: 'alice', taskId: task.id, runId: run.id });
}
/** What an agent does: open its own pull request, read its commits, then ask to merge it. */
async function agentMerge(token: string) {
  const opened = await agentTool(token, {
    resource: 'pulls',
    action: 'create',
    title: 'My own change',
    sourceBranch: 'feature',
    targetBranch: 'main',
    operationId: randomUUID(),
  });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const pull = opened.body;
  const diff = await agentTool(token, { resource: 'pulls', action: 'diff', id: pull.id });
  assert.equal(diff.status, 200, JSON.stringify(diff.body));
  const merge = await agentTool(token, {
    resource: 'pulls',
    action: 'merge',
    id: pull.id,
    revision: pull.revision,
    baseCommit: diff.body.baseCommit,
    headCommit: diff.body.headCommit,
    operationId: randomUUID(),
  });
  await new RepositoryRunner().tick();
  return { pull, merge };
}
function assertMergeRefused(f: ReturnType<typeof fixture>, attempt: any) {
  const pull = get('pull-request', 'alice', attempt.pull.id);
  assert.equal(pull.status, 'open', 'the agent merged its own pull request');
  assert.equal(git(f.project.repositoryPath, ['rev-parse', 'main']), f.base);
  assert.equal(pull.mergeOperationId, undefined);
  assert.equal(attempt.merge.status, 403, JSON.stringify(attempt.merge.body));
  assert.match(attempt.merge.body.error, /not allowed to merge/);
}
function assertMerged(f: ReturnType<typeof fixture>, attempt: any) {
  assert.equal(attempt.merge.status, 200, JSON.stringify(attempt.merge.body));
  assert.equal(get('pull-request', 'alice', attempt.pull.id).status, 'merged');
  assert.equal(git(f.project.repositoryPath, ['rev-parse', 'main']), f.head);
}
function mergeRule(agent: string, mode: string, extra = {}) {
  save('v2-approval', 'alice', { id: randomUUID(), agent, action: 'merge', mode, ...extra });
}

test('an agent turn cannot merge its own pull request when no rule allows it', async () => {
  const f = fixture();
  assertMergeRefused(f, await agentMerge(agentTurn(f.project.id)));
});

test('a saved agent merges only when its merge rule is Allowed with no limit and it is not paused', async () => {
  for (const [name, mode, extra] of [
    ['asking', 'ask', {}],
    ['forbidden', 'never', {}],
    ['limited', 'allow', { limit: 'Docs only' }],
  ] as const) {
    const f = fixture();
    const agent = `${name}-${randomUUID()}`;
    mergeRule(agent, mode, extra);
    assertMergeRefused(f, await agentMerge(agentTurn(f.project.id, agent)));
  }
  const paused = fixture();
  const sleeping = `paused-${randomUUID()}`;
  mergeRule(sleeping, 'allow');
  putAgentControl('alice', sleeping, { paused: true });
  assertMergeRefused(paused, await agentMerge(agentTurn(paused.project.id, sleeping)));

  const f = fixture();
  const trusted = `trusted-${randomUUID()}`;
  mergeRule(trusted, 'allow');
  assertMerged(f, await agentMerge(agentTurn(f.project.id, trusted)));
});

test('a project merge rule overrides the global one in both directions for an agent turn', async () => {
  const narrowed = fixture();
  const careful = `careful-${randomUUID()}`;
  mergeRule(careful, 'allow');
  mergeRule(careful, 'never', { projectId: narrowed.project.id });
  assertMergeRefused(narrowed, await agentMerge(agentTurn(narrowed.project.id, careful)));
  const widened = fixture();
  const scoped = `scoped-${randomUUID()}`;
  mergeRule(scoped, 'ask');
  mergeRule(scoped, 'allow', { projectId: widened.project.id });
  assertMerged(widened, await agentMerge(agentTurn(widened.project.id, scoped)));
  // A rule belongs to one agent: another agent's Allow lends this one nothing.
  const other = fixture();
  assertMergeRefused(other, await agentMerge(agentTurn(other.project.id, 'someone-else')));
});

test('an agent turn with no saved agent is not covered by a rule naming its coding tool', async () => {
  const f = fixture();
  mergeRule('codex', 'allow');
  assertMergeRefused(f, await agentMerge(agentTurn(f.project.id)));
  db.prepare(
    "DELETE FROM records WHERE kind='v2-approval' AND owner='alice' AND json_extract(data,'$.agent')='codex'",
  ).run();
});

test('an agent turn cannot restart a failed merge a person queued when no rule allows it', async () => {
  const f = fixture();
  const token = agentTurn(f.project.id);
  const pull = await createPull(f);
  const queued = await queueMerge(f, pull);
  const operation = get('repository-operation', 'alice', queued.mergeOperationId);
  save('repository-operation', 'alice', { ...operation, status: 'failed', error: 'Stopped' });
  const retried = await agentTool(token, {
    resource: 'pulls',
    action: 'retry-merge',
    id: pull.id,
    revision: queued.revision,
    operationId: randomUUID(),
  });
  assert.equal(retried.status, 403, JSON.stringify(retried.body));
  assert.equal(get('repository-operation', 'alice', operation.id).status, 'failed');
  // The person's own retry still works, and lands the merge.
  const own = await request(f.path + `/pulls/${pull.id}/retry-merge`, {
    revision: queued.revision,
  });
  assert.equal(own.status, 202, JSON.stringify(own.body));
  await new RepositoryRunner().tick();
  assert.equal(git(f.project.repositoryPath, ['rev-parse', 'main']), f.head);
});

test('a person merges from the app even when the task agent may not', async () => {
  const f = fixture();
  const forbidden = `forbidden-${randomUUID()}`;
  mergeRule(forbidden, 'never');
  const token = agentTurn(f.project.id, forbidden);
  const { pull, merge } = await agentMerge(token);
  assert.equal(merge.status, 403, JSON.stringify(merge.body));
  const queued = await queueMerge(f, pull);
  await new RepositoryRunner().tick();
  assert.equal(get('repository-operation', 'alice', queued.mergeOperationId).status, 'succeeded');
  assert.equal(git(f.project.repositoryPath, ['rev-parse', 'main']), f.head);
  assert.equal(get('pull-request', 'alice', pull.id).mergedBy, 'alice');
});

test('an agent turn can still comment on, edit, close and reopen a pull request', async () => {
  const f = fixture();
  const token = agentTurn(f.project.id);
  const created = await agentTool(token, {
    resource: 'pulls',
    action: 'create',
    title: 'My own change',
    sourceBranch: 'feature',
    targetBranch: 'main',
    operationId: randomUUID(),
  });
  const call = (action: string, extra: any) =>
    agentTool(token, {
      resource: 'pulls',
      action,
      id: created.body.id,
      operationId: randomUUID(),
      ...extra,
    });
  assert.equal((await call('comment', { body: 'Ready' })).status, 200);
  assert.equal((await call('update', { revision: 0, title: 'Renamed' })).body.title, 'Renamed');
  assert.equal((await call('close', { revision: 1 })).body.status, 'closed');
  assert.equal((await call('reopen', { revision: 2 })).body.status, 'open');
});

test('the conflict summary names the files the way a sentence would', () => {
  const pull = { targetBranch: 'main', sourceBranch: 'build/project-work' };
  assert.equal(
    conflictSummary(pull, ['app/SidebarTasks.tsx', 'server/v2/settings.ts']),
    'main has moved and build/project-work conflicts with it in app/SidebarTasks.tsx and server/v2/settings.ts.',
  );
  const many = Array.from({ length: 12 }, (_, index) => `f${index}`);
  assert.equal(
    conflictSummary(pull, many),
    'main has moved and build/project-work conflicts with it in f0, f1, f2, f3, f4, f5, f6, f7, f8, f9 and 2 more files.',
  );
});

test('a pull request blocked by its checks says which ran, which failed and how many are done', async () => {
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
  const read = async () => (await request(f.path + `/pulls/${pull.id}/diff`)).body;

  let comparison = await read();
  assert.equal(comparison.mergeBlockKind, 'checks');
  assert.deepEqual(comparison.requiredChecks, {
    commit: f.head,
    runId: null,
    status: null,
    done: 0,
    total: 0,
    failed: [],
  });

  const runId = randomUUID();
  save('pipeline-run', 'alice', {
    id: runId,
    projectId: f.project.id,
    commit: f.head,
    status: 'running',
  });
  const job = (name: string, status: string) =>
    save('job', 'alice', { id: randomUUID(), pipelineId: runId, name, status });
  job('lint', 'succeeded');
  const tests = job('test', 'running');
  job('typecheck', 'queued');
  comparison = await read();
  assert.equal(
    comparison.mergeBlock,
    `Required pipeline checks have not passed for ${f.head.slice(0, 7)}.`,
  );
  assert.deepEqual(comparison.requiredChecks, {
    commit: f.head,
    runId,
    status: 'running',
    done: 1,
    total: 3,
    failed: [],
  });

  save('job', 'alice', { ...tests, status: 'failed' });
  save('pipeline-run', 'alice', { ...get('pipeline-run', 'alice', runId), status: 'failed' });
  comparison = await read();
  assert.equal(comparison.requiredChecks.status, 'failed');
  assert.equal(comparison.requiredChecks.done, 2);
  assert.deepEqual(comparison.requiredChecks.failed, [{ id: tests.id, name: 'test' }]);

  // Once they pass, nothing blocks it and no check summary is sent.
  save('pipeline-run', 'alice', { ...get('pipeline-run', 'alice', runId), status: 'succeeded' });
  comparison = await read();
  assert.equal(comparison.mergeBlockKind, null);
  assert.equal(comparison.requiredChecks, null);
  assert.equal(comparison.mergeable, true);
});

test('commits that merge the target into the source are marked so they can fold together', async () => {
  const f = fixture();
  git(f.source, ['checkout', 'main']);
  writeFileSync(join(f.source, 'main.txt'), 'main\n');
  git(f.source, ['add', '.']);
  git(f.source, ['commit', '-m', 'Main moves']);
  git(f.source, ['push', f.project.repositoryPath, 'HEAD:main']);
  git(f.source, ['checkout', 'feature']);
  git(f.source, ['merge', '--no-ff', '-m', "Merge branch 'main' into feature", 'main']);
  writeFileSync(join(f.source, 'after.txt'), 'after\n');
  git(f.source, ['add', '.']);
  git(f.source, ['commit', '-m', 'After the merge']);
  git(f.source, ['push', f.project.repositoryPath, 'HEAD:feature']);
  const pull = await createPull(f);
  const comparison = (await request(f.path + `/pulls/${pull.id}/diff`)).body;
  assert.deepEqual(
    comparison.commits.map((commit: any) => [
      commit.subject,
      !!commit.mergesTarget,
      commit.parents.length,
    ]),
    [
      ['Feature', false, 1],
      ["Merge branch 'main' into feature", true, 2],
      ['After the merge', false, 1],
    ],
  );
  assert.equal(comparison.mergeable, true);
});
