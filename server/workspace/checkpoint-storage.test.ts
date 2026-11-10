import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { restoreSnapshot, validateSnapshot } from './checkpoint.ts';
import {
  checkpointBlobPath,
  externalizeCheckpoint,
  materializeCheckpoint,
  migrateCheckpointSnapshots,
  verifyCheckpointBlobs,
} from './checkpoint-storage.ts';

const data = mkdtempSync(join(tmpdir(), 'checkpoint-storage-'));
process.env.DEPLOY_DATA_DIR = data;
const { db, root, get, save, listCheckpointMetadata } = await import('./store.ts');
test.after(() => {
  db.close();
  rmSync(data, { recursive: true, force: true });
});
const source = join(data, 'source');
mkdirSync(source);
const binary = Buffer.from([0, 255, 1, 128, 13, 10]);
writeFileSync(join(source, 'asset.bin'), binary);
writeFileSync(join(source, 'run.sh'), '#!/bin/sh\necho preserved\n', { mode: 0o755 });
const files = [
  {
    path: 'asset.bin',
    content: readFileSync(join(source, 'asset.bin')).toString('base64'),
    executable: false,
  },
  {
    path: 'run.sh',
    content: readFileSync(join(source, 'run.sh')).toString('base64'),
    executable: true,
  },
];
const snapshot = validateSnapshot({
  files,
  excluded: [],
  digest: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
});
const raw = (id: string) =>
  JSON.parse(
    (
      db
        .prepare("SELECT data FROM records WHERE kind='checkpoint' AND id=? AND owner='owner'")
        .get(id) as { data: string }
    ).data,
  );

test('new writes deduplicate immutable bodies and restore binary bytes and executable modes', () => {
  const row = { id: 'new', taskId: 'task', snapshot, title: 'Title' };
  save('checkpoint', 'owner', row);
  save('checkpoint', 'owner', { ...row, id: 'duplicate' });
  const stored = raw('new');
  assert.equal(stored.snapshot, undefined);
  assert.deepEqual(stored.snapshotBlob, raw('duplicate').snapshotBlob);
  assert.equal(stored.snapshotBlob.byteSize, Buffer.byteLength(JSON.stringify(snapshot)));
  assert.equal(statSync(checkpointBlobPath(root, stored.snapshotBlob)).mode & 0o777, 0o400);
  assert.deepEqual(get('checkpoint', 'owner', row.id).snapshot, snapshot);
  const restored = join(data, 'restored');
  restoreSnapshot(get('checkpoint', 'owner', row.id).snapshot, restored);
  assert.deepEqual(readFileSync(join(restored, 'asset.bin')), binary);
  assert.equal(statSync(join(restored, 'run.sh')).mode & 0o100, 0o100);
  const excluded = { ...snapshot, excluded: ['omitted.txt'] };
  save('checkpoint', 'owner', { ...row, id: 'excluded', snapshot: excluded });
  assert.notEqual(raw('excluded').snapshotBlob.digest, stored.snapshotBlob.digest);
  assert.equal(raw('excluded').snapshotInfo.digest, stored.snapshotInfo.digest);
  assert.throws(() => get('checkpoint', 'other', row.id), /Not found/);
  assert.equal(listCheckpointMetadata('owner', 'task')[0].snapshot, undefined);
});

test('old-only database migrates in bounded yielding passes and remains restorable on reopen', async () => {
  const directory = join(data, 'old-only');
  mkdirSync(directory);
  const path = join(directory, 'workspace.db');
  let database = new Database(path);
  database.exec(
    'CREATE TABLE records(kind TEXT,id TEXT,owner TEXT,data TEXT,PRIMARY KEY(kind,id,owner))',
  );
  const insert = database.prepare("INSERT INTO records VALUES('checkpoint',?,'owner',?)");
  for (let i = 0; i < 5; i++) insert.run(String(i), JSON.stringify({ id: String(i), snapshot }));
  let yielded = false;
  setImmediate(() => {
    yielded = true;
  });
  assert.equal(await migrateCheckpointSnapshots(database, directory, { maxRows: 2 }), 2);
  assert.equal(yielded, true);
  const inlineCount = () =>
    (
      database
        .prepare("SELECT count(*) AS n FROM records WHERE json_type(data,'$.snapshot')='object'")
        .get() as { n: number }
    ).n;
  assert.equal(inlineCount(), 3);
  assert.equal(await migrateCheckpointSnapshots(database, directory, { maxBytes: 1 }), 1);
  assert.equal(inlineCount(), 2);
  database.close();
  database = new Database(path);
  for (const { data: json } of database.prepare('SELECT data FROM records').all() as {
    data: string;
  }[]) {
    const row = materializeCheckpoint(directory, JSON.parse(json));
    assert.deepEqual(validateSnapshot(row.snapshot), snapshot);
    const target = join(directory, 'restored-' + row.id);
    restoreSnapshot(row.snapshot, target);
    assert.deepEqual(readFileSync(join(target, 'asset.bin')), binary);
  }
  assert.equal(await migrateCheckpointSnapshots(database, directory), 2);
  assert.equal(await migrateCheckpointSnapshots(database, directory), 0);
  verifyCheckpointBlobs(database, directory);
  database.close();
});

test('failed blob write or row transaction never replaces the old inline snapshot', async () => {
  const row = { id: 'failure', snapshot };
  db.prepare("INSERT INTO records VALUES('checkpoint',?,'owner',?)").run(
    row.id,
    JSON.stringify(row),
  );
  const blocked = join(data, 'blocked');
  mkdirSync(blocked);
  writeFileSync(join(blocked, 'blobs'), 'not a directory');
  await assert.rejects(migrateCheckpointSnapshots(db, blocked), /ENOTDIR/);
  assert.deepEqual(raw(row.id), row);
  assert.throws(
    () =>
      db.transaction(() => {
        save('checkpoint', 'owner', row);
        throw new Error('rollback');
      })(),
    /rollback/,
  );
  assert.deepEqual(raw(row.id), row);
  assert.deepEqual(get('checkpoint', 'owner', row.id).snapshot, snapshot);
});

test('missing/corrupt blobs fail closed; metadata never requires a body', () => {
  const row = {
    id: 'corrupt',
    taskId: 'corrupt-task',
    snapshot: { ...snapshot, excluded: ['unique'] },
  };
  save('checkpoint', 'owner', row);
  const stored = raw(row.id);
  const file = checkpointBlobPath(root, stored.snapshotBlob);
  chmodSync(file, 0o600);
  writeFileSync(file, 'corrupt');
  assert.throws(() => get('checkpoint', 'owner', row.id), /integrity verification/);
  assert.throws(() => externalizeCheckpoint(root, row), /integrity verification/);
  assert.equal(listCheckpointMetadata('owner', row.taskId).length, 1);
  rmSync(file);
  assert.throws(() => get('checkpoint', 'owner', row.id), /ENOENT/);
  assert.throws(() => checkpointBlobPath(root, { digest: '../escape', byteSize: 1 }), /Invalid/);
});

test('store opens an existing database containing only inline checkpoints', () => {
  const legacyRoot = join(data, 'legacy-startup');
  mkdirSync(join(legacyRoot, 'workspace'), { recursive: true });
  const database = new Database(join(legacyRoot, 'workspace', 'workspace.db'));
  database.exec(
    'CREATE TABLE records(kind TEXT,id TEXT,owner TEXT,data TEXT,PRIMARY KEY(kind,id,owner))',
  );
  database
    .prepare("INSERT INTO records VALUES('checkpoint','legacy','owner',?)")
    .run(JSON.stringify({ id: 'legacy', taskId: 'task', snapshot }));
  database.close();
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const {db, get, listCheckpointMetadata} = await import(${JSON.stringify(new URL('./store.ts', import.meta.url).href)});
    const result = { snapshot: get('checkpoint', 'owner', 'legacy').snapshot, metadata: listCheckpointMetadata('owner', 'task') };
    console.log(JSON.stringify(result));
    db.close();
  `,
    ],
    { encoding: 'utf8', env: { ...process.env, DEPLOY_DATA_DIR: legacyRoot } },
  );
  const result = JSON.parse(output);
  assert.deepEqual(result.snapshot, snapshot);
  assert.equal(result.metadata.length, 1);
  assert.equal(result.metadata[0].snapshot, undefined);
  assert.equal(result.metadata[0].snapshotInfo.digest, snapshot.digest);
});

test('due scheduled maintenance migrates legacy rows; startup leaves them inline', async (t) => {
  const control = await import('../store.ts');
  const { runDueMaintenance } = await import('../maintenance.ts');
  t.after(() => control._resetDb());
  const row = { id: 'scheduled-legacy', snapshot };
  db.prepare("INSERT INTO records VALUES('checkpoint',?,'owner',?)").run(
    row.id,
    JSON.stringify(row),
  );
  control.getSqlite();
  assert.deepEqual(raw(row.id).snapshot, snapshot);
  assert.equal(await runDueMaintenance(), true);
  // Each bounded migration pass handles at most eight records and yields after each one.
  for (let i = 0; i < 9; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(raw(row.id).snapshot, undefined);
  assert.ok(raw(row.id).snapshotBlob);
  assert.deepEqual(get('checkpoint', 'owner', row.id).snapshot, snapshot);
});
