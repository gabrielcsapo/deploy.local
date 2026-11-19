import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
const data = mkdtempSync(join(tmpdir(), 'deploy-prune-test-'));
process.env.DEPLOY_DATA_DIR = data;
const { workspaceApi } = await import('../../workspace/api.ts');
const { createProject } = await import('../../workspace/test-repository.ts');
const { db, get, save } = await import('../../workspace/store.ts');
const { pruneRepository, pruneIfRewritten, pruneScheduled, pruneSettings, pruneSettled } =
  await import('./repository-prune.ts');
pruneSettings.log = () => {};
const server = createServer((req, res) => void workspaceApi(req, res, 'owner'));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
after(async () => {
  await pruneSettled();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  db.close();
  rmSync(data, { recursive: true, force: true });
});

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
/** For commands that talk to this process's own HTTP server, which a sync call would block. */
const gitAsync = (cwd: string, ...args: string[]) =>
  promisify(execFile)('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
const pointer = (oid: string, size: number) =>
  `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;
const lfsFile = (repository: string, oid: string) =>
  join(repository, 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);
const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
/** An uploaded LFS object, as the LFS API stores it, written two hours ago unless `recent`. */
function upload(owner: string, project: any, bytes: Buffer, recent = false) {
  const oid = createHash('sha256').update(bytes).digest('hex');
  const file = lfsFile(project.repositoryPath, oid);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, bytes);
  if (!recent) utimesSync(file, twoHoursAgo, twoHoursAgo);
  save('lfs-object', owner, {
    id: project.id + ':' + oid,
    projectId: project.id,
    oid,
    size: bytes.length,
    createdAt: new Date().toISOString(),
  });
  return oid;
}
const hasRecord = (owner: string, project: any, oid: string) => {
  try {
    get('lfs-object', owner, project.id + ':' + oid);
    return true;
  } catch {
    return false;
  }
};
/** Commit only `files` on a new root, so nothing older is reachable from it. */
function orphan(work: string, branch: string, files: Record<string, string>) {
  git(work, 'checkout', '-q', '--orphan', branch);
  git(work, 'rm', '-rqf', '--cached', '--ignore-unmatch', '.');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(work, name), text);
  git(work, 'add', ...Object.keys(files));
  git(work, 'commit', '-q', '-m', branch);
  return git(work, 'rev-parse', 'HEAD');
}

test('a prune after a history reset removes the old Git objects and LFS files', async () => {
  const owner = 'owner';
  const project = createProject(owner, { name: 'Reset' });
  const repository = project.repositoryPath;
  const work = join(data, 'work-reset');
  execFileSync('git', ['clone', '-q', repository, work], { env });

  const old = randomBytes(50_000),
    kept = randomBytes(20_000),
    task = randomBytes(15_000),
    pending = randomBytes(5_000);
  const oldOid = upload(owner, project, old);
  const keptOid = upload(owner, project, kept);
  const taskOid = upload(owner, project, task);
  // Uploaded for a push that has not updated its refs yet.
  const pendingOid = upload(owner, project, pending, true);
  writeFileSync(join(work, 'old.psd'), pointer(oldOid, old.length));
  writeFileSync(join(work, 'secret.bin'), randomBytes(80_000).toString('hex'));
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'Old history');
  git(work, 'push', '-q', 'origin', 'main');
  const oldCommit = git(work, 'rev-parse', 'HEAD');
  // A task still holds a commit with its own LFS file.
  orphan(work, 'task', { 'task.psd': pointer(taskOid, task.length) });
  git(work, 'push', '-q', 'origin', 'HEAD:refs/deploy/tasks/task-one');
  // The reset: a new root commit force-pushed over main.
  orphan(work, 'fresh', { 'kept.psd': pointer(keptOid, kept.length) });
  git(work, 'push', '-q', '-f', 'origin', 'fresh:main');
  git(repository, 'repack', '-adq'); // Old history sits in a pack, as on a server that has gc'd.
  assert.equal(git(repository, 'cat-file', '-t', oldCommit), 'commit');

  const result = await pruneRepository(owner, project);
  assert.equal(result.lfs.removed, 1);
  assert.equal(result.lfs.removedBytes, old.length);
  assert.equal(result.lfs.kept, 2);
  assert.equal(result.lfs.recent, 1);
  assert.ok(result.git.after < result.git.before, `${result.git.after} < ${result.git.before}`);
  assert.ok(!existsSync(lfsFile(repository, oldOid)));
  assert.ok(!hasRecord(owner, project, oldOid));
  for (const oid of [keptOid, taskOid, pendingOid]) {
    assert.ok(existsSync(lfsFile(repository, oid)), oid);
    assert.ok(hasRecord(owner, project, oid), oid);
  }
  assert.throws(() => git(repository, 'cat-file', '-t', oldCommit));
  assert.equal(git(repository, 'fsck', '--connectivity-only', '--no-progress'), '');

  // Once the task's ref is gone, its history and LFS file go too.
  git(repository, 'update-ref', '-d', 'refs/deploy/tasks/task-one');
  assert.equal((await pruneRepository(owner, project)).lfs.removed, 1);
  assert.ok(!existsSync(lfsFile(repository, taskOid)));
  assert.ok(existsSync(lfsFile(repository, keptOid)));
});

test('an empty repository prunes without error', async () => {
  const project = createProject('owner', { name: 'Empty' });
  const result = await pruneRepository('owner', project);
  assert.equal(result.lfs.removed, 0);
  assert.equal(result.lfs.kept, 0);
});

test('only pushes that rewrite or delete a branch or tag schedule a prune', async () => {
  const project = createProject('owner', { name: 'Decide' });
  const work = join(data, 'work-decide');
  execFileSync('git', ['clone', '-q', project.repositoryPath, work], { env });
  const first = git(work, 'rev-parse', 'HEAD');
  writeFileSync(join(work, 'a.txt'), 'a\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'a');
  const second = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', '-q', 'origin', 'main');
  const unrelated = orphan(work, 'other', { 'b.txt': 'b\n' });
  git(work, 'push', '-q', 'origin', 'other');
  const zero = '0'.repeat(40);
  const decide = async (previousCommit: string, commit: string) => {
    pruneSettings.delayMs = 60 * 60 * 1000; // Scheduled, never run here.
    try {
      await pruneIfRewritten('owner', project, [
        { ref: 'refs/heads/main', previousCommit, commit },
      ]);
    } finally {
      pruneSettings.delayMs = 30_000;
    }
    return pruneScheduled('owner', project.id);
  };
  assert.equal(await decide(zero, first), false, 'a new branch');
  assert.equal(await decide(first, second), false, 'a fast-forward');
  assert.equal(await decide(second, unrelated), true, 'a force push to unrelated history');
  for (const [from, to, what] of [
    [second, first, 'a reset back'],
    [second, zero, 'a deletion'],
  ]) {
    const other = createProject('owner', { name: what });
    execFileSync('git', ['-C', work, 'push', '-qf', other.repositoryPath, 'main', 'other'], {
      env,
    });
    const scheduled = await pruneIfRewritten('owner', other, [
      { ref: 'refs/heads/main', previousCommit: from, commit: to },
    ]).then(() => pruneScheduled('owner', other.id));
    assert.equal(scheduled, true, what);
  }
});

test('a force push over HTTP prunes the old history and its LFS file', async () => {
  const owner = 'owner';
  const project = createProject(owner, { name: 'Over HTTP' });
  const repository = project.repositoryPath;
  const work = join(data, 'work-http');
  await gitAsync(data, 'clone', '-q', `${origin}/api/git/${project.id}`, work);
  const old = randomBytes(30_000);
  const oldOid = upload(owner, project, old);
  writeFileSync(join(work, 'old.psd'), pointer(oldOid, old.length));
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'Old');
  await gitAsync(work, 'push', '-q', 'origin', 'main');
  const oldCommit = git(work, 'rev-parse', 'HEAD');
  pruneSettings.delayMs = 0;
  try {
    orphan(work, 'fresh', { 'new.txt': 'new\n' });
    await gitAsync(work, 'push', '-q', '-f', 'origin', 'fresh:main');
    for (let i = 0; i < 100 && existsSync(lfsFile(repository, oldOid)); i++)
      await new Promise((done) => setTimeout(done, 50));
    await pruneSettled();
  } finally {
    pruneSettings.delayMs = 30_000;
  }
  assert.ok(!existsSync(lfsFile(repository, oldOid)), 'the old LFS file is gone');
  assert.throws(() => git(repository, 'cat-file', '-t', oldCommit));
});
