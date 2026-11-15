import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DEPLOY_DATA_DIR = mkdtempSync(join(tmpdir(), 'deploy-file-patch-test-'));
const { get, save } = await import('../../workspace/store.ts');
const { createProject, createTask } = await import('../../workspace/test-repository.ts');
const { startRun, git, taskFilePatch, taskPatch } = await import('../../workspace/service.ts');
const { captureTurnCheckpoint } = await import('./turn-checkpoint.ts');
const {
  changedPaths,
  summaryPatchLimit,
  inspectWorkspace,
  workspaceFilePatch,
  workspaceFilePatches,
} = await import('../../workspace/review.ts');
const { workerCommand } = await import('../../workspace/protocol.ts');

/** Over 50 KB of patch in one file, so the summary limit must clip it. */
const large = (marker: string) =>
  Array.from({ length: 4000 }, (_, line) => `${marker} line ${line} ${'x'.repeat(20)}`).join('\n') +
  '\n';

test('a file larger than the summary patch limit is still reviewable file by file', () => {
  const project = createProject('patches', { name: 'Large change' }),
    task = createTask('patches', { projectId: project.id, title: 'Grow a file' });
  writeFileSync(join(task.workspacePath, 'big.txt'), large('tracked'));
  writeFileSync(join(task.workspacePath, 'new.txt'), large('untracked'));
  git(task.workspacePath, ['add', 'big.txt']);
  git(task.workspacePath, [
    '-c',
    'user.name=deploy.local',
    '-c',
    'user.email=workspace@deploy.local',
    'commit',
    '-m',
    'Add big.txt',
  ]);
  const base = get('task', 'patches', task.id).baseRevision;
  const summary = inspectWorkspace(task.workspacePath, base, summaryPatchLimit);
  assert.equal(summary.truncated, true);
  assert.equal(summary.patch.length, summaryPatchLimit);

  const tracked = taskFilePatch('patches', task.id, 'big.txt', 'all');
  assert.equal(tracked.truncated, false);
  assert.ok(tracked.bytes > summaryPatchLimit, `expected a large patch, got ${tracked.bytes}`);
  assert.match(tracked.patch, /^diff --git a\/big\.txt b\/big\.txt$/m);
  assert.match(tracked.patch, /\+tracked line 3999 /);

  // Untracked files have no diff against the base revision; they compare with /dev/null.
  const untracked = taskFilePatch('patches', task.id, 'new.txt', 'all');
  assert.equal(untracked.truncated, false);
  assert.ok(untracked.bytes > summaryPatchLimit);
  assert.match(untracked.patch, /\+untracked line 3999 /);

  // A tracked file nobody touched keeps an empty patch; it must never read as newly added.
  const head = git(task.workspacePath, ['rev-parse', 'HEAD']);
  assert.deepEqual(workspaceFilePatch(task.workspacePath, head, 'big.txt'), {
    path: 'big.txt',
    patch: '',
    bytes: 0,
    truncated: false,
  });

  // The whole-change download covers both files, well past the summary limit.
  const whole = taskPatch('patches', task.id, 'all');
  assert.equal(whole.truncated, false);
  assert.match(whole.name, /\.patch$/);
  assert.ok(whole.patch.includes('+tracked line 3999 '));
  assert.ok(whole.patch.includes('+untracked line 3999 '));
  assert.ok(whole.bytes > 2 * summaryPatchLimit);
});

test('an uploaded bundle stops at its budget and reports that it is incomplete', () => {
  const project = createProject('patches', { name: 'Capped' }),
    task = createTask('patches', { projectId: project.id, title: 'Cap' });
  writeFileSync(join(task.workspacePath, 'capped.txt'), large('capped'));
  const capped = taskFilePatch('patches', task.id, 'capped.txt', 'all');
  assert.equal(capped.truncated, false);
  const { patches, truncated } = workspaceFilePatches(
    task.workspacePath,
    get('task', 'patches', task.id).baseRevision,
    [{ status: '??', path: 'capped.txt' }],
    (path) => ({ path, patch: 'x'.repeat(100), bytes: 400, truncated: true }),
  );
  assert.equal(truncated, true);
  assert.deepEqual(
    patches.map((file) => file.path),
    ['capped.txt'],
  );
});

test('credential-like and traversing paths are refused before Git sees them', () => {
  const project = createProject('patches', { name: 'Refusals' }),
    task = createTask('patches', { projectId: project.id, title: 'Refuse' });
  writeFileSync(join(task.workspacePath, '.env'), 'SECRET=1\n');
  assert.throws(() => taskFilePatch('patches', task.id, '.env', 'all'), /Credential-like/);
  for (const path of ['../outside.txt', '', 'a/../b', '.git/config'])
    assert.throws(() => taskFilePatch('patches', task.id, path, 'all'), /Invalid workspace path/);
  // Porcelain status names renames as `old -> new`; the new path is the one with a patch.
  assert.deepEqual(
    changedPaths([
      { status: 'R ', path: 'old.txt -> new.txt' },
      { status: '??', path: '.env' },
      { status: 'M ', path: 'kept.txt' },
      { status: 'M ', path: 'kept.txt' },
    ]),
    ['new.txt', 'kept.txt'],
  );
});

test('the turn scope compares this turn’s checkpoints for one file', () => {
  const project = createProject('patches', { name: 'Turn scope' }),
    task = createTask('patches', { projectId: project.id, title: 'Turn' });
  const first = startRun('patches', task.id, { revision: 0, content: 'first' });
  writeFileSync(join(task.workspacePath, 'before.txt'), 'before\n');
  save('run', 'patches', {
    ...get('run', 'patches', first.id),
    status: 'succeeded',
    checkpoint: captureTurnCheckpoint(task.workspacePath),
  });
  const second = startRun('patches', task.id, {
    revision: get('task', 'patches', task.id).revision,
    content: 'second',
  });
  writeFileSync(join(task.workspacePath, 'during.txt'), large('during'));
  save('run', 'patches', {
    ...get('run', 'patches', second.id),
    status: 'succeeded',
    startCheckpoint: null,
  });
  const turn = taskFilePatch('patches', task.id, 'during.txt', 'turn');
  assert.equal(turn.scope, 'turn');
  assert.ok(turn.bytes > summaryPatchLimit);
  assert.match(turn.patch, /\+during line 3999 /);
  // The previous turn's file is unchanged in this turn, so its patch is empty, not an error.
  assert.equal(taskFilePatch('patches', task.id, 'before.txt', 'turn').patch, '');
});

test('a task computer’s uploaded per-file patches serve the review it was captured with', () => {
  save('worker', 'uploads', {
    id: 'remote',
    name: 'SER',
    instanceId: 'instance',
    heartbeat: new Date().toISOString(),
    capabilities: ['git', 'shell', 'codex'],
    roles: { tasks: 'ready' },
  });
  const project = createProject('uploads', { name: 'Remote' }),
    task = createTask('uploads', { projectId: project.id, title: 'Remote', workerId: 'remote' });
  const run = startRun('uploads', task.id, { revision: 0, content: 'go' });
  save('run', 'uploads', {
    ...get('run', 'uploads', run.id),
    status: 'running',
    assignedInstanceId: 'other',
  });
  const base = get('task', 'uploads', task.id).baseRevision;
  // Before any upload the coordinator says where the full patch is, instead of inventing one.
  const pending = taskFilePatch('uploads', task.id, 'remote.txt', 'all');
  assert.match(pending.omitted ?? '', /SER/);
  assert.equal(pending.patch, '');
  workerCommand('uploads', '/workers/remote/complete', {
    instanceId: 'instance',
    runId: run.id,
    generation: get('run', 'uploads', run.id).generation,
    status: 'succeeded',
    diff: {
      baseRevision: base,
      headRevision: base,
      patch: 'diff --git a/remote.txt b/remote.txt\n',
      truncated: true,
      status: '',
      files: [{ status: '??', path: 'remote.txt' }],
      excluded: [],
    },
    filePatches: [
      {
        path: 'remote.txt',
        patch: 'diff --git a/remote.txt b/remote.txt\n@@ -0,0 +1 @@\n+remote\n',
        bytes: 60,
        truncated: false,
      },
    ],
  });
  const uploaded = taskFilePatch('uploads', task.id, 'remote.txt', 'all');
  assert.equal(uploaded.omitted, undefined);
  assert.match(uploaded.patch, /\+remote\n/);
  assert.match(taskPatch('uploads', task.id, 'all').patch, /\+remote\n/);
  // A file the computer uploaded no patch for is named, not silently shown as unchanged.
  assert.match(taskFilePatch('uploads', task.id, 'other.txt', 'all').omitted ?? '', /no patch/);
  // A refreshed snapshot without a bundle must not be answered from the previous one.
  save('remote-diff', 'uploads', {
    ...get('remote-diff', 'uploads', task.id),
    receivedAt: new Date(Date.now() + 1000).toISOString(),
  });
  assert.match(taskFilePatch('uploads', task.id, 'remote.txt', 'all').omitted ?? '', /SER/);
});
