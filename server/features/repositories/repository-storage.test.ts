import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
const data = mkdtempSync(join(tmpdir(), 'deploy-storage-test-'));
process.env.DEPLOY_DATA_DIR = data;
const { workspaceApi } = await import('../../workspace/api.ts');
const { createProject } = await import('../../workspace/test-repository.ts');
const { db, save } = await import('../../workspace/store.ts');
const storage = await import('./repository-storage.ts');
const server = createServer(
  (req, res) =>
    void workspaceApi(
      req,
      res,
      String(req.headers['x-owner'] || 'owner'),
      req.headers['x-worker'] ? 'worker' : undefined,
    ),
);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  db.close();
  rmSync(data, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  }).trim();
const pointer = (oid: string, size: number) =>
  `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;
function lfsObject(repository: string, bytes: Buffer) {
  const oid = createHash('sha256').update(bytes).digest('hex');
  const folder = join(repository, 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, oid), bytes);
  return oid;
}
function folderBytes(folder: string): number {
  return readdirSync(folder, { withFileTypes: true }).reduce((sum, entry) => {
    const path = join(folder, entry.name);
    return sum + (entry.isDirectory() ? folderBytes(path) : lstatSync(path).size);
  }, 0);
}
const at = (date: string) => ({ GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
function commitAt(cwd: string, date: string, message: string) {
  execFileSync('git', ['-C', cwd, 'commit', '-q', '-m', message], {
    env: {
      ...process.env,
      ...at(date),
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
}

/** A hosted repository with branches, a tag, a deleted file, deploy.local refs and LFS. */
function fixture(owner = 'owner', name = 'Storage') {
  const project = createProject(owner, { name });
  const repository = project.repositoryPath;
  const work = join(data, `work-${project.id}`);
  execFileSync('git', ['clone', '-q', repository, work]);
  const video = randomBytes(40_000),
    old = randomBytes(30_000),
    orphan = randomBytes(10_000);
  const videoOid = lfsObject(repository, video),
    oldOid = lfsObject(repository, old),
    orphanOid = lfsObject(repository, orphan);
  mkdirSync(join(work, 'assets'));
  writeFileSync(join(work, 'assets/video.mp4'), pointer(videoOid, video.length));
  writeFileSync(join(work, 'assets/old.mov'), pointer(oldOid, old.length));
  writeFileSync(join(work, 'big.bin'), randomBytes(60_000));
  writeFileSync(join(work, 'keep.txt'), 'first\n');
  git(work, 'add', '.');
  commitAt(work, '2026-01-10T12:00:00Z', 'Add files');
  git(work, 'rm', '-q', 'big.bin', 'assets/old.mov');
  writeFileSync(join(work, 'keep.txt'), 'second\n');
  git(work, 'add', '.');
  commitAt(work, '2026-03-05T12:00:00Z', 'Remove big files');
  git(work, 'tag', 'v1');
  git(work, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(work, 'feature.txt'), 'feature\n');
  git(work, 'add', '.');
  commitAt(work, '2026-04-01T12:00:00Z', 'Feature');
  git(work, 'push', '-q', 'origin', 'main', 'feature', 'v1');
  // Work only deploy.local's refs hold: a task, a checkpoint named after a hash, a design review.
  const extra = (file: string, bytes: number) => {
    git(work, 'checkout', '-q', '--detach', 'main');
    writeFileSync(join(work, file), randomBytes(bytes));
    git(work, 'add', '.');
    commitAt(work, '2026-05-01T12:00:00Z', file);
    return git(work, 'rev-parse', 'HEAD');
  };
  const checkpointRef = `refs/deploy/checkpoint/${'a'.repeat(64)}`;
  git(work, 'push', '-q', 'origin', `${extra('task.bin', 20_000)}:refs/deploy/tasks/task-one`);
  git(work, 'push', '-q', 'origin', `${extra('checkpoint.bin', 5_000)}:${checkpointRef}`);
  git(work, 'push', '-q', 'origin', `${extra('review.bin', 5_000)}:refs/deploy/design-reviews/r1`);
  db.prepare('INSERT INTO records VALUES(?,?,?,?)').run(
    'checkpoint',
    `checkpoint-${project.id}`,
    owner,
    JSON.stringify({ id: `checkpoint-${project.id}`, taskId: 'task-two', baseRef: checkpointRef }),
  );
  return { project, repository, work, videoOid, oldOid, orphanOid, video, old, orphan };
}

test('measures a repository by what holds its bytes', async () => {
  const f = fixture();
  const result = await storage.measureRepositoryStorage(f.repository, {
    defaultBranch: 'main',
    taskOfRef: (ref) => (ref.startsWith('refs/deploy/checkpoint/') ? 'task-two' : undefined),
  });
  assert.equal(result.total, folderBytes(f.repository));
  assert.deepEqual(result.largeFiles, {
    count: 3,
    bytes: f.video.length + f.old.length + f.orphan.length,
  });
  // The same numbers Git gives for the same ranges.
  const usage = (...args: string[]) =>
    Number(git(f.repository, 'rev-list', '--disk-usage', '--objects', ...args));
  assert.equal(result.history.bytes, usage('--branches', '--tags'));
  assert.equal(
    result.history.commits,
    Number(git(f.repository, 'rev-list', '--count', '--branches', '--tags')),
  );
  assert.equal(result.history.files, 5);
  assert.equal(result.work.bytes, usage('--glob=refs/deploy/*', '--not', '--branches', '--tags'));
  assert.equal(result.work.tasks, 2);
  assert.equal(result.work.reviews, 1);
  assert.equal(
    result.other.bytes,
    result.total - result.largeFiles.bytes - result.history.bytes - result.work.bytes,
  );
  assert.ok(result.other.bytes >= 0);

  const lfs = new Map(result.lfs.map((file) => [file.oid, file]));
  assert.deepEqual(
    result.lfs.map((file) => file.bytes),
    [f.video.length, f.old.length, f.orphan.length],
  );
  assert.equal(lfs.get(f.videoOid)!.path, 'assets/video.mp4');
  assert.equal(lfs.get(f.videoOid)!.onBranch, true);
  assert.equal(lfs.get(f.videoOid)!.addedAt, '2026-01-10T12:00:00.000Z');
  assert.equal(lfs.get(f.oldOid)!.path, 'assets/old.mov');
  assert.equal(lfs.get(f.oldOid)!.onBranch, false);
  assert.equal(lfs.get(f.orphanOid)!.path, null);
  assert.equal(lfs.get(f.orphanOid)!.onBranch, false);

  const history = new Map(result.historyFiles.map((file) => [file.path, file]));
  assert.equal(result.historyFiles[0].path, 'big.bin');
  assert.deepEqual(
    { ...history.get('big.bin'), bytes: 0 },
    {
      path: 'big.bin',
      bytes: 0,
      versions: 1,
      lastChangedAt: '2026-03-05T12:00:00.000Z',
      deleted: true,
    },
  );
  assert.equal(history.get('keep.txt')!.versions, 2);
  assert.equal(history.get('keep.txt')!.deleted, false);
  assert.equal(history.get('feature.txt')!.deleted, true, 'not on the default branch');
  assert.equal(history.get('assets/old.mov')!.deleted, true);
  assert.equal(history.has('task.bin'), false, 'work refs are not history');
  assert.equal(
    result.historyFiles.reduce((sum, file) => sum + file.bytes, 0) <= result.history.bytes,
    true,
  );
});

test('an empty repository measures without failing', async () => {
  const repository = join(data, 'empty.git');
  execFileSync('git', ['init', '-q', '--bare', repository]);
  const result = await storage.measureRepositoryStorage(repository);
  assert.equal(result.largeFiles.count, 0);
  assert.equal(result.history.commits, 0);
  assert.equal(result.history.files, 0);
  assert.deepEqual(result.historyFiles, []);
  assert.equal(result.other.bytes, result.total);
});

test('the API serves the measurement, measures in the background and is the owner’s alone', async () => {
  const f = fixture('owner', 'Served');
  const base = `${origin}/api/projects/${f.project.id}/storage`;
  const first: any = await (await fetch(base)).json();
  assert.equal(first.available, true);
  assert.equal(first.measuredAt, null);
  assert.equal(first.measuring, true);
  assert.equal((await fetch(base + '/files?kind=lfs')).status, 409);
  await storage.storageMeasurement('owner', f.project.id);
  const summary: any = await (await fetch(base)).json();
  assert.equal(summary.measuring, false);
  assert.ok(summary.measuredAt);
  assert.equal(summary.largeFiles.count, 3);
  assert.equal(summary.work.tasks, 2);
  assert.equal(summary.work.reviews, 1);
  assert.equal(summary.lfs, undefined, 'lists stay out of the summary');

  const lfs: any = await (await fetch(base + '/files?kind=lfs')).json();
  assert.equal(lfs.count, 3);
  assert.equal(lfs.files.length, 3);
  assert.equal(lfs.matches, 3);
  assert.equal(lfs.page, 1);
  assert.equal(lfs.pageSize, 50);
  assert.equal(lfs.truncated, undefined);
  assert.deepEqual(
    lfs.files.map((file: any) => file.oid),
    [f.videoOid, f.oldOid, f.orphanOid],
    'largest first by default',
  );
  const history: any = await (await fetch(base + '/files?kind=history')).json();
  assert.equal(history.count, 5);
  assert.equal(history.commits, summary.history.commits);
  assert.equal(history.bytes, summary.history.bytes);
  assert.equal((await fetch(base + '/files?kind=other')).status, 400);

  assert.equal((await fetch(base, { headers: { 'x-worker': '1' } })).status, 403);
  assert.equal(
    (await fetch(base + '/files?kind=lfs', { headers: { 'x-worker': '1' } })).status,
    403,
  );
  assert.equal((await fetch(base, { headers: { 'x-owner': 'other' } })).status, 404);
  assert.equal(
    (await fetch(base + '/files?kind=lfs', { headers: { 'x-owner': 'other' } })).status,
    404,
  );
});

test('a project without a ready repository has no storage to show', async () => {
  save('project', 'owner', { id: 'preparing', name: 'Preparing', repositoryStatus: 'preparing' });
  const summary: any = await (await fetch(`${origin}/api/projects/preparing/storage`)).json();
  assert.deepEqual(summary, { available: false });
  assert.equal(
    (await fetch(`${origin}/api/projects/preparing/storage/files?kind=lfs`)).status,
    404,
  );
});

test('a measurement is redone when refs move or it grows old, never twice at once', async (t) => {
  const settings = { ...storage.storageSettings };
  t.after(() => Object.assign(storage.storageSettings, settings));
  const f = fixture('owner', 'Stale');
  await storage.repositoryStorage('owner', f.project.id);
  // One measurement per repository: asking again joins the one in progress.
  const running = storage.storageMeasurement('owner', f.project.id);
  assert.ok(running);
  await storage.repositoryStorage('owner', f.project.id);
  assert.equal(storage.storageMeasurement('owner', f.project.id), running);
  await running;
  const measured = (await storage.repositoryStorage('owner', f.project.id)) as any;
  assert.equal(measured.measuring, false, 'fresh and unchanged: served from the cache');

  // A push moves a ref, but not sooner than the minimum interval.
  git(f.work, 'checkout', '-q', 'main');
  writeFileSync(join(f.work, 'later.txt'), 'later\n');
  git(f.work, 'add', '.');
  commitAt(f.work, '2026-06-01T12:00:00Z', 'Later');
  git(f.work, 'push', '-q', 'origin', 'main');
  assert.equal(((await storage.repositoryStorage('owner', f.project.id)) as any).measuring, false);
  storage.storageSettings.minimumIntervalMs = 0;
  const moved = (await storage.repositoryStorage('owner', f.project.id)) as any;
  assert.equal(moved.measuring, true);
  assert.equal(moved.measuredAt, measured.measuredAt, 'the previous answer is served meanwhile');
  await storage.storageMeasurement('owner', f.project.id);
  const remeasured = (await storage.repositoryStorage('owner', f.project.id)) as any;
  assert.equal(remeasured.measuring, false);
  assert.equal(remeasured.history.commits, measured.history.commits + 1);

  // Unchanged refs, but older than the stale period.
  storage.storageSettings.staleAfterMs = 0;
  assert.equal(((await storage.repositoryStorage('owner', f.project.id)) as any).measuring, true);
  await storage.storageMeasurement('owner', f.project.id);
});

test('at most a few repositories are measured at once across the server', async (t) => {
  const settings = { ...storage.storageSettings };
  t.after(() => Object.assign(storage.storageSettings, settings));
  storage.storageSettings.concurrency = 1;
  const one = fixture('owner', 'First'),
    two = fixture('owner', 'Second');
  await storage.repositoryStorage('owner', one.project.id);
  await storage.repositoryStorage('owner', two.project.id);
  assert.deepEqual(storage.storageActivity(), { active: 1, queued: 1 });
  await Promise.all([
    storage.storageMeasurement('owner', one.project.id),
    storage.storageMeasurement('owner', two.project.id),
  ]);
  assert.deepEqual(storage.storageActivity(), { active: 0, queued: 0 });
});

test('a failed measurement is reported and retried later', async (t) => {
  const settings = { ...storage.storageSettings };
  t.after(() => Object.assign(storage.storageSettings, settings));
  const f = fixture('owner', 'Broken');
  rmSync(join(f.repository, 'HEAD'));
  await storage.repositoryStorage('owner', f.project.id);
  await storage.storageMeasurement('owner', f.project.id);
  const failed = (await storage.repositoryStorage('owner', f.project.id)) as any;
  assert.equal(failed.measuredAt, null);
  assert.equal(failed.measuring, false);
  assert.match(failed.error, /Git command failed/);
  writeFileSync(join(f.repository, 'HEAD'), 'ref: refs/heads/main\n');
  storage.storageSettings.minimumIntervalMs = 0;
  assert.equal(((await storage.repositoryStorage('owner', f.project.id)) as any).measuring, true);
  await storage.storageMeasurement('owner', f.project.id);
  const recovered = (await storage.repositoryStorage('owner', f.project.id)) as any;
  assert.ok(recovered.measuredAt);
  assert.equal(recovered.error, undefined);
});

test('pointer detection reads only Git LFS pointers', () => {
  const oid = 'b'.repeat(64);
  assert.equal(storage.pointerOid(pointer(oid, 12)), oid);
  assert.equal(storage.pointerOid(`hello\noid sha256:${oid}\n`), null);
});

/** A hosted repository with more than a thousand files in history and in Git LFS. */
function manyFiles(name: string) {
  const project = createProject('owner', { name });
  const repository = project.repositoryPath;
  const work = join(data, `work-${project.id}`);
  execFileSync('git', ['clone', '-q', repository, work]);
  mkdirSync(join(work, 'media'));
  mkdirSync(join(work, 'src'));
  const objects: { oid: string; bytes: number; path: string | null }[] = [];
  // 1,005 LFS files with a pointer, sizes repeating so ties fall back to names.
  for (let i = 0; i < 1005; i++) {
    const bytes = randomBytes(100 + (i % 13) * 10);
    const oid = lfsObject(repository, bytes);
    const path = `media/Clip-${String(i).padStart(4, '0')}.bin`;
    writeFileSync(join(work, path), pointer(oid, bytes.length));
    objects.push({ oid, bytes: bytes.length, path });
  }
  // One object no pointer names: it is listed by the start of its id.
  const orphan = randomBytes(5);
  objects.push({ oid: lfsObject(repository, orphan), bytes: orphan.length, path: null });
  for (let i = 0; i < 30; i++)
    writeFileSync(join(work, `src/module-${i}.ts`), 'x'.repeat(2000 + i * 500));
  writeFileSync(join(work, 'tiny.txt'), 't');
  git(work, 'add', '.');
  commitAt(work, '2026-01-10T12:00:00Z', 'Add files');
  for (let i = 0; i < 10; i++) writeFileSync(join(work, `src/module-${i}.ts`), 'y'.repeat(100 + i));
  git(work, 'add', '.');
  commitAt(work, '2026-02-10T12:00:00Z', 'Change modules');
  git(work, 'push', '-q', 'origin', 'main');
  return { project, repository, work, objects };
}

test('the file lists hold every file and page, sort and search on the server', async () => {
  const f = manyFiles('Many');
  const base = `${origin}/api/projects/${f.project.id}/storage`;
  await storage.repositoryStorage('owner', f.project.id);
  await storage.storageMeasurement('owner', f.project.id);
  const summary: any = await (await fetch(base)).json();
  assert.equal(summary.largeFiles.count, 1006);
  assert.equal(summary.history.files, 1036);
  // The summary record stays small: the lists are records of their own.
  const record = db
    .prepare("SELECT data FROM records WHERE kind='repository-storage' AND id=?")
    .get(f.project.id) as { data: string };
  assert.equal(JSON.parse(record.data).lfs, undefined);
  assert.equal(JSON.parse(record.data).historyFiles, undefined);
  assert.ok(record.data.length < 2000, `summary record is ${record.data.length} bytes`);

  const files = async (query: string) => {
    const response = await fetch(`${base}/files?${query}`);
    return { status: response.status, body: (await response.json()) as any };
  };
  const every = async (kind: string, sort: string, direction: string) => {
    const all: any[] = [];
    for (let page = 1; ; page++) {
      const { body } = await files(`kind=${kind}&sort=${sort}&direction=${direction}&page=${page}`);
      assert.equal(body.page, page);
      assert.equal(body.pageSize, 50);
      all.push(...body.files);
      if (page * 50 >= body.matches) {
        assert.equal(body.files.length, body.matches - (page - 1) * 50);
        break;
      }
      assert.equal(body.files.length, 50);
    }
    return all;
  };
  // The order the dialog always had: the column, ties by name; file ascending reads A to Z.
  const name = (file: any) => file.path ?? file.oid.slice(0, 12);
  const reference = (list: any[], value: (file: any) => number | string, direction: string) =>
    [...list].sort((a, b) => {
      const x = value(a),
        y = value(b);
      const order = x < y ? -1 : x > y ? 1 : 0;
      return order * (direction === 'ascending' ? 1 : -1) || name(a).localeCompare(name(b));
    });
  const time = (value: string | null) => (value ? Date.parse(value) : 0);

  const lfsBySize = await every('lfs', 'size', 'descending');
  assert.equal(lfsBySize.length, 1006, 'every large file, past the old 1,000');
  const lfsKeys: Record<string, (file: any) => number | string> = {
    file: (file) => name(file).toLowerCase(),
    added: (file) => time(file.addedAt),
    size: (file) => file.bytes,
  };
  for (const [key, value] of Object.entries(lfsKeys))
    for (const direction of ['ascending', 'descending']) {
      const listed = await every('lfs', key, direction);
      assert.deepEqual(
        listed.map(name),
        reference(lfsBySize, value, direction).map(name),
        `lfs ${key} ${direction}`,
      );
    }
  const orphan = f.objects.at(-1)!.oid;
  assert.ok(lfsBySize.some((file) => file.oid === orphan && file.path === null));

  const historyBySize = await every('history', 'size', 'descending');
  assert.equal(historyBySize.length, 1036, 'every path in history, past the old 1,000');
  const historyKeys: Record<string, (file: any) => number | string> = {
    file: (file) => file.path.toLowerCase(),
    versions: (file) => file.versions,
    changed: (file) => time(file.lastChangedAt),
    size: (file) => file.bytes,
  };
  for (const [key, value] of Object.entries(historyKeys))
    for (const direction of ['ascending', 'descending']) {
      const listed = await every('history', key, direction);
      assert.deepEqual(
        listed.map(name),
        reference(historyBySize, value, direction).map(name),
        `history ${key} ${direction}`,
      );
    }
  // Last changed is known for every path, the smallest too, which the old top 1,000 left out.
  assert.equal(historyBySize.at(-1)!.path, 'tiny.txt');
  assert.equal(historyBySize.at(-1)!.lastChangedAt, '2026-01-10T12:00:00.000Z');
  assert.ok(historyBySize.every((file) => file.lastChangedAt));
  const changed = historyBySize.find((file) => file.path === 'src/module-3.ts');
  assert.equal(changed.versions, 2);
  assert.equal(changed.lastChangedAt, '2026-02-10T12:00:00.000Z');

  // Defaults: size, largest first, page 1. File alone reads A to Z.
  const first = (await files('kind=history')).body;
  assert.deepEqual(first.files, historyBySize.slice(0, 50));
  assert.equal(first.sort, 'size');
  assert.equal(first.direction, 'descending');
  assert.equal(first.matches, 1036);
  assert.equal(first.count, 1036);
  assert.equal(first.commits, summary.history.commits);
  assert.equal(first.bytes, summary.history.bytes);
  assert.equal(first.measuredAt, summary.measuredAt);
  assert.equal((await files('kind=lfs&sort=file')).body.direction, 'ascending');

  // Paging: the last page holds what is left; past it, the last page again.
  const last = (await files('kind=lfs&page=21')).body;
  assert.equal(last.page, 21);
  assert.equal(last.files.length, 6);
  const beyond = (await files('kind=lfs&page=99')).body;
  assert.equal(beyond.page, 21);
  assert.deepEqual(beyond.files, last.files);

  // Search: case-insensitive, on the shown name, with the matches' count and bytes.
  const search = (await files('kind=lfs&query=%20CLIP-00%20')).body;
  const expected = lfsBySize.filter((file) => /clip-00/i.test(name(file)));
  assert.equal(search.query, 'CLIP-00');
  assert.equal(search.matches, 100);
  assert.equal(search.count, 1006, 'the total stays the whole list');
  assert.equal(
    search.matchedBytes,
    expected.reduce((sum, file) => sum + file.bytes, 0),
  );
  assert.deepEqual(search.files, expected.slice(0, 50));
  const page2 = (await files('kind=lfs&query=clip-00&page=2')).body;
  assert.deepEqual(page2.files, expected.slice(50, 100));
  const byId = (await files(`kind=lfs&query=${orphan.slice(0, 12).toUpperCase()}`)).body;
  assert.deepEqual(
    byId.files.map((file: any) => file.oid),
    [orphan],
    'an unnamed object is found by the start of its id',
  );
  const none = (await files('kind=history&query=nothing-like-this&page=3')).body;
  assert.deepEqual(
    [none.matches, none.matchedBytes, none.files.length, none.page, none.count],
    [0, 0, 0, 1, 1036],
  );

  // What a request cannot ask for.
  for (const query of [
    'kind=lfs&sort=versions',
    'kind=lfs&sort=changed',
    'kind=history&sort=added',
    'kind=history&sort=name',
    'kind=lfs&direction=up',
    'kind=lfs&page=0',
    'kind=lfs&page=two',
    'kind=other',
  ])
    assert.equal((await files(query)).status, 400, query);
});

test('a measurement from before every file was kept still lists its files and is redone', async (t) => {
  const settings = { ...storage.storageSettings };
  t.after(() => Object.assign(storage.storageSettings, settings));
  const f = fixture('owner', 'Older');
  const base = `${origin}/api/projects/${f.project.id}/storage`;
  // The record the previous version saved: its largest files inline, nothing kept apart.
  const measuredAt = new Date().toISOString();
  save('repository-storage', 'owner', {
    id: f.project.id,
    projectId: f.project.id,
    measuredAt,
    attemptedAt: measuredAt,
    fingerprint: 'old',
    total: 1000,
    largeFiles: { bytes: 900, count: 1500 },
    history: { bytes: 100, commits: 3, files: 1200 },
    work: { bytes: 0, tasks: 0, reviews: 0 },
    other: { bytes: 0 },
    lfs: [
      { oid: 'a'.repeat(64), path: 'small.bin', bytes: 300, addedAt: null, onBranch: true },
      { oid: 'b'.repeat(64), path: 'large.bin', bytes: 600, addedAt: null, onBranch: false },
    ],
    historyFiles: [
      { path: 'readme.md', bytes: 100, versions: 3, lastChangedAt: null, deleted: false },
    ],
    durationMs: 1,
  });
  // Within the minimum interval: the old list is served as it is.
  const old: any = await (await fetch(base + '/files?kind=lfs')).json();
  assert.equal(old.count, 1500);
  assert.equal(old.matches, 2);
  assert.deepEqual(
    old.files.map((file: any) => file.path),
    ['large.bin', 'small.bin'],
  );
  const history: any = await (await fetch(base + '/files?kind=history&sort=file')).json();
  assert.deepEqual(
    history.files.map((file: any) => file.path),
    ['readme.md'],
  );
  assert.equal(storage.storageMeasurement('owner', f.project.id), undefined);

  // Afterwards it is measured again, and the new lists hold every file.
  storage.storageSettings.minimumIntervalMs = 0;
  const summary: any = await (await fetch(base)).json();
  assert.equal(summary.measuring, true);
  assert.equal(summary.measuredAt, measuredAt, 'the old answer is served meanwhile');
  await storage.storageMeasurement('owner', f.project.id);
  const lfs: any = await (await fetch(base + '/files?kind=lfs')).json();
  assert.notEqual(lfs.measuredAt, measuredAt);
  assert.equal(lfs.count, 3);
  assert.equal(lfs.matches, 3);
  assert.deepEqual(
    lfs.files.map((file: any) => file.oid),
    [f.videoOid, f.oldOid, f.orphanOid],
  );
});
