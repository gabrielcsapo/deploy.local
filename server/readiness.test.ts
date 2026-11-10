import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadiness } from './readiness.ts';

test('readiness checks every migration, heartbeat age, release identity and cached integrity', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'readiness-'));
  const deploy = new Database(':memory:');
  const workspace = new Database(':memory:');
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
  const ready = createReadiness({ deploy, workspace, root, env, clock: () => now });
  assert.equal(ready().checks.pipelines, 'worker heartbeat missing');
  fresh();
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
    createReadiness({ deploy, workspace, root, env, clock: () => now })().checks.version,
    'release identity changed',
  );
  rmSync(join(root, 'coordinator-build.json'));
  for (const database of [deploy, workspace]) {
    database.pragma('ignore_check_constraints = ON');
    database.prepare('INSERT INTO integrity_test VALUES(0)').run();
    database.pragma('ignore_check_constraints = OFF');
  }
  assert.equal(ready().checks.deploy, 'ok', 'integrity results are cached for one minute');
  now += 30000;
  fresh();
  assert.equal(ready().checks.deploy, 'integrity check failed');
  assert.equal(ready().checks.workspace, 'integrity check failed');
  assert.equal(ready().ok, false);
});

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
