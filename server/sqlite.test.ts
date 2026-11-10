import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import Driver from 'better-sqlite3';
import { openDatabase } from './sqlite.ts';
import { openWorkspaceDatabase } from './workspace/database-open.ts';

function temporaryDirectory(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'sqlite-open-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('unspecified SQLite options preserve driver defaults and existing journal mode', (t) => {
  const root = temporaryDirectory(t);
  const direct = new Driver(join(root, 'direct.db'));
  const wrapped = openDatabase(join(root, 'wrapped.db'));
  t.after(() => {
    direct.close();
    wrapped.close();
  });
  for (const pragma of [
    'journal_mode',
    'busy_timeout',
    'foreign_keys',
    'synchronous',
    'auto_vacuum',
  ]) {
    assert.equal(wrapped.pragma(pragma, { simple: true }), direct.pragma(pragma, { simple: true }));
  }
  const walFile = join(root, 'wal.db');
  openDatabase(walFile, { wal: true }).close();
  const reopened = openDatabase(walFile);
  assert.equal(reopened.pragma('journal_mode', { simple: true }), 'wal');
  reopened.close();
});

test('SQLite options apply WAL, timeout and foreign keys only when requested', (t) => {
  const file = join(temporaryDirectory(t), 'configured.db');
  const db = openDatabase(file, { wal: true, busyTimeoutMs: 100, foreignKeys: true });
  t.after(() => db.close());
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('busy_timeout', { simple: true }), 100);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  db.exec('CREATE TABLE parent(id PRIMARY KEY); CREATE TABLE child(parent REFERENCES parent(id));');
  assert.throws(() => db.exec('INSERT INTO child VALUES (1)'), /FOREIGN KEY/);
  const unenforced = openDatabase(file, { foreignKeys: false, busyTimeoutMs: 0 });
  assert.equal(unenforced.pragma('busy_timeout', { simple: true }), 0);
  unenforced.exec('INSERT INTO child VALUES (1)');
  unenforced.close();
  const reader = openDatabase(file, { readonly: true, fileMustExist: true });
  assert.throws(() => reader.exec('INSERT INTO parent VALUES (1)'), /readonly/);
  reader.close();
  assert.throws(
    () => openDatabase(join(file, '..', 'missing.db'), { fileMustExist: true }),
    /unable to open/,
  );
});

test(
  'SQLite retries WAL promotion blocked by a real concurrent reader',
  { timeout: 10000 },
  async (t) => {
    const file = join(temporaryDirectory(t), 'contended.db');
    const initial = new Driver(file);
    initial.exec('CREATE TABLE records(id); INSERT INTO records VALUES (1)');
    initial.close();
    const worker = new Worker(
      `
    const { parentPort, workerData } = require('node:worker_threads');
    const Driver = require(workerData.driver);
    const db = new Driver(workerData.file);
    db.exec('BEGIN; SELECT * FROM records');
    parentPort.postMessage('locked');
    setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, 200);
  `,
      {
        eval: true,
        workerData: { file, driver: fileURLToPath(import.meta.resolve('better-sqlite3')) },
      },
    );
    t.after(() => worker.terminate());
    await once(worker, 'message');
    const db = openDatabase(file, { wal: true, busyTimeoutMs: 0 });
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal((db.prepare('SELECT count(*) AS n FROM records').get() as { n: number }).n, 1);
    db.close();
  },
);

test('workspace opens retain incremental vacuum when WAL is requested through the gate', (t) => {
  const db = openWorkspaceDatabase(join(temporaryDirectory(t), 'workspace.db'), {
    wal: true,
    busyTimeoutMs: 5000,
  });
  db.exec('CREATE TABLE records(id)');
  assert.equal(db.pragma('auto_vacuum', { simple: true }), 2);
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  db.close();
  const legacyFile = join(temporaryDirectory(t), 'legacy.db');
  const legacy = new Driver(legacyFile);
  legacy.exec('CREATE TABLE records(id); INSERT INTO records VALUES (1)');
  legacy.close();
  const reopened = openWorkspaceDatabase(legacyFile, { wal: true, busyTimeoutMs: 5000 });
  assert.equal(reopened.pragma('auto_vacuum', { simple: true }), 0);
  assert.equal(reopened.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal((reopened.prepare('SELECT count(*) AS n FROM records').get() as { n: number }).n, 1);
  reopened.close();
});

test('only server/sqlite.ts may import the SQLite driver outside tests', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const violations: string[] = [];
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
        continue;
      }
      if (
        !/\.(?:[cm]?js|tsx?)$/.test(file) ||
        /\.test\./.test(file) ||
        file === join(root, 'server/sqlite.ts') ||
        // The updater runs from the release being replaced and stays free of imports that a
        // half-switched release could break.
        file === join(root, 'scripts/self-update.mjs')
      )
        continue;
      const source = readFileSync(file, 'utf8');
      if (
        /\b(?:from\s*|import\s*\(\s*|require\s*\(\s*|createRequire\([^)]*\)\s*\(\s*)['"]better-sqlite3['"]/.test(
          source,
        )
      ) {
        violations.push(relative(root, file));
      }
    }
  }
  for (const directory of ['server', 'lib', 'bin', 'scripts']) visit(join(root, directory));
  assert.deepEqual(violations, []);
});
