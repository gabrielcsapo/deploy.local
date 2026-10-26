import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureSnapshot,
  deltaFileLimit,
  deltaLimit,
  readCheckpointBase,
  recordCheckpointBase,
  restoreCheckpoint,
  restoreSnapshot,
  snapshotLimit,
  validateSnapshot,
  type Snapshot,
} from './checkpoint.ts';
import { extractBaseTree } from './checkpoint-tree.ts';

const data = mkdtempSync(join(tmpdir(), 'deploy-checkpoint-delta-'));
process.env.DEPLOY_DATA_DIR = data;
const { db, get, save, now } = await import('./store.ts');
const { createProject, createTask } = await import('./test-repository.ts');
const { coordinationTool, jobCommand } = await import('./coordination.ts');
const { commitCheckpoint } = await import('./checkpoint-commit.ts');
const { publishTask } = await import('./publish.ts');
const { checkpointBundle } = await import('./application-deployment.ts');
const { latestCheckpointSummary } = await import('./checkpoint-publish.ts');
const { JobRunner } = await import('./job-runner.ts');
const owner = 'delta-owner';
after(() => {
  db.close();
  rmSync(data, { recursive: true, force: true });
});

const git = (cwd: string, args: string[]) => {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 60000 });
  if (result.status !== 0) throw new Error(result.stderr || 'Git failed');
  return result.stdout.trimEnd();
};
const identity = ['-c', 'user.name=deploy.local', '-c', 'user.email=workspace@deploy.local'];

/** A hosted repository with the given initial files, plus a task worktree whose base commit is
 * recorded the way the repository runner and the remote worker record it. */
function repositoryTask(files: Record<string, Buffer | string>, title = 'Large repository') {
  const source = join(data, 'source-' + randomUUID());
  mkdirSync(source);
  git(source, ['init', '--initial-branch=main', '--quiet']);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(source, path, '..'), { recursive: true });
    writeFileSync(join(source, path), content);
  }
  git(source, ['add', '--all']);
  git(source, [...identity, 'commit', '--quiet', '-m', 'Initial repository']);
  const project = createProject(owner, { name: randomUUID(), sourcePath: source });
  const task = createTask(owner, { projectId: project.id, title });
  assert.equal(recordCheckpointBase(task.workspacePath, task.baseRevision), true);
  assert.equal(readCheckpointBase(task.workspacePath), task.baseRevision);
  const run = save('run', owner, {
    id: randomUUID(),
    taskId: task.id,
    workerId: 'local',
    status: 'running',
    generation: randomUUID(),
    createdAt: now(),
  });
  return { project, task, run, scope: { owner, taskId: task.id, runId: run.id } };
}
const capture = (scope: any, cwd: string) =>
  coordinationTool(scope, 'deploy_checkpoint', {
    operationId: randomUUID(),
    snapshot: captureSnapshot(cwd),
  });
const committed = (scope: any, cwd: string, branch?: string) =>
  commitCheckpoint(scope, {
    operationId: randomUUID(),
    checkpointId: capture(scope, cwd).checkpointId,
    message: 'Save verified work',
    ...(branch ? { branch } : {}),
  });
const paths = (snapshot: Snapshot) => snapshot.files.map((file) => file.path);
const big = (bytes: number) => Buffer.alloc(bytes, 0x7a);
async function until(check: () => any, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error('Timed out waiting for condition');
}

test('a repository workspace captures only its changes, with renames split into delete and add', async () => {
  const { task, scope } = repositoryTask({
    '.gitignore': 'ignored\n',
    'keep/mod.txt': 'old\n',
    'keep/del.txt': 'remove me\n',
    'keep/ren.txt': 'rename me\n',
    'script.sh': '#!/bin/sh\necho one\n',
  });
  const cwd = task.workspacePath;
  writeFileSync(join(cwd, 'keep/mod.txt'), 'new\n');
  rmSync(join(cwd, 'keep/del.txt'));
  git(cwd, ['mv', 'keep/ren.txt', 'keep/renamed.txt']);
  chmodSync(join(cwd, 'script.sh'), 0o755);
  writeFileSync(join(cwd, 'fresh.txt'), 'brand new\n');
  writeFileSync(join(cwd, 'ignored'), 'local only\n');
  writeFileSync(join(cwd, '.env'), 'SECRET=never-transfer\n');
  symlinkSync('/etc/hosts', join(cwd, 'outside'));

  const snapshot = captureSnapshot(cwd);
  assert.deepEqual(snapshot.base, { commit: task.baseRevision });
  assert.deepEqual(paths(snapshot), ['fresh.txt', 'keep/mod.txt', 'keep/renamed.txt', 'script.sh']);
  assert.deepEqual(snapshot.deleted, ['keep/del.txt', 'keep/ren.txt']);
  assert.equal(snapshot.files.find((file) => file.path === 'script.sh')?.executable, true);
  assert.ok(snapshot.excluded.includes('.env'));
  assert.ok(snapshot.excluded.includes('outside'));
  assert.ok(!paths(snapshot).includes('ignored'));
  // The digest covers the base and the deletions, not only the files.
  assert.throws(
    () => validateSnapshot({ ...snapshot, deleted: ['keep/del.txt'] }),
    /digest mismatch/,
  );
  assert.throws(
    () => validateSnapshot({ ...snapshot, base: { commit: 'f'.repeat(40) } }),
    /digest mismatch/,
  );
  assert.throws(() => restoreSnapshot(snapshot, join(data, 'refused')), /restoreCheckpoint/);
  const store = get('project', owner, task.projectId).repositoryPath;
  const result = capture(scope, cwd);
  assert.equal(result.base, task.baseRevision);
  assert.equal(result.deletedCount, 2);
  assert.equal(result.fileCount, 4);
  // mod, renamed, fresh, the script's mode, and the two deletions.
  assert.equal(latestCheckpointSummary(owner, task.id)?.changedFileCount, 6);

  const destination = join(data, 'materialized-' + randomUUID());
  await restoreCheckpoint(snapshot, destination, (commit, target) =>
    extractBaseTree(store, commit, target),
  );
  assert.equal(readFileSync(join(destination, 'keep/mod.txt'), 'utf8'), 'new\n');
  assert.equal(readFileSync(join(destination, 'keep/renamed.txt'), 'utf8'), 'rename me\n');
  assert.equal(readFileSync(join(destination, 'fresh.txt'), 'utf8'), 'brand new\n');
  assert.equal(readFileSync(join(destination, '.gitignore'), 'utf8'), 'ignored\n');
  assert.ok(statSync(join(destination, 'script.sh')).mode & 0o111);
  assert.throws(() => statSync(join(destination, 'keep/del.txt')), /ENOENT/);
  assert.throws(() => statSync(join(destination, 'keep/ren.txt')), /ENOENT/);
  assert.throws(() => statSync(join(destination, 'ignored')), /ENOENT/);
});

test('a repository above the full-tree limit checkpoints, runs a job on the whole tree and commits base plus change', async () => {
  const { project, task, scope } = repositoryTask({
    'big.bin': big(9 * 1024 * 1024),
    'README.md': '# Large repository\n',
  });
  const cwd = task.workspacePath;
  // The same workspace without a recorded base is exactly the failure this replaces.
  const plain = join(data, 'plain-' + randomUUID());
  mkdirSync(plain);
  git(plain, ['init', '--quiet']);
  writeFileSync(join(plain, 'big.bin'), big(9 * 1024 * 1024));
  assert.throws(
    () => captureSnapshot(plain),
    /This checkpoint is 9\.0 MiB, above the 8\.0 MiB limit\. Largest files: big\.bin \(9\.0 MiB\)/,
  );

  writeFileSync(join(cwd, 'note.txt'), 'small change\n');
  const snapshot = captureSnapshot(cwd);
  assert.deepEqual(paths(snapshot), ['note.txt']);
  assert.ok(JSON.stringify(snapshot).length < snapshotLimit);
  const checkpoint = capture(scope, cwd);

  // A job sees the full tree in a fresh directory, never the delta alone.
  db.prepare('INSERT OR REPLACE INTO worker VALUES(?,?,?)').run('local', process.pid, now());
  const instanceId = randomUUID();
  const runner = new JobRunner(join(data, 'jobs-' + randomUUID()), async (action, body) =>
    jobCommand(owner, 'local', action, { ...body, instanceId }),
  );
  const timer = setInterval(() => void runner.tick(), 40);
  let job: any;
  try {
    job = coordinationTool(scope, 'deploy_run_job', {
      checkpointId: checkpoint.checkpointId,
      workerId: 'local',
      label: 'Check the job tree',
      command: 'wc -c < big.bin; cat note.txt README.md; ls -a | tr "\\n" " "',
      timeoutMs: 300000,
      operationId: randomUUID(),
    });
    job = await until(() => {
      const row = get('job', owner, job.id);
      return ['succeeded', 'failed', 'timed_out', 'unknown'].includes(row.status) ? row : null;
    });
  } finally {
    clearInterval(timer);
    runner.shutdown();
  }
  assert.equal(job.status, 'succeeded', job.output);
  assert.match(job.output, /9437184/);
  assert.match(job.output, /small change/);
  assert.match(job.output, /# Large repository/);
  assert.ok(!/\.git\b/.test(job.output), job.output);

  // The committed tree is the base tree plus the change, not the delta on its own.
  const result = await commitCheckpoint(scope, {
    operationId: randomUUID(),
    checkpointId: checkpoint.checkpointId,
    message: 'Add a note to a large repository',
  });
  const repo = project.repositoryPath;
  assert.equal(
    git(repo, ['diff', '--name-status', task.baseRevision, result.commit]),
    'A\tnote.txt',
  );
  assert.deepEqual(git(repo, ['ls-tree', '-r', '--name-only', result.commit]).split('\n').sort(), [
    'README.md',
    'big.bin',
    'note.txt',
  ]);
  assert.equal(
    git(repo, ['cat-file', '-s', git(repo, ['rev-parse', `${result.commit}:big.bin`])]),
    String(9 * 1024 * 1024),
  );

  // A later iteration is a delta over the commit the coordinator just installed.
  assert.equal(readCheckpointBase(cwd), result.commit);
  writeFileSync(join(cwd, 'note.txt'), 'second change\n');
  const second = captureSnapshot(cwd);
  assert.deepEqual(second.base, { commit: result.commit });
  assert.deepEqual(paths(second), ['note.txt']);
  const follow = await committed(scope, cwd);
  assert.equal(git(repo, ['rev-parse', `${follow.commit}^`]), result.commit);
  assert.equal(git(repo, ['show', `${follow.commit}:note.txt`]), 'second change');
  assert.equal(git(repo, ['cat-file', '-t', `${follow.commit}:big.bin`]), 'blob');
});

test('publication and deployment materialize a delta over its base', async () => {
  const { project, task, run, scope } = repositoryTask({
    'big.bin': big(9 * 1024 * 1024),
    'deploy.yaml': 'placeholder\n',
  });
  const cwd = task.workspacePath;
  writeFileSync(
    join(cwd, 'deploy.yaml'),
    `apiVersion: deploy.local/v1
kind: Application
metadata:
  name: delta-app
components:
  web:
    build:
      context: .
    interfaces:
      http: { protocol: http, port: 3000 }
routes:
  public: { to: web.http }
`,
  );
  writeFileSync(join(cwd, 'Dockerfile'), 'FROM scratch\n');
  const checkpoint = capture(scope, cwd);
  const stored = get('checkpoint', owner, checkpoint.checkpointId);

  const bundle = await checkpointBundle(stored.snapshot, '.', 'delta-app', project.repositoryPath);
  assert.equal(bundle.application, 'delta-app');
  await assert.rejects(
    checkpointBundle(stored.snapshot, '.', 'delta-app'),
    /delta over .* no repository/,
  );

  save('run', owner, { ...run, status: 'succeeded' });
  save('checkpoint', owner, { ...stored, createdAt: new Date(Date.now() + 1000).toISOString() });
  const published = await publishTask(
    owner,
    task.id,
    {
      operationId: randomUUID(),
      revision: get('task', owner, task.id).revision,
      checkpointId: checkpoint.checkpointId,
      title: 'Deploy a large repository',
    },
    randomUUID(),
  );
  const repo = project.repositoryPath;
  assert.deepEqual(
    git(repo, ['diff', '--name-status', task.baseRevision, published.commit]).split('\n').sort(),
    ['A\tDockerfile', 'M\tdeploy.yaml'],
  );
  assert.equal(git(repo, ['cat-file', '-t', `${published.commit}:big.bin`]), 'blob');
});

test('the coordinator refuses a base commit it does not have and keeps full snapshots working', () => {
  const { task, scope } = repositoryTask({ 'app.txt': 'source\n' });
  const unknown = 'a'.repeat(40);
  const files = [
    { path: 'app.txt', content: Buffer.from('changed\n').toString('base64'), executable: false },
  ];
  const snapshot = {
    base: { commit: unknown },
    files,
    deleted: [],
    excluded: [],
    digest: createHash('sha256')
      .update(JSON.stringify({ base: { commit: unknown }, files, deleted: [] }))
      .digest('hex'),
  };
  assert.throws(
    () => coordinationTool(scope, 'deploy_checkpoint', { operationId: randomUUID(), snapshot }),
    new RegExp(`Checkpoint base commit ${unknown} is not in this repository`),
  );
  assert.throws(
    () =>
      validateSnapshot({
        ...snapshot,
        base: { commit: 'refs/heads/main' } as any,
      }),
    /must name a Git commit/,
  );
  assert.throws(
    () => validateSnapshot({ files, deleted: ['other'], excluded: [], digest: '' }),
    /deletions require a base commit/,
  );

  // A conversation without a repository keeps the full-tree shape, and cannot claim a base.
  const scratch = createTask(owner, { title: 'No repository' });
  const scratchRun = save('run', owner, {
    id: randomUUID(),
    taskId: scratch.id,
    status: 'running',
  });
  const scratchScope = { owner, taskId: scratch.id, runId: scratchRun.id };
  writeFileSync(join(scratch.workspacePath, 'notes.txt'), 'local work\n');
  const full = captureSnapshot(scratch.workspacePath);
  assert.equal(full.base, undefined);
  assert.equal(full.deleted, undefined);
  assert.deepEqual(paths(full), ['notes.txt']);
  // Unchanged digest coverage keeps checkpoints stored before deltas valid.
  assert.equal(full.digest, createHash('sha256').update(JSON.stringify(full.files)).digest('hex'));
  assert.equal(capture(scratchScope, scratch.workspacePath).fileCount, 1);
  assert.throws(
    () =>
      coordinationTool(scratchScope, 'deploy_checkpoint', {
        operationId: randomUUID(),
        snapshot,
      }),
    /no repository/,
  );
  const restored = join(data, 'scratch-' + randomUUID());
  restoreSnapshot(full, restored);
  assert.equal(readFileSync(join(restored, 'notes.txt'), 'utf8'), 'local work\n');
  assert.ok(task.baseRevision);
});

test('a checkpoint stored in the old full-tree format still commits', async () => {
  const { project, task, scope } = repositoryTask({ 'app.txt': 'source\n' });
  const files = [
    { path: 'app.txt', content: Buffer.from('legacy\n').toString('base64'), executable: false },
    { path: 'added.txt', content: Buffer.from('added\n').toString('base64'), executable: false },
  ].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const legacy = save('checkpoint', owner, {
    id: randomUUID(),
    taskId: task.id,
    runId: scope.runId,
    // Exactly what a worker recorded before delta checkpoints existed.
    snapshot: {
      files,
      excluded: [],
      digest: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    },
    createdAt: now(),
  });
  const result = await commitCheckpoint(scope, {
    operationId: randomUUID(),
    checkpointId: legacy.id,
    message: 'Commit a legacy checkpoint',
  });
  assert.deepEqual(
    git(project.repositoryPath, ['ls-tree', '-r', '--name-only', result.commit]).split('\n').sort(),
    ['added.txt', 'app.txt'],
  );
  assert.equal(git(project.repositoryPath, ['show', `${result.commit}:app.txt`]), 'legacy');
});

test('delta size limits name the largest changed files', () => {
  const { task } = repositoryTask({ 'app.txt': 'source\n' }, 'Oversized change');
  const cwd = task.workspacePath;
  const chunk = big(13 * 1024 * 1024);
  for (const name of ['one', 'two', 'three', 'four', 'five'])
    writeFileSync(join(cwd, `${name}.bin`), chunk);
  assert.throws(
    () => captureSnapshot(cwd),
    (error: Error) => {
      assert.match(
        error.message,
        /This checkpoint’s changed content is 65\.0 MiB, above the 64\.0 MiB limit\./,
      );
      assert.match(error.message, /Largest files: /);
      assert.equal(error.message.match(/\(13\.0 MiB\)/g)?.length, 5);
      return true;
    },
  );
  for (const name of ['two', 'three', 'four', 'five']) rmSync(join(cwd, `${name}.bin`));
  writeFileSync(join(cwd, 'one.bin'), big(deltaFileLimit + 1024));
  assert.throws(
    () => captureSnapshot(cwd),
    /Checkpoint file one\.bin is 16\.0 MiB, above the 16\.0 MiB limit for one file/,
  );
  rmSync(join(cwd, 'one.bin'));
  // The stored limits are the ones the capture side enforces.
  assert.equal(deltaLimit, 64 * 1024 * 1024);
  assert.equal(validateSnapshot(captureSnapshot(cwd)).files.length, 0);
});
