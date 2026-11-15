import { captureSnapshot, restoreSnapshot } from './checkpoint.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const root = mkdtempSync(join(tmpdir(), 'checkpoint-retention-'));
process.env.DEPLOY_DATA_DIR = root;
const { db, save, get, remove } = await import('../../workspace/store.ts');
const { createProject, createTask } = await import('../../workspace/test-repository.ts');
const { cleanupCheckpointRefs, sweepCheckpointRefs } = await import('./checkpoint-retention.ts');
const { setTaskOutcome } = await import('../../workspace/service.ts');
const { closeMergedTasks } = await import('../../workspace/project-collaboration.ts');
const { gitSync } = await import('../../workspace/repository-git.ts');
const owner = 'checkpoint-retention';
const project = createProject(owner, { name: 'retention' });
const base = gitSync(project.repositoryPath, ['rev-parse', 'HEAD'])!;
let sequence = 0;
function fixture(status = 'review', publishedAt: string | null = '2026-02-01T00:00:00.000Z') {
  const task = createTask(owner, { projectId: project.id });
  save('task', owner, { ...task, status, publishedAt });
  const id = `checkpoint-${++sequence}`;
  const ref = `refs/deploy/checkpoint/${createHash('sha256').update(id).digest('hex')}`;
  gitSync(project.repositoryPath, ['update-ref', ref, base]);
  const checkpoint = save('checkpoint', owner, {
    id,
    taskId: task.id,
    projectId: project.id,
    baseRef: ref,
    snapshot: { base: { commit: base } },
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  return { task: get('task', owner, task.id), checkpoint, ref };
}
const retained = (ref: string) =>
  gitSync(project.repositoryPath, ['rev-parse', '--verify', '--quiet', ref]) === base;
test.after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('sweep retains open task refs and removes published closed, merged and deleted task refs', () => {
  const open = fixture();
  const closed = fixture('done');
  const merged = fixture('merged');
  const deleted = fixture();
  remove('task', owner, deleted.task.id);
  sweepCheckpointRefs();
  assert.equal(retained(open.ref), true);
  for (const { ref } of [closed, merged, deleted]) assert.equal(retained(ref), false);
  assert.equal(cleanupCheckpointRefs(owner), 0);
});

test('close and merge clean refs immediately', () => {
  const closed = fixture();
  setTaskOutcome(owner, closed.task.id, 'close', { revision: closed.task.revision });
  assert.equal(retained(closed.ref), false);
  const merged = fixture();
  closeMergedTasks(owner, { id: 'merged-pull', status: 'merged', taskIds: [merged.task.id] });
  assert.equal(retained(merged.ref), false);
});

test('closed tasks retain unpublished checkpoints and active job/deployment bases until complete', () => {
  const unpublished = fixture('done', null);
  const newer = fixture('done');
  save('checkpoint', owner, { ...newer.checkpoint, createdAt: '2026-03-01T00:00:00.000Z' });
  const job = fixture('done');
  save('job', owner, {
    id: 'active-job',
    taskId: job.task.id,
    checkpointId: job.checkpoint.id,
    status: 'running',
  });
  const queued = fixture('done');
  save('job', owner, { id: 'queued-job', checkpointId: queued.checkpoint.id, status: 'queued' });
  const deployment = fixture('done');
  save('application-deployment', owner, {
    id: 'active-deploy',
    checkpointId: deployment.checkpoint.id,
  });
  cleanupCheckpointRefs(owner);
  for (const { ref } of [unpublished, newer, job, queued, deployment])
    assert.equal(retained(ref), true);
  save('job', owner, { ...get('job', owner, 'active-job'), status: 'succeeded' });
  save('job', owner, { ...get('job', owner, 'queued-job'), status: 'cancelled' });
  save('application-deployment', owner, {
    ...get('application-deployment', owner, 'active-deploy'),
    completedAt: 'done',
  });
  cleanupCheckpointRefs(owner);
  for (const { ref } of [job, queued, deployment]) assert.equal(retained(ref), false);
  for (const { ref } of [unpublished, newer]) assert.equal(retained(ref), true);
});

test('legacy checkpoint on a deleted task is located by exact ref; unrelated refs are preserved', () => {
  const legacy = fixture();
  save('checkpoint', owner, { ...legacy.checkpoint, projectId: undefined });
  remove('task', owner, legacy.task.id);
  const unrelated = 'refs/deploy/checkpoint/' + 'f'.repeat(64);
  gitSync(project.repositoryPath, ['update-ref', unrelated, base]);
  cleanupCheckpointRefs(owner);
  assert.equal(retained(legacy.ref), false);
  assert.equal(retained(unrelated), true);
});

test('publishing an older checkpoint preserves later unpublished captures', () => {
  const published = fixture('done');
  save('task', owner, { ...published.task, publishedCheckpointId: published.checkpoint.id });
  const ref = `refs/deploy/checkpoint/${'e'.repeat(64)}`;
  gitSync(project.repositoryPath, ['update-ref', ref, base]);
  save('checkpoint', owner, {
    ...published.checkpoint,
    id: 'later-unpublished',
    baseRef: ref,
    createdAt: '2026-01-02T00:00:00.000Z',
  });
  cleanupCheckpointRefs(owner, published.task.id);
  assert.equal(retained(published.ref), false);
  assert.equal(retained(ref), true);
});

test('closed unpublished checkpoints remain restorable after 30 days in both storage forms', () => {
  const f = fixture('done', null);
  // Fixed historical evidence: no dependence on the wall clock or next month's date.
  save('task', owner, { ...f.task, closedAt: '2000-01-01T00:00:00.000Z' });
  const snapshot = captureSnapshot(f.task.workspacePath);
  for (const form of ['inline', 'external']) {
    const row = { ...f.checkpoint, id: 'old-unpublished-' + form, snapshot };
    if (form === 'inline')
      db.prepare("INSERT INTO records VALUES('checkpoint',?,?,?)").run(
        row.id,
        owner,
        JSON.stringify(row),
      );
    else save('checkpoint', owner, row);
    cleanupCheckpointRefs(owner, f.task.id);
    assert.equal(retained(f.ref), true);
    const stored = get('checkpoint', owner, row.id);
    assert.deepEqual(stored.snapshot, snapshot);
    const target = join(root, 'restored-' + form);
    restoreSnapshot(stored.snapshot, target);
    for (const file of snapshot.files)
      assert.deepEqual(readFileSync(join(target, file.path)), Buffer.from(file.content, 'base64'));
  }
});
