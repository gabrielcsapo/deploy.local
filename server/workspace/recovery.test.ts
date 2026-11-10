import {
  externalizeCheckpoint,
  materializeCheckpoint,
  checkpointBlobPath,
} from './checkpoint-storage.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { snapshotWorkspace, verifyWorkspaceSnapshot, restoreWorkspace } from './recovery.ts';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'workspace-recovery-'));
  const source = join(root, 'workspace');
  await mkdir(source);
  const database = new Database(join(source, 'workspace.db'));
  database.exec(
    'CREATE TABLE records(kind TEXT,id TEXT,owner TEXT,data TEXT); CREATE TABLE events(cursor INTEGER PRIMARY KEY,payload TEXT); CREATE TABLE operations(id TEXT,result TEXT); CREATE TABLE worker(id TEXT,pid INTEGER,heartbeat TEXT)',
  );
  const insert = database.prepare('INSERT INTO records VALUES(?,?,?,?)');
  insert.run(
    'task',
    'task',
    'owner',
    JSON.stringify({ id: 'task', workspacePath: join(source, 'tasks/task'), status: 'review' }),
  );
  insert.run(
    'checkpoint',
    'checkpoint',
    'owner',
    JSON.stringify({
      id: 'checkpoint',
      snapshot: { files: [{ path: 'work.txt', content: 'retained' }] },
    }),
  );
  insert.run(
    'worker-credential',
    'remote',
    'owner',
    JSON.stringify({ hash: 'never-reuse-after-restore' }),
  );
  database
    .prepare('INSERT INTO events VALUES(1,?)')
    .run(JSON.stringify({ text: 'Conversation retained' }));
  database.close();
  return { root, source };
}
const git = (path: string, ...args: string[]) =>
  execFileSync('git', ['-C', path, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
test('offline recovery retains real Git/worktree state, LFS bytes, conversation and checkpoints; old worker credentials cannot reconnect', async () => {
  const { root, source } = await fixture();
  try {
    const repo = join(source, 'repositories/project.git'),
      task = join(source, 'tasks/task');
    await mkdir(join(source, 'repositories'));
    await mkdir(join(source, 'tasks'));
    execFileSync('git', ['init', '--bare', '--initial-branch=main', repo], { stdio: 'ignore' });
    git(repo, 'worktree', 'add', '--orphan', '-b', 'task', task);
    git(task, 'config', 'user.name', 'Recovery Test');
    git(task, 'config', 'user.email', 'recovery@example.invalid');
    await writeFile(join(task, 'work.txt'), 'committed\n');
    git(task, 'add', '.');
    git(task, 'commit', '-m', 'Initial');
    const commit = git(task, 'rev-parse', 'HEAD');
    await writeFile(join(task, 'work.txt'), 'dirty edits\n');
    await writeFile(join(task, 'untracked.txt'), 'keep me');
    await mkdir(join(repo, 'lfs/objects'), { recursive: true });
    const asset = Buffer.alloc(1024 * 1024, 7);
    await writeFile(join(repo, 'lfs/objects/fixture'), asset);
    await symlink('work.txt', join(task, 'relative-link'));
    const backup = join(root, 'backup');
    await snapshotWorkspace(source, backup);
    await verifyWorkspaceSnapshot(backup);
    await assert.rejects(restoreWorkspace(backup, source), /must not exist/);
    await assert.rejects(
      restoreWorkspace(backup, join(root, 'different')),
      /original workspace path/,
    );
    await rename(source, join(root, 'original'));
    await restoreWorkspace(backup, source);
    assert.equal(git(task, 'rev-parse', 'HEAD'), commit);
    assert.equal(await readFile(join(task, 'work.txt'), 'utf8'), 'dirty edits\n');
    assert.match(git(task, 'status', '--porcelain'), /M work.txt/);
    assert.equal(await readFile(join(task, 'untracked.txt'), 'utf8'), 'keep me');
    assert.deepEqual(await readFile(join(repo, 'lfs/objects/fixture')), asset);
    const db = new Database(join(source, 'workspace.db'));
    assert.equal((db.prepare('SELECT COUNT(*) n FROM events').get() as { n: number }).n, 1);
    assert.equal(
      (db.prepare("SELECT COUNT(*) n FROM records WHERE kind='checkpoint'").get() as { n: number })
        .n,
      1,
    );
    assert.equal(
      (
        db.prepare("SELECT COUNT(*) n FROM records WHERE kind='worker-credential'").get() as {
          n: number;
        }
      ).n,
      0,
    );
    db.close();
    await writeFile(join(backup, 'tasks/task/work.txt'), 'tampered');
    await assert.rejects(verifyWorkspaceSnapshot(backup), /verification failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('active work, external symlinks and destinations inside the workspace fail without publishing a backup', async () => {
  const { root, source } = await fixture();
  try {
    const db = new Database(join(source, 'workspace.db'));
    db.prepare('INSERT INTO records VALUES(?,?,?,?)').run(
      'job',
      'pending',
      'owner',
      JSON.stringify({ id: 'pending', status: 'queued' }),
    );
    db.close();
    await assert.rejects(snapshotWorkspace(source, join(root, 'pending')), /pending job/);
    const clean = new Database(join(source, 'workspace.db'));
    clean.exec("DELETE FROM records WHERE kind='job'");
    clean.close();
    await assert.rejects(snapshotWorkspace(source, join(source, 'backup')), /outside/);
    await symlink('../outside', join(source, 'external'));
    await assert.rejects(
      snapshotWorkspace(source, join(root, 'external-backup')),
      /External symlink/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('offline recovery carries mixed inline and external bodies, and refuses a missing body', async () => {
  const { root, source } = await fixture();
  try {
    const snapshot = {
      files: [{ path: 'binary.dat', content: 'AP8BAg==', executable: true }],
      excluded: [],
      digest: 'fixture',
    };
    const stored = externalizeCheckpoint(source, { id: 'external', snapshot });
    const database = new Database(join(source, 'workspace.db'));
    database
      .prepare("INSERT INTO records VALUES('checkpoint','external','owner',?)")
      .run(JSON.stringify(stored));
    database.close();
    const backup = join(root, 'backup');
    await snapshotWorkspace(source, backup);
    await rename(source, join(root, 'original'));
    await restoreWorkspace(backup, source);
    const restored = new Database(join(source, 'workspace.db'));
    try {
      const rows = restored.prepare("SELECT data FROM records WHERE kind='checkpoint'").all() as {
        data: string;
      }[];
      assert.equal(rows.length, 2);
      assert.deepEqual(materializeCheckpoint(source, JSON.parse(rows[1].data)).snapshot, snapshot);
      assert.equal(JSON.parse(rows[0].data).snapshot.files[0].content, 'retained');
    } finally {
      restored.close();
    }
    await rm(checkpointBlobPath(source, stored.snapshotBlob));
    await assert.rejects(snapshotWorkspace(source, join(root, 'incomplete')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
