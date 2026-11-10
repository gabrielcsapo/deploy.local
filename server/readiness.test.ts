import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from './sqlite.ts';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { startIntegrityChecks, type IntegrityResult } from './readiness-integrity.ts';
import { createReadiness } from './readiness.ts';

test('heartbeats refreshed during a slow integrity check use the current clock', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'readiness-clock-'));
  const deploy = openDatabase(':memory:');
  const workspace = openDatabase(':memory:');
  t.after(() => {
    deploy.close();
    workspace.close();
    rmSync(root, { recursive: true, force: true });
  });
  workspace.exec('CREATE TABLE worker(id TEXT PRIMARY KEY, heartbeat TEXT)');
  let now = 1800000000000;
  let refreshed = false;
  const integrity = (): IntegrityResult => {
    // Simulate a slow integrity result arriving while another process refreshes its heartbeat.
    // This originally intercepted quick_check and failed against the synchronous implementation.
    if (!refreshed) {
      now += 6000;
      workspace
        .prepare('INSERT OR REPLACE INTO worker VALUES(?,?)')
        .run('pipelines', new Date(now).toISOString());
      refreshed = true;
    }
    return { deploy: 'ok', workspace: 'ok' };
  };
  const ready = createReadiness({ deploy, workspace, root, integrity, clock: () => now });
  assert.equal(ready().checks.pipelines, 'ok');
  for (const [offset, expected] of [
    [5000, 'ok'],
    [5001, 'worker heartbeat stale'],
    [-29999, 'ok'],
    [-30000, 'worker heartbeat stale'],
  ] as const) {
    workspace.prepare('UPDATE worker SET heartbeat=?').run(new Date(now + offset).toISOString());
    assert.equal(ready().checks.pipelines, expected, `heartbeat offset ${offset}`);
  }
});

test('readiness checks every migration, heartbeat age, release identity and cached integrity', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'readiness-'));
  const deploy = openDatabase(':memory:');
  const workspace = openDatabase(':memory:');
  t.after(() => {
    deploy.close();
    workspace.close();
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'drizzle/meta'), { recursive: true });
  const entries = [
    { when: 17, tag: 'first' },
    { when: 29, tag: 'second' },
  ];
  writeFileSync(join(root, 'drizzle/meta/_journal.json'), JSON.stringify({ entries }));
  deploy.exec(
    'CREATE TABLE __drizzle_migrations(created_at INTEGER, hash TEXT); CREATE TABLE integrity_test(v INTEGER CHECK(v>0))',
  );
  workspace.exec(
    'CREATE TABLE worker(id TEXT PRIMARY KEY, heartbeat TEXT); CREATE TABLE integrity_test(v INTEGER CHECK(v>0))',
  );
  for (const entry of entries) {
    const sql = `SELECT ${entry.when};`;
    writeFileSync(join(root, `drizzle/${entry.tag}.sql`), sql);
    deploy
      .prepare('INSERT INTO __drizzle_migrations VALUES(?,?)')
      .run(entry.when, createHash('sha256').update(sql).digest('hex'));
  }
  let now = 1800000000000;
  const fresh = () => {
    for (const name of ['pipelines', 'repositories'])
      workspace
        .prepare('INSERT OR REPLACE INTO worker VALUES(?,?)')
        .run(name, new Date(now).toISOString());
  };
  writeFileSync(join(root, '.deploy-release.json'), JSON.stringify({ revision: 'release-one' }));
  const env = { DEPLOY_COORDINATOR_VERSION: 'fixture', DEPLOY_COORDINATOR_RELEASE: 'one' };
  let result: IntegrityResult = {
    deploy: 'integrity check pending',
    workspace: 'integrity check pending',
  };
  const integrity = () => result;
  const ready = createReadiness({ deploy, workspace, root, env, integrity, clock: () => now });
  // Any request-triggered scan, including one after a long idle period, must fail this test.
  for (const database of [deploy, workspace])
    t.mock.method(database, 'pragma', () => {
      throw new Error('request ran a pragma');
    });

  assert.equal(ready().checks.pipelines, 'worker heartbeat missing');
  fresh();
  assert.equal(ready().checks.deploy, 'integrity check pending');
  assert.equal(ready().checks.workspace, 'integrity check pending');
  assert.equal(ready().ok, false);
  result = { deploy: 'ok', workspace: 'ok' };
  assert.equal(ready().ok, true);

  now += 30000;
  assert.equal(ready().checks.pipelines, 'worker heartbeat stale');
  fresh();
  workspace.prepare("UPDATE worker SET heartbeat='invalid' WHERE id='repositories'").run();
  assert.equal(ready().checks.repositories, 'worker heartbeat stale');
  fresh();
  // A migration file edited after it ran changes the hash but not what was applied.
  deploy.prepare('UPDATE __drizzle_migrations SET hash=? WHERE created_at=17').run('edited');
  assert.equal(ready().checks.migrations, 'ok');
  deploy.prepare('UPDATE __drizzle_migrations SET created_at=16 WHERE created_at=17').run();
  assert.equal(ready().checks.migrations, 'migrations pending');
  deploy.prepare('UPDATE __drizzle_migrations SET created_at=17 WHERE created_at=16').run();
  env.DEPLOY_COORDINATOR_VERSION = 'changed';
  assert.equal(ready().checks.version, 'release identity changed');
  env.DEPLOY_COORDINATOR_VERSION = 'fixture';
  writeFileSync(join(root, '.deploy-release.json'), JSON.stringify({ revision: 'release-two' }));
  assert.equal(ready().checks.version, 'release identity changed');
  writeFileSync(join(root, '.deploy-release.json'), JSON.stringify({ revision: 'release-one' }));
  writeFileSync(
    join(root, 'coordinator-build.json'),
    JSON.stringify({ version: 'different-build' }),
  );
  assert.equal(
    createReadiness({ deploy, workspace, root, env, integrity, clock: () => now })().checks.version,
    'release identity changed',
  );
  rmSync(join(root, 'coordinator-build.json'));
  now += 20 * 60 * 1000;
  fresh();
  assert.equal(
    ready().ok,
    true,
    'requests only read the last known result, even after a long idle',
  );
  result = { deploy: 'integrity check failed', workspace: 'integrity check failed' };
  assert.equal(ready().checks.deploy, 'integrity check failed');
  assert.equal(ready().checks.workspace, 'integrity check failed');
  assert.equal(ready().ok, false);
  result = { deploy: 'integrity check unavailable', workspace: 'ok' };
  assert.equal(ready().checks.deploy, 'integrity check unavailable');
  assert.equal(ready().ok, false);
});

class TestIntegrityWorker extends EventEmitter {
  unrefs = 0;
  terminations = 0;
  unref() {
    this.unrefs++;
  }
  async terminate() {
    this.terminations++;
    this.emit('exit', 1);
    return 1;
  }
}

test('integrity scans start immediately, never overlap, retain results and stop on shutdown', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const workers: TestIntegrityWorker[] = [];
  const integrity = startIntegrityChecks(
    { deploy: 'unused', workspace: 'unused' },
    {
      createWorker: () => {
        const worker = new TestIntegrityWorker();
        workers.push(worker);
        return worker;
      },
    },
  );
  t.after(() => integrity.stop());
  assert.equal(workers.length, 1, 'startup does not wait for a request or the interval');
  assert.equal(workers[0].unrefs, 1);
  assert.deepEqual(integrity.read(), {
    deploy: 'integrity check pending',
    workspace: 'integrity check pending',
  });
  for (let i = 0; i < 100; i++) integrity.read();
  t.mock.timers.tick(10 * 60 * 1000);
  assert.equal(workers.length, 1, 'a slow scan cannot overlap the next interval');
  workers[0].emit('message', { deploy: 'ok', workspace: 'ok' });
  workers[0].emit('exit', 0);
  assert.deepEqual(integrity.read(), { deploy: 'ok', workspace: 'ok' });
  t.mock.timers.tick(10 * 60 * 1000 - 1);
  assert.equal(workers.length, 1);
  t.mock.timers.tick(1);
  assert.equal(workers.length, 2);
  assert.deepEqual(
    integrity.read(),
    { deploy: 'ok', workspace: 'ok' },
    'keep the last result while checking',
  );
  await integrity.stop();
  assert.equal(workers[1].terminations, 1);
  t.mock.timers.tick(20 * 60 * 1000);
  assert.equal(workers.length, 2, 'shutdown removes the timer');
});

test('worker errors, silent exits and invalid results fail closed and retry on the next interval', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const workers: TestIntegrityWorker[] = [];
  let attempts = 0;
  const integrity = startIntegrityChecks(
    { deploy: 'unused', workspace: 'unused' },
    {
      createWorker: () => {
        if (++attempts === 1) throw new Error('/secret/database could not start');
        const worker = new TestIntegrityWorker();
        workers.push(worker);
        return worker;
      },
    },
  );
  t.after(() => integrity.stop());
  const unavailable = {
    deploy: 'integrity check unavailable',
    workspace: 'integrity check unavailable',
  };
  assert.deepEqual(integrity.read(), unavailable);
  t.mock.timers.tick(10 * 60 * 1000);
  workers[0].emit('error', new Error('private driver error'));
  assert.deepEqual(integrity.read(), unavailable);
  t.mock.timers.tick(10 * 60 * 1000);
  assert.equal(attempts, 2, 'error does not free the slot before the worker exits');
  workers[0].emit('exit', 1);
  for (const exit of [0, 1]) {
    t.mock.timers.tick(10 * 60 * 1000);
    workers.at(-1)!.emit('exit', exit);
    assert.deepEqual(integrity.read(), unavailable, 'exiting without a result fails closed');
  }
  t.mock.timers.tick(10 * 60 * 1000);
  workers.at(-1)!.emit('message', { deploy: '/secret/path', workspace: 'ok' });
  workers.at(-1)!.emit('exit', 0);
  assert.deepEqual(integrity.read(), unavailable);
  t.mock.timers.tick(10 * 60 * 1000);
  workers.at(-1)!.emit('message', { deploy: 'ok', workspace: 'ok' });
  workers.at(-1)!.emit('exit', 0);
  assert.deepEqual(integrity.read(), { deploy: 'ok', workspace: 'ok' });
  t.mock.timers.tick(10 * 60 * 1000);
  workers.at(-1)!.emit('message', { deploy: 'ok', workspace: 'ok' });
  workers.at(-1)!.emit('exit', 1);
  assert.deepEqual(
    integrity.read(),
    unavailable,
    'a failed exit overrides even a successful message',
  );
});

test(
  'integrity timers and an active worker do not keep a process alive',
  { timeout: 10000 },
  async (t) => {
    const module = new URL('./readiness-integrity.ts', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import { Worker } from 'node:worker_threads';
    import { startIntegrityChecks } from ${JSON.stringify(module)};
    startIntegrityChecks({ deploy: 'unused', workspace: 'unused' }, {
      createWorker: () => new Worker('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)', { eval: true, execArgv: [] }),
    });
  `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    t.after(() => {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    let output = '';
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const [code, signal] = await once(child, 'exit');
    assert.equal(signal, null, 'unreferenced services must allow natural exit');
    assert.equal(code, 0, output);
  },
);

test(
  'the real integrity worker checks live WAL databases and isolates failed and corrupt databases',
  { timeout: 15000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'readiness-worker-'));
    const healthy = join(root, 'healthy.db');
    const failing = join(root, 'failing.db');
    const corrupt = join(root, 'corrupt.db');
    const deploy = openDatabase(healthy, { wal: true });
    const workspace = openDatabase(failing, { wal: true });
    t.after(() => {
      deploy.close();
      workspace.close();
      rmSync(root, { recursive: true, force: true });
    });
    deploy.exec('CREATE TABLE healthy(value TEXT)');
    // SQLite omits CHECK expressions when loading a read-only schema. Introduce a
    // NOT NULL violation instead, which quick_check validates on read-only connections.
    workspace.unsafeMode(true);
    workspace.exec(`
      CREATE TABLE integrity_test(v INTEGER);
      INSERT INTO integrity_test VALUES(NULL);
      PRAGMA writable_schema = ON;
      UPDATE sqlite_schema SET sql='CREATE TABLE integrity_test(v INTEGER NOT NULL)' WHERE name='integrity_test';
      PRAGMA writable_schema = OFF;
    `);
    workspace.unsafeMode(false);
    writeFileSync(corrupt, 'not a database');
    for (const [databases, expected] of [
      [
        { deploy: healthy, workspace: failing },
        { deploy: 'ok', workspace: 'integrity check failed' },
      ],
      [
        { deploy: failing, workspace: healthy },
        { deploy: 'integrity check failed', workspace: 'ok' },
      ],
      [
        { deploy: corrupt, workspace: healthy },
        { deploy: 'integrity check unavailable', workspace: 'ok' },
      ],
      [
        { deploy: healthy, workspace: join(root, 'missing.db') },
        { deploy: 'ok', workspace: 'integrity check unavailable' },
      ],
    ] as const) {
      const integrity = startIntegrityChecks(databases);
      try {
        for (let i = 0; i < 500 && integrity.read().deploy === 'integrity check pending'; i++)
          await delay(10);
        assert.deepEqual(integrity.read(), expected);
      } finally {
        await integrity.stop();
      }
    }
  },
);

test(
  'the real booted control server serves unauthenticated readiness and fails closed',
  { timeout: 90000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'ready-boot-'));
    const boot = new URL('./boot.ts', import.meta.url).href;
    const workspace = new URL('./workspace/store.ts', import.meta.url).href;
    const store = new URL('./store/connection.ts', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import { Server } from 'node:http';
    const listen = Server.prototype.listen;
    Server.prototype.listen = function(...args) {
      this.once('listening', () => process.send({port: this.address().port}));
      return listen.apply(this, args);
    };
    const {bootServer} = await import(${JSON.stringify(boot)});
    const {db} = await import(${JSON.stringify(workspace)});
    const {getSqlite} = await import(${JSON.stringify(store)});
    process.on('message', ({id, action}) => {
      if (action === 'fresh') for (const name of ['pipelines','repositories'])
        db.prepare('INSERT OR REPLACE INTO worker VALUES(?,?,?)').run(name,process.pid,new Date().toISOString());
      if (action === 'stale') db.prepare("UPDATE worker SET heartbeat=? WHERE id='pipelines'").run(new Date(Date.now()-31000).toISOString());
      if (action === 'version') process.env.DEPLOY_COORDINATOR_VERSION = 'wrong';
      if (action === 'migration') getSqlite().prepare('DELETE FROM __drizzle_migrations WHERE rowid=(SELECT MIN(rowid) FROM __drizzle_migrations)').run();
      process.send({id});
    });
    await bootServer({role:'control',createClient:async()=>async(_req,res)=>{res.writeHead(200);res.end('<html>fallback</html>');}});
  `,
      ],
      {
        env: {
          ...process.env,
          CONTROL_PORT: '0',
          DEPLOY_SSH_PORT: '0',
          DEPLOY_MDNS_ADDRESS: '127.0.0.1',
          DEPLOY_DATA_DIR: root,
          DEPLOY_COORDINATOR_VERSION: 'ready-fixture',
          DEPLOY_SUPERVISOR_TOKEN: 'secret-not-for-health',
          DOCKER_HOST: 'unix:///nonexistent/docker.sock',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    let output = '';
    child.stdout!.on('data', (chunk) => (output += chunk));
    child.stderr!.on('data', (chunk) => (output += chunk));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
      rmSync(root, { recursive: true, force: true });
    });
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(output)), 60000);
      child.on('message', (message: any) => {
        if (message.port) {
          clearTimeout(timer);
          resolve(message.port);
        }
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error(output));
      });
    });
    let id = 0;
    async function command(action: string) {
      const current = ++id;
      const done = new Promise<void>((resolve) => {
        const onMessage = (message: any) => {
          if (message.id === current) {
            child.off('message', onMessage);
            resolve();
          }
        };
        child.on('message', onMessage);
      });
      child.send({ id: current, action });
      await done;
    }
    async function check(status: number, host = 'deploy.local') {
      const response = await fetch(`http://127.0.0.1:${port}/api/health/ready`, {
        headers: { host },
      });
      assert.equal(response.status, status, output);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json();
      assert.deepEqual(Object.keys(body).sort(), ['checks', 'ok', 'version']);
      assert.equal(body.version, 'ready-fixture');
      assert.ok(!JSON.stringify(body).includes('secret-not-for-health'));
      return body;
    }
    assert.equal((await check(503)).checks.pipelines, 'worker heartbeat missing');
    // Startup scans are asynchronous. Poll within activation's existing 30-attempt window.
    for (let attempt = 0; attempt < 30; attempt++) {
      const body = await check(503);
      if (body.checks.deploy === 'ok' && body.checks.workspace === 'ok') break;
      assert.equal(body.checks.deploy, 'integrity check pending');
      await delay(1000);
    }
    await command('fresh');
    assert.equal((await check(200, '192.168.1.42')).ok, true);
    await command('stale');
    assert.equal((await check(503)).checks.pipelines, 'worker heartbeat stale');
    await command('fresh');
    await command('migration');
    assert.equal((await check(503)).checks.migrations, 'migrations pending');
    await command('version');
    assert.equal((await check(503)).checks.version, 'release identity changed');
  },
);
