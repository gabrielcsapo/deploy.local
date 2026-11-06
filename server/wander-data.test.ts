import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  chmodSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  snapshotWander,
  verifyWanderSnapshot,
  seedWanderResource,
  verifyWanderSeed,
  wanderInventory,
  assertWanderData,
} from './wander-data.mjs';
function fixture(run: (root: string, db: DatabaseSync) => void) {
  const root = mkdtempSync(join(tmpdir(), 'wander-data-'));
  mkdirSync(join(root, 'source', 'data'), { recursive: true });
  mkdirSync(join(root, 'source', 'uploads'));
  mkdirSync(join(root, 'source', 'data', 'media'));
  mkdirSync(join(root, 'source', 'data', 'mappings'));
  const db = new DatabaseSync(join(root, 'source', 'data', 'wander.db'));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE trips(id INTEGER PRIMARY KEY, label TEXT, asset BLOB); INSERT INTO trips VALUES(1,'synthetic trip',x'010203')",
  );
  writeFileSync(join(root, 'source', 'data', 'media', 'image.bin'), Buffer.from([0, 255, 3]));
  writeFileSync(join(root, 'source', 'data', 'mappings', 'map.json'), '{}');
  writeFileSync(join(root, 'source', 'uploads', 'legacy.txt'), 'original upload');
  chmodSync(join(root, 'source', 'uploads', 'legacy.txt'), 0o640);
  try {
    run(root, db);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}
test('cold full backup and independent restore preserve SQLite WAL, media/maps, uploads and ownership', () =>
  fixture((root, db) => {
    assert.ok(statSync(join(root, 'source', 'data', 'wander.db-wal')).size > 0);
    const original = wanderInventory(join(root, 'source'));
    const s = snapshotWander(join(root, 'source'), join(root, 'backups'));
    verifyWanderSnapshot(s);
    assert.equal(wanderInventory(join(root, 'source')), original);
    const seeded = join(root, 'seeded');
    for (const n of ['data', 'uploads']) {
      mkdirSync(join(seeded, n), { recursive: true });
      seedWanderResource(s, n, join(seeded, n));
    }
    assert.equal(wanderInventory(seeded), original);
    assert.equal(readFileSync(join(seeded, 'uploads', 'legacy.txt'), 'utf8'), 'original upload');
    assert.equal(statSync(join(seeded, 'uploads', 'legacy.txt')).mode & 0o777, 0o640);
    const archives: Record<string, string> = {};
    for (const n of ['data', 'uploads']) {
      archives[n] = join(root, n + '.tar.gz');
      execFileSync('tar', ['--numeric-owner', '-czpf', archives[n], '-C', join(seeded, n), '.']);
    }
    verifyWanderSeed(s, archives);
    const restored = new DatabaseSync(join(seeded, 'data', 'wander.db'));
    assert.equal(restored.prepare('SELECT label FROM trips').get()!.label, 'synthetic trip');
    restored.close();
    assert.equal(db.prepare('SELECT count(*) AS n FROM trips').get()!.n, 1);
  }));
test('completed seed interrupted before receipt reuses verified bytes; partial seed requires explicit prestart recovery', () =>
  fixture((root) => {
    const s = snapshotWander(join(root, 'source'), join(root, 'backups'));
    const volume = join(root, 'volume');
    mkdirSync(volume);
    seedWanderResource(s, 'data', volume);
    seedWanderResource(s, 'data', volume);
    writeFileSync(join(volume, 'uncommitted-partial'), 'partial');
    assert.throws(() => seedWanderResource(s, 'data', volume), /explicit prestart/);
    seedWanderResource(s, 'data', volume, true);
    assert.throws(() => readFileSync(join(volume, 'uncommitted-partial')), /ENOENT/);
  }));
test('missing and empty original database cannot produce an empty-volume migration', () =>
  fixture((root) => {
    const source = join(root, 'source');
    rmSync(join(source, 'data', 'wander.db'));
    assert.throws(() => snapshotWander(source, join(root, 'backup')), /Missing or empty/);
    writeFileSync(join(source, 'data', 'wander.db'), '');
    assert.throws(() => assertWanderData(source), /Missing or empty/);
    rmSync(join(source, 'uploads'), { recursive: true });
    assert.throws(() => assertWanderData(source), /Missing existing/);
  }));
test('escaping symlink and symbolic data root fail closed', () =>
  fixture((root) => {
    symlinkSync('/etc/passwd', join(root, 'source', 'uploads', 'escape'));
    assert.throws(() => snapshotWander(join(root, 'source'), join(root, 'backup')), /Escaping/);
    rmSync(join(root, 'source', 'uploads', 'escape'));
    rmSync(join(root, 'source', 'uploads'), { recursive: true });
    symlinkSync('/tmp', join(root, 'source', 'uploads'));
    assert.throws(() => assertWanderData(join(root, 'source')), /Missing existing/);
  }));
test('corrupt archive, ownership or upload bytes fail restore/seed proof', () =>
  fixture((root) => {
    const s = snapshotWander(join(root, 'source'), join(root, 'backups'));
    writeFileSync(join(s.directory, 'uploads.tar.gz'), 'corrupt');
    assert.throws(() => verifyWanderSnapshot(s), /resource archive mismatch/);
  }));
test('invalid SQLite database cannot pass integrity rehearsal', () =>
  fixture((root) => {
    const p = join(root, 'source', 'data', 'wander.db');
    writeFileSync(p, 'not sqlite');
    rmSync(p + '-wal');
    rmSync(p + '-shm');
    assert.throws(() => snapshotWander(join(root, 'source'), join(root, 'backup')));
  }));
