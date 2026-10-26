import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
const data = mkdtempSync(join(tmpdir(), 'deploy-follow-up-test-'));
process.env.DEPLOY_DATA_DIR = data;
const { workspaceApi } = await import('./api.ts');
const { createProject, createTask } = await import('./test-repository.ts');
const { git, startRun } = await import('./service.ts');
const { db, save, get, list } = await import('./store.ts');
const { RepositoryRunner } = await import('./repository-runner.ts');
const { closeTasksForMergedPulls } = await import('./project-collaboration.ts');
const { captureSnapshot } = await import('./checkpoint.ts');
const { commitCheckpoint } = await import('./checkpoint-commit.ts');
const { coordinationTool } = await import('./coordination.ts');
after(() => {
  db.close();
  rmSync(data, { recursive: true, force: true });
});

async function request(path: string, body?: any) {
  const req = Object.assign(
    Readable.from(
      body === undefined ? [] : [JSON.stringify({ operationId: randomUUID(), ...body })],
    ),
    { url: '/api/workspace' + path, method: body === undefined ? 'GET' : 'POST', headers: {} },
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
  await workspaceApi(req as any, res as any, 'alice', undefined);
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
  const project = createProject('alice', { name: 'Project', sourcePath: source });
  const task = createTask('alice', { projectId: project.id, title: 'Build the app' });
  return { project, source, repo: project.repositoryPath, task };
}

const userMessage = (taskId: string, content: string) =>
  save('message', 'alice', {
    id: randomUUID(),
    taskId,
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
  });

async function merge(projectId: string, pull: any, repo: string) {
  const current = get('pull-request', 'alice', pull.id);
  const queued = await request(`/projects/${projectId}/pulls/${pull.id}/merge`, {
    revision: current.revision,
    baseCommit: git(repo, ['rev-parse', current.targetBranch]),
    headCommit: git(repo, ['rev-parse', current.sourceBranch]),
  });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  await new RepositoryRunner().tick();
  assert.equal(get('pull-request', 'alice', pull.id).status, 'merged');
}

test('work after a merge publishes as a new fast-forwardable pull request with only the follow-up', async () => {
  const { project, repo, task } = fixture();
  userMessage(task.id, 'Build the app');
  writeFileSync(join(task.workspacePath, 'source.txt'), 'first\n');
  writeFileSync(join(task.workspacePath, 'app.txt'), 'app\n');
  const first = await request(`/tasks/${task.id}/publish`, { revision: 0, title: 'Build the app' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  save('task', 'alice', { ...get('task', 'alice', task.id), status: 'review' });
  await merge(project.id, first.body.pull, repo);

  // The merged commit is now the diff base, installed in the local workspace too.
  const merged = get('task', 'alice', task.id);
  assert.equal(merged.status, 'merged');
  assert.equal(merged.baseRevision, first.body.commit);
  assert.equal(git(task.workspacePath, ['rev-parse', 'HEAD']), first.body.commit);
  const clean = (await request(`/tasks/${task.id}/diff`)).body;
  assert.equal(clean.patch, '');
  assert.equal(clean.hasUnpublishedChanges, false);
  const nothing = await request(`/tasks/${task.id}/publish`, { revision: merged.revision });
  assert.equal(nothing.status, 409);
  assert.match(nothing.body.error, /merged in #1; there are no new changes/);

  // A follow-up message reopens the task.
  const run = startRun('alice', task.id, { revision: merged.revision, content: 'Add settings' });
  assert.equal(get('task', 'alice', task.id).status, 'running');
  assert.equal(get('task', 'alice', task.id).closedAt, null);
  save('run', 'alice', { ...get('run', 'alice', run.id), status: 'succeeded' });
  save('task', 'alice', { ...get('task', 'alice', task.id), status: 'review' });

  writeFileSync(join(task.workspacePath, 'settings.txt'), 'settings\n');
  const followUp = (await request(`/tasks/${task.id}/diff`)).body;
  assert.deepEqual(
    followUp.files.map((file: any) => file.path),
    ['settings.txt'],
  );
  assert.equal(followUp.hasUnpublishedChanges, true);
  const detail = (await request(`/tasks/${task.id}`)).body;
  assert.equal(detail.publishDefaults.title, 'Add settings');

  const input = {
    operationId: randomUUID(),
    revision: get('task', 'alice', task.id).revision,
    title: detail.publishDefaults.title,
    body: '',
  };
  const second = await request(`/tasks/${task.id}/publish`, input);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.pull.number, 2);
  assert.notEqual(second.body.pull.id, first.body.pull.id);
  assert.equal(second.body.pull.status, 'open');
  assert.equal(second.body.branch, first.body.branch);
  assert.equal(
    git(repo, ['rev-parse', `${second.body.commit}^`]),
    git(repo, ['rev-parse', 'main']),
  );
  assert.equal(git(repo, ['diff', '--name-only', 'main', second.body.commit]), 'settings.txt');
  assert.equal(get('pull-request', 'alice', first.body.pull.id).status, 'merged');
  assert.equal(get('task', 'alice', task.id).publishedCommit, second.body.commit);
  assert.equal((await request(`/tasks/${task.id}/diff`)).body.hasUnpublishedChanges, false);
  assert.ok(list('pipeline-trigger-request', 'alice').some((r) => r.commit === second.body.commit));
  // Replays return the same pull request without another commit or pull request.
  assert.deepEqual((await request(`/tasks/${task.id}/publish`, input)).body, second.body);
  db.prepare('DELETE FROM operations WHERE owner=? AND id=?').run('alice', input.operationId);
  assert.deepEqual((await request(`/tasks/${task.id}/publish`, input)).body, second.body);
  assert.equal(
    list('pull-request', 'alice').filter((pull) => pull.taskIds.includes(task.id)).length,
    2,
  );
  // Further work updates the follow-up pull request, and it merges as a fast-forward.
  writeFileSync(join(task.workspacePath, 'settings.txt'), 'settings v2\n');
  const update = await request(`/tasks/${task.id}/publish`, {
    revision: get('task', 'alice', task.id).revision,
  });
  assert.equal(update.status, 200, JSON.stringify(update.body));
  assert.equal(update.body.pull.id, second.body.pull.id);
  await merge(project.id, second.body.pull, repo);
  assert.equal(git(repo, ['rev-parse', 'main']), update.body.commit);
  assert.equal(get('task', 'alice', task.id).baseRevision, update.body.commit);
});

test('a task branch that gained unmerged commits after the merge is kept; the follow-up uses a fresh branch', async () => {
  const { project, repo, task } = fixture();
  writeFileSync(join(task.workspacePath, 'source.txt'), 'first\n');
  const first = await request(`/tasks/${task.id}/publish`, { revision: 0, title: 'First' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  await merge(project.id, first.body.pull, repo);
  const outside = git(repo, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit-tree',
    `${first.body.commit}^{tree}`,
    '-p',
    first.body.commit,
    '-m',
    'Someone else',
  ]);
  git(repo, ['update-ref', `refs/heads/${first.body.branch}`, outside]);
  writeFileSync(join(task.workspacePath, 'more.txt'), 'more\n');
  const second = await request(`/tasks/${task.id}/publish`, {
    revision: get('task', 'alice', task.id).revision,
    title: 'More',
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.branch, `${first.body.branch}-2`);
  assert.equal(git(repo, ['rev-parse', first.body.branch]), outside);
  assert.equal(
    git(repo, ['rev-parse', `${second.body.commit}^`]),
    git(repo, ['rev-parse', 'main']),
  );
  // A deleted branch is simply recreated.
  const other = fixture();
  writeFileSync(join(other.task.workspacePath, 'source.txt'), 'first\n');
  const published = await request(`/tasks/${other.task.id}/publish`, { revision: 0, title: 'A' });
  await merge(other.project.id, published.body.pull, other.repo);
  git(other.repo, ['update-ref', '-d', `refs/heads/${published.body.branch}`]);
  writeFileSync(join(other.task.workspacePath, 'more.txt'), 'more\n');
  const recreated = await request(`/tasks/${other.task.id}/publish`, {
    revision: get('task', 'alice', other.task.id).revision,
    title: 'B',
  });
  assert.equal(recreated.status, 200, JSON.stringify(recreated.body));
  assert.equal(recreated.body.branch, published.body.branch);
});

test('checkpoint follow-ups from a worker that has not refreshed its baseline publish only new work', async () => {
  const { project, repo, task } = fixture();
  for (let i = 0; i < 3; i++) writeFileSync(join(task.workspacePath, `app-${i}.txt`), `${i}\n`);
  const runAt = (minutes: number) => new Date(Date.UTC(2026, 9, 23, 12, minutes)).toISOString();
  const capture = (runId: string, minutes: number) =>
    save('checkpoint', 'alice', {
      id: randomUUID(),
      taskId: task.id,
      runId,
      snapshot: captureSnapshot(task.workspacePath),
      createdAt: runAt(minutes + 1),
    });
  const firstRun = save('run', 'alice', {
    id: randomUUID(),
    taskId: task.id,
    status: 'succeeded',
    workerId: 'remote',
    createdAt: runAt(0),
  });
  const firstCheckpoint = capture(firstRun.id, 0);
  save('task', 'alice', { ...get('task', 'alice', task.id), workerId: 'remote', status: 'review' });
  // An old worker's diff: truncated and measured from the original base.
  const staleDiff = {
    id: task.id,
    taskId: task.id,
    baseRevision: task.baseRevision,
    headRevision: task.baseRevision,
    patch: 'partial',
    truncated: true,
    excluded: [],
    files: [0, 1, 2].map((i) => ({ path: `app-${i}.txt`, status: '??' })),
    status: '?? app-0.txt',
  };
  save('remote-diff', 'alice', staleDiff);
  const first = await request(`/tasks/${task.id}/publish`, {
    revision: get('task', 'alice', task.id).revision,
    checkpointId: firstCheckpoint.id,
    title: 'App',
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  await merge(project.id, first.body.pull, repo);
  // Simulate a merge recorded before baselines followed merges: the startup backfill adopts it.
  const legacy = get('task', 'alice', task.id);
  const { workspaceCommit: _, ...withoutBaseline } = legacy;
  save('task', 'alice', { ...withoutBaseline, baseRevision: task.baseRevision });
  closeTasksForMergedPulls();
  const adopted = get('task', 'alice', task.id);
  assert.equal(adopted.baseRevision, first.body.commit);
  assert.equal(adopted.workspaceCommit.commit, first.body.commit);
  closeTasksForMergedPulls();
  assert.equal(get('task', 'alice', task.id).revision, adopted.revision);
  // The merged checkpoint has nothing new, and the stale worker diff no longer counts 3 files.
  assert.equal((await request(`/tasks/${task.id}`)).body.latestCheckpoint.changedFileCount, 0);
  const pending = (await request(`/tasks/${task.id}/diff`)).body;
  assert.equal(pending.baselinePending, true);
  assert.deepEqual(pending.files, []);
  assert.match(
    pending.note,
    /has not uploaded changes since #1 merged.*latest checkpoint changes 0 files since #1 merged/,
  );

  const secondRun = save('run', 'alice', {
    id: randomUUID(),
    taskId: task.id,
    status: 'succeeded',
    workerId: 'remote',
    createdAt: runAt(10),
  });
  writeFileSync(join(task.workspacePath, 'app-0.txt'), 'changed\n');
  const secondCheckpoint = capture(secondRun.id, 10);
  const summary = (await request(`/tasks/${task.id}`)).body.latestCheckpoint;
  assert.equal(summary.fresh, true);
  assert.equal(summary.fileCount, 4);
  assert.equal(summary.changedFileCount, 1);
  const second = await request(`/tasks/${task.id}/publish`, {
    revision: get('task', 'alice', task.id).revision,
    checkpointId: secondCheckpoint.id,
    title: 'Change app-0',
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.pull.number, 2);
  assert.equal(git(repo, ['diff', '--name-only', 'main', second.body.commit]), 'app-0.txt');
  assert.equal(git(repo, ['rev-parse', `${second.body.commit}^`]), first.body.commit);
});

test('a moved target branch refuses checkpoint follow-ups instead of discarding its changes', async () => {
  const { project, repo, task } = fixture();
  writeFileSync(join(task.workspacePath, 'source.txt'), 'first\n');
  const first = await request(`/tasks/${task.id}/publish`, { revision: 0, title: 'First' });
  await merge(project.id, first.body.pull, repo);
  const external = git(repo, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit-tree',
    `${task.baseRevision}^{tree}`,
    '-p',
    first.body.commit,
    '-m',
    'Someone else',
  ]);
  git(repo, ['update-ref', 'refs/heads/main', external]);
  const run = save('run', 'alice', { id: randomUUID(), taskId: task.id, status: 'succeeded' });
  writeFileSync(join(task.workspacePath, 'more.txt'), 'more\n');
  const checkpoint = save('checkpoint', 'alice', {
    id: randomUUID(),
    taskId: task.id,
    runId: run.id,
    snapshot: captureSnapshot(task.workspacePath),
    createdAt: new Date(Date.now() + 1000).toISOString(),
  });
  const refused = await request(`/tasks/${task.id}/publish`, {
    revision: get('task', 'alice', task.id).revision,
    checkpointId: checkpoint.id,
    title: 'More',
  });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /target branch main moved to commits this task does not have/);
  assert.equal(git(repo, ['rev-parse', 'main']), external);
});

test('a diverged merge keeps the merged source head as the task baseline and refuses follow-ups with guidance', async () => {
  const { project, source, repo, task } = fixture();
  writeFileSync(join(task.workspacePath, 'source.txt'), 'first\n');
  const first = await request(`/tasks/${task.id}/publish`, { revision: 0, title: 'First' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  // main gains an unrelated file, so this pull request merges as a merge commit.
  writeFileSync(join(source, 'unrelated.txt'), 'from main\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'Unrelated main change']);
  git(source, ['push', repo, 'HEAD:main']);
  await merge(project.id, first.body.pull, repo);
  const mergeCommit = git(repo, ['rev-parse', 'main']);
  assert.notEqual(mergeCommit, first.body.commit);
  assert.equal(git(repo, ['show', '-s', '--format=%P', mergeCommit]).split(' ').length, 2);
  assert.equal(get('pull-request', 'alice', first.body.pull.id).status, 'merged');

  // The workspace keeps the commit it published, so its diff stays clean: adopting the merge
  // commit would report main's file as a deletion this workspace is about to make.
  const merged = get('task', 'alice', task.id);
  assert.equal(merged.baseRevision, first.body.commit);
  assert.equal((await request(`/tasks/${task.id}/diff`)).body.patch, '');

  // Follow-up work on top of main's merge commit would discard that file, so it is refused with
  // the same guidance as any other moved target.
  const run = save('run', 'alice', {
    id: randomUUID(),
    taskId: task.id,
    workerId: 'local',
    status: 'running',
    generation: randomUUID(),
  });
  const scope = { owner: 'alice', taskId: task.id, runId: run.id };
  writeFileSync(join(task.workspacePath, 'settings.txt'), 'settings\n');
  await assert.rejects(
    commitCheckpoint(scope, {
      operationId: randomUUID(),
      checkpointId: coordinationTool(scope, 'deploy_checkpoint', {
        operationId: randomUUID(),
        snapshot: captureSnapshot(task.workspacePath),
      }).checkpointId,
      message: 'Add settings',
    }),
    /target branch main moved to commits this task does not have.*start a new task/s,
  );
  assert.equal(git(repo, ['rev-parse', 'main']), mergeCommit);
});

test('deploy_commit after a merge commits the follow-up on the merged target and publishes it as a new pull request', async () => {
  const { project, repo, task } = fixture();
  writeFileSync(join(task.workspacePath, 'source.txt'), 'first\n');
  const first = await request(`/tasks/${task.id}/publish`, { revision: 0, title: 'First' });
  await merge(project.id, first.body.pull, repo);
  const run = save('run', 'alice', {
    id: randomUUID(),
    taskId: task.id,
    workerId: 'local',
    status: 'running',
    generation: randomUUID(),
  });
  const scope = { owner: 'alice', taskId: task.id, runId: run.id };
  writeFileSync(join(task.workspacePath, 'feature.txt'), 'feature\n');
  const checkpointId = coordinationTool(scope, 'deploy_checkpoint', {
    operationId: randomUUID(),
    snapshot: captureSnapshot(task.workspacePath),
  }).checkpointId;
  const args = { operationId: randomUUID(), checkpointId, message: 'Add feature' };
  const committed = await commitCheckpoint(scope, args);
  assert.equal(committed.branch, first.body.branch);
  assert.equal(git(repo, ['rev-parse', `${committed.commit}^`]), git(repo, ['rev-parse', 'main']));
  assert.equal(git(repo, ['diff', '--name-only', 'main', committed.commit]), 'feature.txt');
  assert.deepEqual(await commitCheckpoint(scope, args), committed);
  await assert.rejects(
    commitCheckpoint(scope, {
      ...args,
      operationId: randomUUID(),
      branch: `${first.body.branch}-9`,
    }),
    /Choose the task branch/,
  );
  save('run', 'alice', { ...get('run', 'alice', run.id), status: 'succeeded' });
  const opened = await request(`/tasks/${task.id}/publish`, {
    revision: get('task', 'alice', task.id).revision,
    title: 'Add feature',
  });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.pull.number, 2);
  assert.equal(opened.body.commit, committed.commit);
});
