import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { withMigrationLock } from './migration-lock.ts';

// The supervisor starts control and both workspace workers in the same tick, and each opens
// the database. On a fresh or just-updated database they all find the same migrations pending.
test('processes opening the database together migrate it once', { timeout: 120_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'migration-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const connection = fileURLToPath(new URL('./connection.ts', import.meta.url));
  const script = `const { getSqlite } = await import(${JSON.stringify(connection)});
    process.send('ready');
    await new Promise(resolve => process.once('message', resolve));
    const applied = getSqlite().prepare('SELECT count(*) AS n FROM __drizzle_migrations').get().n;
    process.stdout.write(String(applied));`;
  const runs = Array.from({ length: 5 }, () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, DEPLOY_DATA_DIR: root },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk) => (stdout += chunk));
    child.stderr!.on('data', (chunk) => (stderr += chunk));
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    return {
      child,
      ready: once(child, 'message'),
      exited: once(child, 'exit').then(([code]) => ({ code, stdout, stderr })),
    };
  });
  // Imports no longer stagger the opens: release all five on the same event.
  await Promise.all(runs.map((run) => run.ready));
  for (const run of runs) run.child.send('open');
  const results = await Promise.all(runs.map((run) => run.exited));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const counts = new Set(results.map((result) => result.stdout));
  assert.equal(counts.size, 1, `processes saw different migration counts: ${[...counts]}`);
  assert.ok(Number([...counts][0]) > 0);
  assert.equal(existsSync(join(root, 'deploy.db.migrating')), false);
});

test('a lock left by a dead process is taken over, and a live one is waited for', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'migration-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const database = join(root, 'deploy.db');
  const lock = `${database}.migrating`;

  mkdirSync(lock);
  // No process has this id: above the largest any supported system hands out.
  writeFileSync(join(lock, 'pid'), '2147483646');
  assert.equal(
    withMigrationLock(database, () => 'migrated'),
    'migrated',
  );
  assert.equal(existsSync(lock), false);

  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), String(process.pid));
  assert.throws(() => withMigrationLock(database, () => 'never', 200), /for too long/);
  assert.equal(existsSync(lock), true, 'a live owner lost its lock');

  rmSync(lock, { recursive: true });
  assert.throws(
    () =>
      withMigrationLock(database, () => {
        throw new Error('migration failed');
      }),
    /migration failed/,
  );
  assert.equal(existsSync(lock), false, 'a failed migration kept the lock');
});
