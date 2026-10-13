// Private cold-copy primitives for the fixed Wander data/uploads boundary.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
  fsyncSync,
  rmSync,
} from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const roots = ['data', 'uploads'];
export function fileDigest(path) {
  const h = createHash('sha256'),
    b = Buffer.alloc(1024 * 1024),
    fd = openSync(path, 'r');
  try {
    let n;
    while ((n = readSync(fd, b, 0, b.length, null)) > 0) h.update(b.subarray(0, n));
    return h.digest('hex');
  } finally {
    closeSync(fd);
  }
}
export function assertWanderData(root) {
  for (const name of roots) {
    const p = join(root, name);
    if (!existsSync(p) || !lstatSync(p).isDirectory() || lstatSync(p).isSymbolicLink())
      throw Error('Missing existing Wander ' + name);
  }
  const db = join(root, 'data', 'wander.db');
  if (
    !existsSync(db) ||
    !lstatSync(db).isFile() ||
    lstatSync(db).isSymbolicLink() ||
    !lstatSync(db).size
  )
    throw Error('Missing or empty Wander database');
}
export function wanderInventory(root) {
  const h = createHash('sha256');
  function visit(entry) {
    const p = join(root, entry),
      s = lstatSync(p);
    if (!s.isFile() && !s.isDirectory() && !s.isSymbolicLink())
      throw Error('Unsupported Wander data entry');
    h.update(
      JSON.stringify([
        entry,
        s.isDirectory() ? 'directory' : s.isSymbolicLink() ? 'link' : 'file',
        s.uid,
        s.gid,
        s.mode & 0o7777,
      ]),
    );
    if (s.isFile()) h.update(fileDigest(p));
    else if (s.isDirectory()) for (const n of readdirSync(p).sort()) visit(join(entry, n));
    else {
      const target = readlinkSync(p),
        dest = relative(root, resolve(p, '..', target));
      let named = false;
      const traverses = target.split('/').some((c) => {
        if (c === '..') return named;
        if (c && c !== '.') named = true;
        return false;
      });
      if (
        isAbsolute(target) ||
        traverses ||
        !roots.some((r) => dest === r || dest.startsWith(r + sep))
      )
        throw Error('Escaping Wander data symlink');
      h.update(target);
    }
  }
  for (const name of roots) visit(name);
  return h.digest('hex');
}
export function wanderDatabase(root) {
  assertWanderData(root);
  const db = new DatabaseSync(join(root, 'data', 'wander.db'), { readOnly: true });
  try {
    db.exec('PRAGMA trusted_schema=OFF');
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok')
      throw Error('Wander SQLite integrity failure');
    const h = createHash('sha256');
    for (const table of db
      .prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()) {
      h.update(JSON.stringify(table));
      const quoted = '"' + table.name.replaceAll('"', '""') + '"';
      const columns = db
        .prepare('PRAGMA table_info(' + quoted + ')')
        .all()
        .map((c) => '"' + c.name.replaceAll('"', '""') + '"');
      const stmt = db.prepare(
        'SELECT * FROM ' + quoted + (columns.length ? ' ORDER BY ' + columns.join(',') : ''),
      );
      stmt.setReadBigInts(true);
      for (const row of stmt.iterate())
        h.update(JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v)));
    }
    return h.digest('hex');
  } finally {
    db.close();
  }
}
function sync(path) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function verifyWanderSnapshot(snapshot) {
  if (fileDigest(join(snapshot.directory, 'full.tar')) !== snapshot.archiveDigest)
    throw Error('Wander archive digest mismatch');
  for (const name of roots)
    if (fileDigest(join(snapshot.directory, name + '.tar.gz')) !== snapshot.resources[name])
      throw Error('Wander resource archive mismatch');
  const restored = mkdtempSync(join(snapshot.directory, 'verify-'));
  try {
    execFileSync(
      'tar',
      ['--numeric-owner', '-xpf', join(snapshot.directory, 'full.tar'), '-C', restored],
      { stdio: 'pipe' },
    );
    if (wanderInventory(restored) !== snapshot.inventoryDigest)
      throw Error('Wander restored inventory/ownership mismatch');
    if (wanderDatabase(restored) !== snapshot.databaseDigest)
      throw Error('Wander restored SQLite/WAL mismatch');
  } finally {
    rmSync(restored, { recursive: true, force: true });
  }
}
export function snapshotWander(root, destination) {
  assertWanderData(root);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(destination, 'cold-')),
    inventoryDigest = wanderInventory(root);
  execFileSync(
    'tar',
    ['--numeric-owner', '-cpf', join(directory, 'full.tar'), '-C', root, ...roots],
    { stdio: 'pipe' },
  );
  const restored = mkdtempSync(join(directory, 'database-check-'));
  let databaseDigest;
  try {
    execFileSync('tar', ['--numeric-owner', '-xpf', join(directory, 'full.tar'), '-C', restored], {
      stdio: 'pipe',
    });
    if (wanderInventory(restored) !== inventoryDigest)
      throw Error('Cold restore inventory mismatch');
    databaseDigest = wanderDatabase(restored);
  } finally {
    rmSync(restored, { recursive: true, force: true });
  }
  const resources = {};
  for (const name of roots) {
    execFileSync(
      'tar',
      ['--numeric-owner', '-czpf', join(directory, name + '.tar.gz'), '-C', join(root, name), '.'],
      { stdio: 'pipe' },
    );
    resources[name] = fileDigest(join(directory, name + '.tar.gz'));
  }
  const snapshot = {
    directory,
    archiveDigest: fileDigest(join(directory, 'full.tar')),
    inventoryDigest,
    databaseDigest,
    resources,
  };
  writeFileSync(join(directory, 'snapshot.json'), JSON.stringify(snapshot), {
    mode: 0o600,
    flag: 'wx',
  });
  verifyWanderSnapshot(snapshot);
  if (wanderInventory(root) !== inventoryDigest)
    throw Error('Stopped Wander data changed during backup');
  for (const name of ['full.tar', 'data.tar.gz', 'uploads.tar.gz', 'snapshot.json'])
    sync(join(directory, name));
  sync(directory);
  sync(destination);
  return snapshot;
}
export function verifyWanderSeed(snapshot, archives) {
  verifyWanderSnapshot(snapshot);
  const restored = mkdtempSync(join(snapshot.directory, 'seed-check-'));
  try {
    for (const name of roots) {
      mkdirSync(join(restored, name));
      execFileSync(
        'tar',
        ['--numeric-owner', '-xzpf', archives[name], '-C', join(restored, name)],
        { stdio: 'pipe' },
      );
    }
    if (wanderInventory(restored) !== snapshot.inventoryDigest)
      throw Error('Seeded Wander inventory/ownership mismatch');
    if (wanderDatabase(restored) !== snapshot.databaseDigest)
      throw Error('Seeded Wander SQLite/WAL mismatch');
  } finally {
    rmSync(restored, { recursive: true, force: true });
  }
}

// A seed receipt must not reach disk before the copied provider's data does.
export function syncWanderTree(root) {
  const s = lstatSync(root);
  if (s.isSymbolicLink()) return;
  if (s.isDirectory()) for (const n of readdirSync(root)) syncWanderTree(join(root, n));
  else if (!s.isFile()) throw Error('Unsupported seed entry');
  sync(root);
}
// Retry only a volume whose labels were verified by the controller, before a
// candidate can start. Compare completed copies; leave partial copies fenced.
export function seedWanderResource(snapshot, resource, destination, replaceIncomplete = false) {
  if (!roots.includes(resource)) throw Error('Unknown Wander resource');
  verifyWanderSnapshot(snapshot);
  const scratch = mkdtempSync(join(snapshot.directory, 'resource-check-'));
  try {
    execFileSync('tar', [
      '--numeric-owner',
      '-xzpf',
      join(snapshot.directory, resource + '.tar.gz'),
      '-C',
      scratch,
    ]);
    const expected = resourceInventory(scratch);
    if (readdirSync(destination).length) {
      if (resourceInventory(destination) !== expected) {
        if (!replaceIncomplete)
          throw Error('Incomplete managed seed requires explicit prestart recovery');
        for (const n of readdirSync(destination))
          rmSync(join(destination, n), { recursive: true, force: true });
        execFileSync('tar', [
          '--numeric-owner',
          '-xzpf',
          join(snapshot.directory, resource + '.tar.gz'),
          '-C',
          destination,
        ]);
        if (resourceInventory(destination) !== expected)
          throw Error('Recovered seed verification failed');
      }
    } else {
      execFileSync('tar', [
        '--numeric-owner',
        '-xzpf',
        join(snapshot.directory, resource + '.tar.gz'),
        '-C',
        destination,
      ]);
      if (resourceInventory(destination) !== expected)
        throw Error('Managed seed verification failed');
    }
    syncWanderTree(destination);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
function resourceInventory(root) {
  const h = createHash('sha256');
  function visit(p, n) {
    const s = lstatSync(p);
    h.update(
      JSON.stringify([
        n,
        s.uid,
        s.gid,
        s.mode & 0o7777,
        s.isDirectory() ? 'd' : s.isSymbolicLink() ? 'l' : 'f',
      ]),
    );
    if (s.isDirectory()) for (const c of readdirSync(p).sort()) visit(join(p, c), join(n, c));
    else if (s.isSymbolicLink()) h.update(readlinkSync(p));
    else if (s.isFile()) h.update(fileDigest(p));
    else throw Error('Unsupported seed entry');
  }
  visit(root, '.');
  return h.digest('hex');
}
