import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
const data = mkdtempSync(join(tmpdir(), 'deploy-update-test-'));
process.env.DEPLOY_DATA_DIR = data;
const { createProject, createTask } = await import('../../workspace/test-repository.ts');
const { git, diff } = await import('../../workspace/service.ts');
const { db, get, save, list } = await import('../../workspace/store.ts');
const { updateBase, baseUpdateWorker } = await import('./update-base.ts');
const { executeBaseUpdate, prepareBaseUpdateWorkspace } =
  await import('../../workspace/update-base-worker.ts');
const { captureSnapshot, recordCheckpointBase, readCheckpointBase } =
  await import('./checkpoint.ts');
const { publishTask } = await import('./publish.ts');
const { workspaceApi, workerMayReadRepository } = await import('../../workspace/api.ts');
const { commitCheckpoint } = await import('../../workspace/checkpoint-commit.ts');
const { latestCheckpointSummary, publishCheckpoint, checkpointPublishReason } =
  await import('./checkpoint-publish.ts');
const { taskQueue } = await import('../../workspace/run-queue.ts');
after(() => {
  db.close();
  rmSync(data, { recursive: true, force: true });
});
function fixture(remote = false) {
  const source = join(data, randomUUID());
  mkdirSync(source);
  git(source, ['init', '--initial-branch=main']);
  git(source, ['config', 'user.name', 'Test']);
  git(source, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(source, 'file.txt'), 'base\n');
  writeFileSync(join(source, 'delete.txt'), 'delete me\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'Base']);
  const project = createProject('alice', { name: 'Project', sourcePath: source });
  const task = createTask('alice', { projectId: project.id });
  recordCheckpointBase(task.workspacePath, task.baseRevision);
  if (remote) {
    save('worker', 'alice', { id: 'remote', platform: 'linux' });
    save('task', 'alice', { ...task, workerId: 'remote' });
  }
  return { source, project, task };
}
function move(
  f: ReturnType<typeof fixture>,
  file = 'main.txt',
  content = 'from main\n',
  branch = 'main',
) {
  writeFileSync(join(f.source, file), content);
  git(f.source, ['add', '.']);
  git(f.source, ['commit', '-m', 'Main moved']);
  git(f.source, ['push', f.project.repositoryPath, `HEAD:refs/heads/${branch}`]);
  return git(f.source, ['rev-parse', 'HEAD']);
}
const update = (task: any, action = 'update') =>
  updateBase('alice', task.id, { operationId: randomUUID(), action }, 'agent-run');
async function publish(task: any) {
  const current = get('task', 'alice', task.id);
  return publishTask(
    'alice',
    task.id,
    { operationId: randomUUID(), revision: current.revision },
    randomUUID(),
  );
}
function descendant(repo: string, a: string, b: string) {
  git(repo, ['merge-base', '--is-ancestor', a, b]);
}

test('up-to-date is an idempotent no-op, without touching files or baseline', async () => {
  const { task } = fixture();
  writeFileSync(join(task.workspacePath, 'own.txt'), 'own\n');
  const args = { operationId: randomUUID() };
  const result = await updateBase('alice', task.id, args);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(await updateBase('alice', task.id, args), result);
  assert.equal(readCheckpointBase(task.workspacePath), task.baseRevision);
  assert.equal(readFileSync(join(task.workspacePath, 'own.txt'), 'utf8'), 'own\n');
});

for (const checkpoint of [false, true])
  test(`clean update retains published ancestry and only own diff; ${checkpoint ? 'deploy_commit' : 'publish'} fast-forwards the same PR`, async () => {
    const f = fixture();
    const { task, project } = f;
    writeFileSync(join(task.workspacePath, 'own.txt'), 'own\n');
    const first = await publish(task);
    writeFileSync(join(task.workspacePath, 'unpublished.txt'), 'pending\n');
    const target = move(f);
    const result = await update(task);
    assert.equal(result.status, 'succeeded', result.error);
    const latest = get('task', 'alice', task.id);
    assert.equal(latest.baseRevision, target);
    assert.equal(readFileSync(join(task.workspacePath, 'main.txt'), 'utf8'), 'from main\n');
    assert.deepEqual(
      diff('alice', task.id)
        .files.map((f: any) => f.path)
        .sort(),
      ['own.txt', 'unpublished.txt'],
    );
    assert.equal(captureSnapshot(task.workspacePath).base?.commit, latest.workspaceCommit.commit);
    let commit: string;
    if (checkpoint) {
      const snapshot = captureSnapshot(task.workspacePath);
      const id = randomUUID();
      save('checkpoint', 'alice', { id, taskId: task.id, runId: 'agent-run', snapshot });
      commit = (
        await commitCheckpoint(
          { owner: 'alice', taskId: task.id, runId: 'agent-run' },
          { checkpointId: id, operationId: randomUUID(), message: 'Update task' },
        )
      ).commit;
    } else {
      const next = await publish(task);
      assert.equal(next.pull.id, first.pull.id);
      commit = next.commit;
    }
    descendant(project.repositoryPath, first.commit, commit);
    descendant(project.repositoryPath, target, commit);
    assert.equal(
      list('pull-request', 'alice').filter((p) => p.taskIds.includes(task.id)).length,
      1,
    );
  });

test('conflicts report paths, refuse publication until resolved, and continue retains both parents', async () => {
  const f = fixture();
  const { task, project } = f;
  writeFileSync(join(task.workspacePath, 'file.txt'), 'task\n');
  const first = await publish(task);
  const target = move(f, 'file.txt', 'main\n');
  const result = await update(task);
  assert.equal(result.status, 'conflicted', result.error);
  assert.deepEqual(result.conflicts, ['file.txt']);
  assert.match(readFileSync(join(task.workspacePath, 'file.txt'), 'utf8'), /<<<<<<< /);
  await assert.rejects(publish(task), /Finish or abort/);
  const bad = await update(task, 'continue');
  assert.equal(bad.status, 'failed');
  assert.match(bad.error, /Resolve conflict markers/);
  // A failed continuation resumes the same action after the file is resolved.
  writeFileSync(join(task.workspacePath, 'file.txt'), 'resolved\n');
  const resolved = await update(task, 'continue');
  assert.equal(resolved.status, 'succeeded', resolved.error);
  const next = await publish(task);
  descendant(project.repositoryPath, first.commit, next.commit);
  descendant(project.repositoryPath, target, next.commit);
  assert.equal(git(project.repositoryPath, ['show', `${next.commit}:file.txt`]), 'resolved');
});

test('abort restores exact pre-update edits, untracked files, deletions, HEAD and baseline', async () => {
  const f = fixture();
  const { task } = f;
  writeFileSync(join(task.workspacePath, 'file.txt'), 'task\n');
  await publish(task);
  writeFileSync(join(task.workspacePath, 'untracked.txt'), 'pending\n');
  rmSync(join(task.workspacePath, 'delete.txt'));
  writeFileSync(join(task.workspacePath, 'executable.sh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(task.workspacePath, 'executable.sh'), 0o755);
  writeFileSync(join(task.workspacePath, 'binary.bin'), Buffer.from([0, 255, 0, 64]));
  writeFileSync(join(f.source, 'main-added.txt'), 'new main file\n');
  const before = captureSnapshot(task.workspacePath);
  const head = git(task.workspacePath, ['rev-parse', 'HEAD']);
  move(f, 'file.txt', 'main\n');
  assert.equal((await update(task)).status, 'conflicted');
  const abort = await update(task, 'abort');
  assert.equal(abort.status, 'aborted', abort.error);
  assert.equal(git(task.workspacePath, ['rev-parse', 'HEAD']), head);
  assert.deepEqual(captureSnapshot(task.workspacePath), before);
  assert.equal(get('task', 'alice', task.id).baseRevision, task.baseRevision);
  assert.equal(readFileSync(join(task.workspacePath, 'file.txt'), 'utf8'), 'task\n');
  assert.equal(existsSync(join(task.workspacePath, 'main-added.txt')), false);
});

test('remote worker plans survive a lost completion, authorize repository reads and reject other workers and projects', async () => {
  const f = fixture(true);
  const { task, project } = f;
  writeFileSync(join(task.workspacePath, 'own.txt'), 'own\n');
  const target = move(f);
  const op = await update(task);
  assert.equal(op.status, 'queued');
  assert.equal(workerMayReadRepository('alice', 'remote', project.id), true);
  assert.equal(workerMayReadRepository('alice', 'other', project.id), false);
  await assert.rejects(
    baseUpdateWorker('alice', 'other', 'prepare', {
      id: op.id,
      snapshot: captureSnapshot(task.workspacePath),
    }),
    /does not belong/,
  );
  let dropped = false;
  const request = async (action: string, body: any) => {
    const result = await baseUpdateWorker('alice', 'remote', action, body);
    if (action === 'complete' && !dropped) {
      dropped = true;
      throw new Error('lost reply');
    }
    return result;
  };
  await assert.rejects(
    executeBaseUpdate(task.workspacePath, op, project.repositoryPath, request),
    /lost reply/,
  );
  const done = await executeBaseUpdate(task.workspacePath, op, project.repositoryPath, request);
  assert.equal(done.status, 'succeeded');
  assert.equal(get('task', 'alice', task.id).baseRevision, target);
  assert.deepEqual(
    diff('alice', task.id).files.map((f: any) => f.path),
    ['own.txt'],
  );
  assert.equal(workerMayReadRepository('alice', 'remote', project.id), false);
  await assert.rejects(updateBase('bob', task.id, { operationId: randomUUID() }), /not found/i);
  await assert.rejects(
    updateBase('alice', task.id, { operationId: randomUUID(), projectId: randomUUID() }),
    /only accepts/,
  );
});

test('linked pull target is authoritative; arbitrary branches are refused', async () => {
  const f = fixture();
  const { task, project } = f;
  git(project.repositoryPath, ['branch', 'release', task.baseRevision]);
  writeFileSync(join(task.workspacePath, 'own.txt'), 'own\n');
  const first = await publish(task);
  save('pull-request', 'alice', { ...first.pull, targetBranch: 'release' });
  const target = move(f, 'release.txt', 'release\n', 'release');
  const result = await update(task);
  assert.equal(result.status, 'succeeded', result.error);
  assert.equal(result.target, target);
  assert.equal(git(project.repositoryPath, ['rev-parse', 'main']), task.baseRevision);
  await assert.rejects(
    updateBase('alice', task.id, { operationId: randomUUID(), targetBranch: 'main' }),
    /only accepts/,
  );
  assert.equal(existsSync(join(task.workspacePath, 'release.txt')), true);
});

test('queued remote update can be aborted before the computer returns', async () => {
  const f = fixture(true);
  move(f);
  const before = captureSnapshot(f.task.workspacePath);
  const op = await update(f.task);
  assert.equal(op.status, 'queued');
  const aborted = await update(f.task, 'abort');
  const result = await executeBaseUpdate(
    f.task.workspacePath,
    aborted,
    f.project.repositoryPath,
    (action, body) => baseUpdateWorker('alice', 'remote', action, body),
  );
  assert.equal(result.status, 'aborted');
  assert.deepEqual(captureSnapshot(f.task.workspacePath), before);
});

test('owner conflict action queues the resolving run and active writers block owner updates', async () => {
  const f = fixture();
  writeFileSync(join(f.task.workspacePath, 'file.txt'), 'task\n');
  move(f, 'file.txt', 'main\n');
  const result = await updateBase('alice', f.task.id, { operationId: randomUUID() });
  assert.equal(result.status, 'conflicted', result.error);
  const run = list('run', 'alice').find((run) => run.taskId === f.task.id);
  assert.ok(run, result.error);
  assert.equal(run.status, 'queued');
  assert.match(
    list('message', 'alice').find((message) => message.taskId === f.task.id)?.content,
    /file.txt.*deploy_update_base/,
  );
  const prompt = list('message', 'alice').find((message) => message.taskId === f.task.id)?.content;
  assert.match(prompt, /re-run the relevant checks on the updated tree, then capture a checkpoint/);
  assert.match(prompt, /imperative title.*summary.*last action/);
  await assert.rejects(
    updateBase('alice', f.task.id, { operationId: randomUUID(), action: 'abort' }),
    /Stop the active run/,
  );
});

test('pre-update checkpoints cannot discard the merged target', async () => {
  const f = fixture();
  writeFileSync(join(f.task.workspacePath, 'own.txt'), 'own\n');
  const id = randomUUID();
  save('checkpoint', 'alice', {
    id,
    taskId: f.task.id,
    runId: 'agent-run',
    snapshot: captureSnapshot(f.task.workspacePath),
  });
  move(f);
  assert.equal((await update(f.task)).status, 'succeeded');
  await assert.rejects(
    commitCheckpoint(
      { owner: 'alice', taskId: f.task.id, runId: 'agent-run' },
      { checkpointId: id, operationId: randomUUID(), message: 'Old snapshot' },
    ),
    /capture a new checkpoint/,
  );
});

test('remote clone fetches coordinator merge objects through the authorized Git HTTP endpoint', async () => {
  const f = fixture(true);
  const cwd = join(data, randomUUID());
  git(data, ['clone', f.project.repositoryPath, cwd]);
  recordCheckpointBase(cwd, f.task.baseRevision);
  writeFileSync(join(cwd, 'own.txt'), 'remote own\n');
  const target = move(f);
  const op = await update(f.task);
  const server = createServer((req, res) => {
    void workspaceApi(req, res, 'alice', 'remote');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  try {
    const result = await executeBaseUpdate(
      cwd,
      op,
      `http://127.0.0.1:${address.port}/api/git/${f.project.id}.git`,
      (action, body) => baseUpdateWorker('alice', 'remote', action, body),
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(readFileSync(join(cwd, 'main.txt'), 'utf8'), 'from main\n');
    assert.equal(get('task', 'alice', f.task.id).baseRevision, target);
    assert.deepEqual(
      diff('alice', f.task.id).files.map((file: any) => file.path),
      ['own.txt'],
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('an interrupted installation can resume, while abort fences its stale completion', async () => {
  const f = fixture(true);
  writeFileSync(join(f.task.workspacePath, 'own.txt'), 'own\n');
  move(f);
  const op = await update(f.task);
  const request = (action: string, body: any) => baseUpdateWorker('alice', 'remote', action, body);
  await assert.rejects(
    executeBaseUpdate(f.task.workspacePath, op, f.project.repositoryPath, async (action, body) => {
      if (action === 'complete')
        throw new Error('worker disconnected before acknowledging installation');
      return request(action, body);
    }),
    /disconnected/,
  );
  await baseUpdateWorker('alice', 'remote', 'fail', {
    id: op.id,
    generation: op.generation,
    error: 'connection lost',
  });
  const resumed = await update(f.task, 'continue');
  assert.equal(
    (await executeBaseUpdate(f.task.workspacePath, resumed, f.project.repositoryPath, request))
      .status,
    'succeeded',
  );
  // A second update prepares a plan, then the owner aborts before it installs.
  move(f, 'another-main.txt');
  const second = await update(f.task);
  const plan = await request('prepare', {
    id: second.id,
    generation: second.generation,
    snapshot: captureSnapshot(f.task.workspacePath),
  });
  const abort = await update(f.task, 'abort');
  await assert.rejects(
    request('complete', { id: plan.id, generation: plan.generation }),
    /command changed/,
  );
  const result = await executeBaseUpdate(
    f.task.workspacePath,
    abort,
    f.project.repositoryPath,
    request,
  );
  assert.equal(result.status, 'aborted');
  assert.equal(existsSync(join(f.task.workspacePath, 'another-main.txt')), false);
});

test('a remote task that has never run prepares its original baseline before updating', async () => {
  const f = fixture(true);
  const target = move(f);
  const op = await update(f.task);
  const cwd = join(data, randomUUID(), f.task.id);
  await prepareBaseUpdateWorkspace(cwd, op, f.project.repositoryPath);
  assert.equal(readCheckpointBase(cwd), f.task.baseRevision);
  const result = await executeBaseUpdate(cwd, op, f.project.repositoryPath, (action, body) =>
    baseUpdateWorker('alice', 'remote', action, body),
  );
  assert.equal(result.status, 'succeeded');
  assert.equal(get('task', 'alice', f.task.id).baseRevision, target);
  assert.equal(readFileSync(join(cwd, 'main.txt'), 'utf8'), 'from main\n');
});

test('an unknown check keeps the workspace writer slot until recovered', async () => {
  const f = fixture();
  move(f);
  save('check', 'alice', { id: randomUUID(), taskId: f.task.id, status: 'unknown' });
  await assert.rejects(update(f.task), /Stop the active run or check/);
  assert.equal(get('task', 'alice', f.task.id).baseRevision, f.task.baseRevision);
});

for (const remote of [false, true])
  for (const sameTree of [false, true])
    test(`clean update leaves a publishable checkpoint and an open PR update action; remote=${remote}, same tree=${sameTree}`, async () => {
      const f = fixture();
      // Even if the merge adds only ancestry, publishing must advance the PR.
      writeFileSync(
        join(f.task.workspacePath, 'main.txt'),
        sameTree ? 'from main\n' : 'task content\n',
      );
      const first = await publish(f.task);
      if (remote) {
        save('worker', 'alice', { id: 'remote', platform: 'linux' });
        save('task', 'alice', { ...get('task', 'alice', f.task.id), workerId: 'remote' });
      }
      const target = move(f, sameTree ? 'main.txt' : 'other.txt');
      let result = await update(f.task);
      if (remote)
        result = await executeBaseUpdate(
          f.task.workspacePath,
          result,
          f.project.repositoryPath,
          (action, body) => baseUpdateWorker('alice', 'remote', action, body),
        );
      assert.equal(result.status, 'succeeded', result.error);
      const summary = latestCheckpointSummary('alice', f.task.id)!;
      assert.equal(summary.fresh, true, summary.reason ?? 'missing checkpoint');
      const checkpoint = publishCheckpoint('alice', f.task.id, summary.id);
      assert.equal((await update(f.task)).status, 'succeeded');
      assert.equal(latestCheckpointSummary('alice', f.task.id)!.fresh, true);
      assert.ok(checkpoint.title);
      assert.ok(checkpoint.summary);
      assert.match(
        checkpointPublishReason('alice', f.task.id, checkpoint, [
          {
            createdAt: new Date(Date.parse(checkpoint.createdAt) + 1000).toISOString(),
            payload: { item: { type: 'command_execution' } },
          },
        ])!,
        /capture a new checkpoint/,
      );
      assert.match(
        checkpointPublishReason('alice', f.task.id, {
          ...checkpoint,
          baseUpdateGeneration: 'wrong',
        })!,
        /not captured from this task/,
      );
      assert.equal(checkpoint.snapshot.base.commit, result.commit);
      assert.equal(
        taskQueue('alice', get('task', 'alice', f.task.id)).baseUpdate.needsPublication,
        true,
      );
      const next = await publishTask(
        'alice',
        f.task.id,
        {
          revision: get('task', 'alice', f.task.id).revision,
          checkpointId: summary.id,
          operationId: randomUUID(),
        },
        randomUUID(),
      );
      assert.equal(next.pull.id, first.pull.id);
      descendant(f.project.repositoryPath, first.commit, next.commit);
      descendant(f.project.repositoryPath, target, next.commit);
      assert.equal(
        taskQueue('alice', get('task', 'alice', f.task.id)).baseUpdate.needsPublication,
        false,
      );
      const { collaborationRead } = await import('../../workspace/project-collaboration.ts');
      const comparison = await collaborationRead(
        'alice',
        f.project.id,
        'pulls',
        next.pull.id,
        'diff',
      );
      assert.equal(comparison.fastForward, true);
      // A later agent turn invalidates the automatic checkpoint just as it does an agent checkpoint.
      save('run', 'alice', {
        id: randomUUID(),
        taskId: f.task.id,
        status: 'succeeded',
        createdAt: new Date(Date.parse(checkpoint.createdAt) + 1000).toISOString(),
      });
      assert.match(
        checkpointPublishReason('alice', f.task.id, checkpoint)!,
        /capture a new checkpoint/,
      );
    });

test('base updates keep a resumed workspace on its own private branch', async () => {
  const f = fixture();
  save('task', 'alice', { ...f.task, workspaceGeneration: 'moved' });
  writeFileSync(join(f.task.workspacePath, 'own.txt'), 'preserved edit');
  const target = move(f);
  const result = await update(f.task);
  assert.equal(result.status, 'succeeded', result.error);
  assert.equal(get('task', 'alice', f.task.id).baseRevision, target);
  assert.equal(
    git(f.task.workspacePath, ['symbolic-ref', 'HEAD']),
    `refs/heads/task/${f.task.id}-moved`,
  );
  assert.equal(readFileSync(join(f.task.workspacePath, 'own.txt'), 'utf8'), 'preserved edit');
});
