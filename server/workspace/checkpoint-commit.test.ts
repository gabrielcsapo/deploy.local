import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gitText, repositoryGit } from './repository-git.ts';
import { captureSnapshot } from './checkpoint.ts';
import { refreshCommitBaseline } from './commit-baseline.ts';
import { inspectWorkspace } from './review.ts';

const directory = mkdtempSync(join(tmpdir(), 'deploy-commit-test-'));
process.env.DEPLOY_DATA_DIR = directory;
const { db, get, list, save } = await import('./store.ts');
const { createProject, createTask } = await import('./test-repository.ts');
const { commitCheckpoint } = await import('./checkpoint-commit.ts');
const { coordinationTool, issueAgentToken } = await import('./coordination.ts');
const { coordinationApi } = await import('./coordination-api.ts');
const { createRepository } = await import('./repository-creation.ts');
const { continueRepositoryCreation } = await import('./repository-creation-worker.ts');
const { RepositoryRunner } = await import('./repository-runner.ts');
const { workerCommand } = await import('./protocol.ts');
const { diff } = await import('./service.ts');
const { publishTask } = await import('./publish.ts');
const { operatingManual } = await import('./agent-context.ts');
const { coordinationTools } = await import('./coordination-tools.ts');
const owner = 'checkpoint-owner';
after(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
function context(projectId?: string, workerId = 'local') {
  if (workerId !== 'local')
    workerCommand(owner, '/workers/register', { workerId, platform: 'darwin' });
  const task = createTask(owner, { title: 'Verified checkpoint', projectId, workerId });
  const run = save('run', owner, {
    id: randomUUID(),
    taskId: task.id,
    workerId,
    status: 'running',
    generation: randomUUID(),
  });
  return { task, run, scope: { owner, taskId: task.id, runId: run.id } };
}
function checkpoint(scope: any, cwd: string) {
  return coordinationTool(scope, 'deploy_checkpoint', {
    operationId: randomUUID(),
    snapshot: captureSnapshot(cwd),
  }).checkpointId;
}
function request(scope: any, cwd: string, branch?: string) {
  return {
    operationId: randomUUID(),
    checkpointId: checkpoint(scope, cwd),
    message: 'Save verified work',
    ...(branch ? { branch } : {}),
  };
}
async function endpoint(token: string, args: any) {
  const req = Object.assign(Readable.from([JSON.stringify({ name: 'deploy_commit', args })]), {
    method: 'POST',
    url: '/api/workspace/agent/tools',
    headers: { 'x-deploy-agent-token': token },
  }) as unknown as IncomingMessage;
  let status = 0,
    result: any;
  const res = {
    writeHead(value: number) {
      status = value;
    },
    end(body: string) {
      result = JSON.parse(body);
    },
  } as ServerResponse;
  await coordinationApi(req, res);
  if (status !== 200) throw Object.assign(new Error(result.error), { status });
  return result;
}
async function ownRepository(workerId = 'local') {
  const contextValue = context(undefined, workerId);
  const args = { operationId: randomUUID(), name: randomUUID() };
  await createRepository(contextValue.scope, args);
  await new RepositoryRunner().tick();
  const initial = await createRepository(contextValue.scope, args);
  const result = await continueRepositoryCreation(
    contextValue.task.workspacePath,
    args,
    initial,
    (next) => createRepository(contextValue.scope, next),
  );
  return { ...contextValue, project: get('project', owner, result.project.id), initial: result };
}

test('coordinator commits exact checkpoint bytes, deletions and modes; retries, pipelines, card and review use the same commit', async () => {
  const project = createProject(owner, { name: randomUUID() });
  const { task, scope, run } = context(project.id);
  const cwd = task.workspacePath;
  writeFileSync(join(cwd, 'keep'), 'old\n');
  writeFileSync(join(cwd, 'delete'), 'remove me\n');
  writeFileSync(join(cwd, 'run.sh'), '#!/bin/sh\necho one\n');
  const first = await commitCheckpoint(scope, request(scope, cwd));
  assert.equal(first.branch, `task/${task.id.replaceAll('-', '').slice(0, 8)}`);
  assert.equal(await gitText(cwd, ['status', '--porcelain']), '');
  assert.equal(diff(owner, task.id).hasUnpublishedChanges, false);
  writeFileSync(join(cwd, 'keep'), 'changed\n\n');
  rmSync(join(cwd, 'delete'));
  chmodSync(join(cwd, 'run.sh'), 0o755);
  writeFileSync(join(cwd, 'binary'), Buffer.from([0, 255, 10, 13]));
  writeFileSync(join(cwd, '.env'), 'SECRET=excluded');
  writeFileSync(join(cwd, '.gitignore'), 'ignored\n');
  writeFileSync(join(cwd, 'ignored'), 'local');
  const args = request(scope, cwd);
  writeFileSync(join(cwd, 'later'), 'edit after checkpoint');
  const token = issueAgentToken(scope);
  const [result, retry] = await Promise.all([endpoint(token, args), endpoint(token, args)]);
  assert.deepEqual(retry, result);
  assert.equal(get('task', owner, task.id).publishedCheckpointId, args.checkpointId);
  assert.deepEqual(await endpoint(token, args), result);
  assert.equal(
    await gitText(project.repositoryPath, ['show', '-s', '--format=%P', result.commit]),
    first.commit,
  );
  assert.equal(
    (await repositoryGit(project.repositoryPath, ['show', `${result.commit}:keep`])).toString(),
    'changed\n\n',
  );
  assert.deepEqual(
    await repositoryGit(project.repositoryPath, ['show', `${result.commit}:binary`]),
    Buffer.from([0, 255, 10, 13]),
  );
  assert.equal(
    await gitText(project.repositoryPath, [
      'ls-tree',
      result.commit,
      'delete',
      '.env',
      'ignored',
      'later',
    ]),
    '',
  );
  assert.match(
    await gitText(project.repositoryPath, ['ls-tree', result.commit, 'run.sh']),
    /^100755/,
  );
  assert.match(
    await gitText(project.repositoryPath, ['show', '-s', '--format=%an%n%cn%n%B', result.commit]),
    new RegExp(
      `${owner}\\ndeploy.local\\nSave verified work\\n\\nTask: Verified checkpoint \\(${task.id}\\)`,
    ),
  );
  assert.equal(result.files, get('checkpoint', owner, args.checkpointId).snapshot.files.length);
  assert.equal(readFileSync(join(cwd, 'later'), 'utf8'), 'edit after checkpoint');
  assert.equal(diff(owner, task.id).hasUnpublishedChanges, true);
  rmSync(join(cwd, 'later'));
  assert.equal(diff(owner, task.id).hasUnpublishedChanges, false);
  assert.equal(
    list('pipeline-trigger-request', owner).filter(
      (r) => r.commit === result.commit && r.ref === `refs/heads/${result.branch}`,
    ).length,
    1,
  );
  const cards = list('message', owner).filter((m) => m.commit?.commit === result.commit);
  assert.equal(cards.length, 1);
  assert.match(cards[0].content, /> \*\*Committed\*\*/);
  assert.ok(cards[0].content.includes(result.url));
  await assert.rejects(endpoint(token, { ...args, message: 'Different' }), /different command/);
  await assert.rejects(endpoint('invalid', args), /credential expired/);
  // Remove excluded local secret before using the existing publish UI's stricter review checks.
  rmSync(join(cwd, '.env'));
  save('run', owner, { ...run, status: 'succeeded' });
  const published = await publishTask(
    owner,
    task.id,
    { operationId: randomUUID(), revision: get('task', owner, task.id).revision },
    randomUUID(),
  );
  assert.equal(published.commit, result.commit);
  assert.equal(published.pull.sourceBranch, result.branch);
  assert.ok(published.pull.taskIds.includes(task.id));
});

test('empty self-created repository allows one first main commit; follow-ups use task branch', async () => {
  const { task, scope, project, initial } = await ownRepository();
  assert.equal(await gitText(project.repositoryPath, ['ls-tree', '-r', initial.commit]), '');
  writeFileSync(join(task.workspacePath, 'app'), 'actual source');
  const first = await commitCheckpoint(scope, request(scope, task.workspacePath, 'main'));
  assert.equal(await gitText(project.repositoryPath, ['rev-parse', 'main']), first.commit);
  assert.equal(get('task', owner, task.id).baseRevision, first.commit);
  assert.equal(inspectWorkspace(task.workspacePath, first.commit).patch, '');
  await assert.rejects(
    commitCheckpoint(scope, request(scope, task.workspacePath, 'main')),
    /first deploy_commit/,
  );
  writeFileSync(join(task.workspacePath, 'app'), 'follow-up');
  const next = await commitCheckpoint(scope, request(scope, task.workspacePath));
  assert.equal(
    await gitText(project.repositoryPath, ['show', '-s', '--format=%P', next.commit]),
    first.commit,
  );
  assert.equal(await gitText(project.repositoryPath, ['rev-parse', 'main']), first.commit);
  assert.equal(diff(owner, task.id).hasUnpublishedChanges, false);
});

test('branch rules, checkpoint ownership and moved tips refuse replacement of other work', async () => {
  const project = createProject(owner, { name: randomUUID() });
  const { task, scope } = context(project.id);
  writeFileSync(join(task.workspacePath, 'app'), 'mine');
  const args = request(scope, task.workspacePath);
  await assert.rejects(commitCheckpoint(scope, { ...args, branch: 'main' }), /first deploy_commit/);
  await assert.rejects(
    commitCheckpoint(scope, { ...args, branch: 'other' }),
    /Choose the task branch/,
  );
  const other = context(project.id);
  await assert.rejects(commitCheckpoint(other.scope, args), /another task/);
  await assert.rejects(commitCheckpoint({ ...scope, owner: 'someone-else' }, args), /Not found/);
  const first = await commitCheckpoint(scope, args);
  const foreign = await gitText(
    project.repositoryPath,
    ['commit-tree', `${task.baseRevision}^{tree}`, '-p', first.commit],
    { identity: 'other-owner', input: 'Other work\n' },
  );
  await gitText(project.repositoryPath, ['update-ref', `refs/heads/${first.branch}`, foreign]);
  await assert.rejects(
    commitCheckpoint(scope, request(scope, task.workspacePath)),
    /target branch task\/\w+ moved to commits this task does not have.*would discard them.*start a new task/,
  );
  assert.equal(await gitText(project.repositoryPath, ['rev-parse', first.branch]), foreign);
  const created = await ownRepository();
  const moved = await gitText(
    created.project.repositoryPath,
    ['commit-tree', `${created.initial.commit}^{tree}`, '-p', created.initial.commit],
    { identity: 'other-owner', input: 'Someone else\n' },
  );
  await gitText(created.project.repositoryPath, ['update-ref', 'refs/heads/main', moved]);
  await assert.rejects(
    commitCheckpoint(created.scope, request(created.scope, created.task.workspacePath, 'main')),
    /first deploy_commit/,
  );
});

test('main moving under an open task still commits: the new task branch starts at the task baseline and its pull request merges cleanly', async () => {
  const project = createProject(owner, { name: randomUUID() });
  const { task, scope, run } = context(project.id);
  const repo = project.repositoryPath;
  const baseline = task.baseRevision;
  // Someone else pushes an unrelated file to main while this task is open.
  const clone = join(directory, randomUUID());
  await gitText(directory, ['clone', repo, clone]);
  writeFileSync(join(clone, 'unrelated.txt'), 'from main\n');
  await gitText(clone, ['add', 'unrelated.txt']);
  await gitText(clone, ['commit', '-m', 'Unrelated main change'], { identity: 'other-owner' });
  await gitText(clone, ['push', 'origin', 'HEAD:main']);
  const movedMain = await gitText(repo, ['rev-parse', 'refs/heads/main']);
  assert.notEqual(movedMain, baseline);

  writeFileSync(join(task.workspacePath, 'app.txt'), 'task work\n');
  const result = await commitCheckpoint(scope, request(scope, task.workspacePath));
  // Parent is the task's own baseline, not main's newer tip, so the commit is a clean delta.
  assert.equal(await gitText(repo, ['show', '-s', '--format=%P', result.commit]), baseline);
  assert.equal(await gitText(repo, ['diff', '--name-only', baseline, result.commit]), 'app.txt');
  assert.equal(await gitText(repo, ['rev-parse', 'refs/heads/main']), movedMain);

  save('run', owner, { ...run, status: 'succeeded' });
  const published = await publishTask(
    owner,
    task.id,
    { operationId: randomUUID(), revision: get('task', owner, task.id).revision },
    randomUUID(),
  );
  assert.equal(published.commit, result.commit);
  assert.equal(published.pull.sourceBranch, result.branch);
  assert.equal(published.pull.targetBranch, 'main');
  // Merging the review into the newer main keeps both changes and conflicts with nothing.
  const mergedTree = await gitText(repo, ['merge-tree', '--write-tree', movedMain, result.commit]);
  assert.deepEqual(
    (await gitText(repo, ['ls-tree', '-r', '--name-only', mergedTree])).split('\n'),
    ['app.txt', 'unrelated.txt'],
  );

  // A baseline a force push removed is reported as such, not as a raw Git failure.
  const orphan = context(project.id);
  save('task', owner, { ...get('task', owner, orphan.task.id), baseRevision: 'f'.repeat(40) });
  writeFileSync(join(orphan.task.workspacePath, 'app.txt'), 'orphan\n');
  await assert.rejects(
    commitCheckpoint(orphan.scope, request(orphan.scope, orphan.task.workspacePath)),
    /base commit ffffffff is no longer in the repository/,
  );
});

test('durable Git receipt recovers a lost database result without duplicating a commit or rolling back later work', async () => {
  const project = createProject(owner, { name: randomUUID() });
  const { task, scope } = context(project.id);
  writeFileSync(join(task.workspacePath, 'app'), 'first');
  const args = request(scope, task.workspacePath);
  const first = await commitCheckpoint(scope, args);
  writeFileSync(join(task.workspacePath, 'app'), 'second');
  const second = await commitCheckpoint(scope, request(scope, task.workspacePath));
  db.prepare('DELETE FROM operations WHERE owner=? AND id=?').run(owner, args.operationId);
  assert.deepEqual(await commitCheckpoint(scope, args), first);
  assert.equal(get('task', owner, task.id).workspaceCommit.commit, second.commit);
  assert.equal(await gitText(task.workspacePath, ['rev-parse', 'HEAD']), second.commit);
  assert.equal(await gitText(project.repositoryPath, ['rev-list', '--count', first.branch]), '3');
});

test('remote assignment refreshes metadata and uploads real diff, preserving edits after checkpoint', async () => {
  const project = createProject(owner, { name: randomUUID() });
  const { task, scope, run } = context(project.id, 'commit-mac');
  // Model a separate worker clone, not the server-side fixture worktree.
  const cwd = join(directory, randomUUID());
  await gitText(directory, ['clone', project.repositoryPath, cwd]);
  writeFileSync(join(cwd, 'app'), 'checkpoint');
  const result = await commitCheckpoint(scope, request(scope, cwd));
  assert.equal(diff(owner, task.id).hasUnpublishedChanges, null);
  writeFileSync(join(cwd, 'app'), 'later edit');
  const ack = workerCommand(owner, '/workers/commit-mac/events', {
    runId: run.id,
    generation: run.generation,
    events: [],
  });
  assert.equal(ack.repositoryTask.workspaceCommit.commit, result.commit);
  assert.equal(await refreshCommitBaseline(cwd, ack.repositoryTask, project.repositoryPath), true);
  assert.equal(await refreshCommitBaseline(cwd, ack.repositoryTask, project.repositoryPath), false);
  assert.equal(readFileSync(join(cwd, 'app'), 'utf8'), 'later edit');
  workerCommand(owner, '/workers/commit-mac/events', {
    runId: run.id,
    generation: run.generation,
    events: [],
    baselineCommit: result.commit,
    workspaceDiff: inspectWorkspace(cwd, task.baseRevision),
  });
  assert.equal(diff(owner, task.id).hasUnpublishedChanges, true);
  writeFileSync(join(cwd, 'app'), 'checkpoint');
  workerCommand(owner, '/workers/commit-mac/complete', {
    runId: run.id,
    generation: run.generation,
    status: 'succeeded',
    baselineCommit: result.commit,
    diff: inspectWorkspace(cwd, task.baseRevision),
  });
  assert.equal(diff(owner, task.id).hasUnpublishedChanges, false);
  assert.equal(await gitText(cwd, ['status', '--porcelain']), '');
});

test('manual and tools require coordinator commits and prohibit shell Git writes', () => {
  assert.match(operatingManual, /deploy_checkpoint.*deploy_commit/s);
  assert.match(operatingManual, /Never run git commit or git push in the shell/);
  const tool = coordinationTools.find((t) => t.name === 'deploy_commit')!;
  assert.deepEqual(tool.inputSchema.required, ['operationId', 'checkpointId', 'message']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.match(tool.description, /first deploy_commit/);
  assert.match(tool.description, /deploy_project/);
  assert.match(
    coordinationTools.find((t) => t.name === 'deploy_create_repository')!.description,
    /empty initial workspace.*deploy_commit/,
  );
});
