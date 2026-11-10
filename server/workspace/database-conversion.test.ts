import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { convertWorkspaceDatabase } from './database-conversion.ts';
import { openWorkspaceDatabase } from './database-open.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-vacuum-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'workspace.db');
  const db = new Database(file);
  db.exec(
    'CREATE TABLE retained(id INTEGER PRIMARY KEY, data BLOB); INSERT INTO retained VALUES(1,zeroblob(1000000)); INSERT INTO retained VALUES(2,zeroblob(1000000)); DELETE FROM retained WHERE id=2;',
  );
  assert.equal(db.pragma('auto_vacuum', { simple: true }), 0);
  return { file, db };
}

test('offline worker converts a legacy database once and incremental vacuum reclaims future free pages', async (t) => {
  const { file, db } = fixture(t);
  db.close();
  const worker = new Worker(new URL('../workspace-vacuum-worker.ts', import.meta.url), {
    workerData: { file },
  });
  const result = await new Promise<any>((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code) reject(new Error(`worker exited ${code}`));
    });
  });
  assert.deepEqual(result, { status: 'complete' });
  const converted = new Database(file);
  assert.equal(converted.pragma('auto_vacuum', { simple: true }), 2);
  assert.equal(converted.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(
    (converted.prepare('SELECT length(data) AS n FROM retained').get() as { n: number }).n,
    1000000,
  );
  converted.exec('DELETE FROM retained');
  const before = converted.pragma('freelist_count', { simple: true }) as number;
  converted.pragma('incremental_vacuum(1024)');
  assert.ok((converted.pragma('freelist_count', { simple: true }) as number) < before);
  converted.close();
  assert.deepEqual(convertWorkspaceDatabase(file), { status: 'already-attempted' });
});

test('an open database is refused and the failure is not retried', (t) => {
  const { file, db } = fixture(t);
  try {
    assert.throws(() => convertWorkspaceDatabase(file), /database is open/);
    assert.equal(db.pragma('auto_vacuum', { simple: true }), 0);
  } finally {
    db.close();
  }
  assert.match(readFileSync(`${file}.incremental-vacuum-attempt.json`, 'utf8'), /failed/);
  assert.deepEqual(convertWorkspaceDatabase(file), { status: 'already-attempted' });
});

test('insufficient disk leaves data unchanged and records the failed attempt', (t) => {
  const { file, db } = fixture(t);
  db.close();
  assert.throws(() => convertWorkspaceDatabase(file, () => 0), /twice/);
  const reopened = new Database(file);
  assert.equal(reopened.pragma('auto_vacuum', { simple: true }), 0);
  reopened.close();
  assert.deepEqual(convertWorkspaceDatabase(file), { status: 'already-attempted' });
});

test('new workspace databases enable incremental vacuum before creating tables', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-fresh-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openWorkspaceDatabase(join(root, 'workspace.db'));
  db.exec('CREATE TABLE records(id TEXT)');
  assert.equal(db.pragma('auto_vacuum', { simple: true }), 2);
  db.close();
});

test('a killed maintenance process releases the open gate automatically', async (t) => {
  const { file, db } = fixture(t);
  db.close();
  const moduleUrl = new URL('./database-open.ts', import.meta.url).href;
  const source = `const {withWorkspaceDatabaseGate} = await import(${JSON.stringify(moduleUrl)}); withWorkspaceDatabaseGate(process.env.GATE_FILE,()=>{process.send('locked'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, GATE_FILE: file },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  await once(child, 'message');
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const opened = openWorkspaceDatabase(file);
  assert.equal(opened.pragma('integrity_check', { simple: true }), 'ok');
  opened.close();
});

test('the offline command cannot rewrite without explicit apply and stopped-server flags', (t) => {
  const { file, db } = fixture(t);
  db.close();
  const command = new URL('../../scripts/convert-workspace-database.ts', import.meta.url).pathname;
  assert.throws(() =>
    execFileSync(process.execPath, [command], {
      env: { ...process.env, DEPLOY_DATA_DIR: join(file, '..', '..') },
      stdio: 'pipe',
    }),
  );
  const unchanged = new Database(file);
  assert.equal(unchanged.pragma('auto_vacuum', { simple: true }), 0);
  unchanged.close();
});

test('the explicit offline command runs its worker against DEPLOY_DATA_DIR', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-command-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'workspace'));
  const file = join(root, 'workspace', 'workspace.db');
  const db = new Database(file);
  db.exec("CREATE TABLE records(id TEXT); INSERT INTO records VALUES('kept')");
  db.close();
  const command = new URL('../../scripts/convert-workspace-database.ts', import.meta.url).pathname;
  const result = execFileSync(process.execPath, [command, '--apply', '--server-stopped'], {
    env: { ...process.env, DEPLOY_DATA_DIR: root },
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(result), { status: 'complete' });
  const converted = new Database(file);
  assert.equal(converted.pragma('auto_vacuum', { simple: true }), 2);
  assert.deepEqual(converted.prepare('SELECT * FROM records').all(), [{ id: 'kept' }]);
  converted.close();
});
