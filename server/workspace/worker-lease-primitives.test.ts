import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test, type TestContext } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'lease-primitives-'));
process.env.DEPLOY_DATA_DIR = root;
// These are deliberately the compatibility paths: the same tests run before and after moving.
const { claimWorker } = await import('./worker-lease.ts');
const { claimRemoteWorker } = await import('./remote-worker-lease.ts');
const { workerLease } = await import('./worker-process.ts');
const { startServiceLoop } = await import('./service-loop.ts');
const { db, get, now, save } = await import('./store.ts');
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

// Darwin's real ps is unavailable in the sandbox. Stub only the OS identity probe, leaving
// claim SQL, takeover checks, file promotion and release logic under test unchanged.
function identityProbe(t: TestContext) {
  if (process.platform !== 'darwin') return;
  t.mock.method(childProcess, 'execFileSync', (file: string, args: string[]) => {
    assert.equal(file, 'ps');
    assert.equal(args[2], String(process.pid));
    return `Fri Nov 13 12:00:00 2026  S ${process.execPath} ${process.argv[1]}`;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test('a live durable holder wins again even with an ancient heartbeat', (t) => {
  identityProbe(t);
  claimWorker('contested');
  const first = get('worker-lease', 'system', 'contested');
  db.prepare('UPDATE worker SET heartbeat=? WHERE id=?').run('1970-01-01', 'contested');
  assert.throws(() => claimWorker('contested'), /Worker already running/);
  assert.deepEqual(get('worker-lease', 'system', 'contested'), first);
});

test('dead holder takeover fences the service heartbeat and release by PID', (t) => {
  identityProbe(t);
  const dead = 2147483647;
  const kill = process.kill;
  t.mock.method(process, 'kill', (pid: number, signal: NodeJS.Signals | number = 'SIGTERM') => {
    if (pid === dead) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    return kill(pid, signal);
  });
  db.prepare('INSERT INTO worker VALUES(?,?,?)').run('replaced', dead, '1970-01-01');
  save('worker-lease', 'system', { id: 'replaced', pid: dead });
  claimWorker('replaced');
  assert.equal(get('worker-lease', 'system', 'replaced').pid, process.pid);
  const beat = db.prepare('UPDATE worker SET heartbeat=? WHERE id=? AND pid=?');
  const release = db.prepare('DELETE FROM worker WHERE id=? AND pid=?');
  assert.equal(beat.run(now(), 'replaced', dead).changes, 0);
  assert.equal(release.run('replaced', dead).changes, 0);
  assert.equal(beat.run(now(), 'replaced', process.pid).changes, 1);
  assert.equal(release.run('replaced', process.pid).changes, 1);
  claimWorker('replaced');
  assert.equal(get('worker-lease', 'system', 'replaced').pid, process.pid);
});

test('service heartbeat advances during held work and stop removes the timer', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 10000 });
  db.prepare('INSERT INTO worker VALUES(?,?,?)').run('beat', process.pid, now());
  let finish!: () => void;
  let passes = 0;
  const held = new Promise<void>((resolve) => (finish = resolve));
  const loop = startServiceLoop({
    beat: () => {
      db.prepare('UPDATE worker SET heartbeat=? WHERE id=? AND pid=?').run(
        now(),
        'beat',
        process.pid,
      );
    },
    pass: () => {
      passes++;
      return held;
    },
  });
  t.mock.timers.tick(1000);
  t.mock.timers.tick(1000);
  assert.equal(passes, 1);
  assert.deepEqual(db.prepare('SELECT heartbeat FROM worker WHERE id=?').get('beat'), {
    heartbeat: new Date(12000).toISOString(),
  });
  loop.stop();
  finish();
  await held;
  t.mock.timers.tick(1000);
  assert.equal(passes, 1);
  assert.deepEqual(db.prepare('SELECT heartbeat FROM worker WHERE id=?').get('beat'), {
    heartbeat: new Date(12000).toISOString(),
  });
});

test('remote claim refuses a live holder, and release cannot remove a replacement', (t) => {
  identityProbe(t);
  const path = join(root, 'worker.pid');
  const lease = workerLease();
  const release = claimRemoteWorker(path, lease);
  assert.throws(() => claimRemoteWorker(path, lease), /Worker already running/);
  assert.equal(existsSync(path + '.claim'), false);
  const replacement = { ...lease, started: 'replacement' };
  writeFileSync(path, JSON.stringify(replacement));
  release();
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), replacement);
  writeFileSync(path, JSON.stringify(lease));
  release();
  assert.equal(existsSync(path), false);
  claimRemoteWorker(path, lease)();
  assert.equal(existsSync(path), false);
});

test('remote claim takes a dead legacy PID and cleans its guard on malformed state', (t) => {
  identityProbe(t);
  const path = join(root, 'legacy.pid');
  const kill = process.kill;
  t.mock.method(process, 'kill', (pid: number, signal: NodeJS.Signals | number = 'SIGTERM') => {
    if (pid === 2147483647) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    return kill(pid, signal);
  });
  writeFileSync(path, '2147483647');
  const lease = workerLease();
  claimRemoteWorker(path, lease)();
  writeFileSync(path, '{');
  assert.throws(() => claimRemoteWorker(path, lease), SyntaxError);
  assert.equal(readFileSync(path, 'utf8'), '{');
  assert.equal(existsSync(path + '.claim'), false);
});

for (const remote of [false, true]) {
  test(`${remote ? 'file' : 'database'} contenders leave exactly one live same-build holder`, async () => {
    const children: ReturnType<typeof childProcess.spawn>[] = [];
    const source = `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      // Model only Darwin's unavailable ps probe. Real PIDs, SQLite transactions and atomic
      // directory acquisition still contend across four processes. No takeover is signalled.
      if (process.platform === 'darwin') {
        childProcess.execFileSync = (file) => {
          if (file !== 'ps') throw new Error('Unexpected process probe');
          return 'Fri Nov 13 12:00:00 2026  S ' + process.execPath;
        };
        syncBuiltinESMExports();
      }
      const { ${remote ? 'claimRemoteWorker' : 'claimWorker'} } = await import(${JSON.stringify(new URL('./', import.meta.url).href)} + ${JSON.stringify(remote ? 'remote-worker-lease.ts' : 'worker-lease.ts')});
      process.on('message', () => {
        try {
          ${remote ? `claimRemoteWorker(${JSON.stringify(join(root, 'contenders.pid'))})` : "claimWorker('contenders')"};
          process.send('claimed');
        } catch (error) { process.send(error.message); }
      });
      process.send('ready');
    `;
    try {
      for (let i = 0; i < 4; i++) {
        const child = childProcess.spawn(process.execPath, ['--input-type=module', '-e', source], {
          env: { ...process.env, DEPLOY_DATA_DIR: root },
          stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        });
        children.push(child);
        const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
        assert.equal(ready, 'ready');
      }
      const results = await Promise.all(
        children.map(async (child) => {
          const result = once(child, 'message', { signal: AbortSignal.timeout(5000) });
          child.send!('claim');
          return (await result)[0];
        }),
      );
      assert.equal(results.filter((result) => result === 'claimed').length, 1);
      assert.ok(
        results
          .filter((result) => result !== 'claimed')
          .every((result) => /already running/.test(result)),
        JSON.stringify(results),
      );
    } finally {
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          const exited = once(child, 'exit');
          child.kill('SIGTERM');
          await exited;
        }),
      );
    }
  });
}
