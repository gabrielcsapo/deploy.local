import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { selfUpdateInstall } from './self-update.mjs';
import { releaseStepEnvironment } from './linux-release.mjs';

test('self-update fallback uses public registry, leaves release unchanged and removes credential material', async () => {
  const root = await mkdtemp(join(tmpdir(), 'self-update-packages-'));
  const release = join(root, 'release');
  await mkdir(release);
  await writeFile(join(release, 'package.json'), '{}');
  const server = createServer((_req, res) => res.writeHead(503).end());
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const packageConfig = join(root, 'install.json');
  await writeFile(
    packageConfig,
    JSON.stringify({
      registry: `http://127.0.0.1:${server.address().port}/npm/`,
      key: 'dlp_' + 'a'.repeat(43),
      ca: '',
    }),
    { mode: 0o600 },
  );
  const logs = [];
  try {
    const prepared = await selfUpdateInstall({ data: root, release, packageConfig }, (line) =>
      logs.push(line),
    );
    assert.match(logs.join(''), /unreachable; installing from npmjs.org/);
    assert.equal(logs.length, 1);
    assert.equal(await readFile(prepared.npmrc, 'utf8'), 'registry=https://registry.npmjs.org/\n');
    assert.equal((await stat(prepared.npmrc)).mode & 0o777, 0o600);
    assert.equal(await stat(packageConfig).catch(() => null), null);
    assert.ok(!prepared.npmrc.startsWith(release + '/'));
    assert.equal(await readFile(join(release, 'package.json'), 'utf8'), '{}');
    assert.equal(await stat(join(release, '.npmrc')).catch(() => null), null);
    await prepared.cleanup();
    assert.equal(await stat(prepared.npmrc).catch(() => null), null);
    assert.deepEqual((await selfUpdateInstall({ data: root, release })).env, {});
    const env = { PATH: '/bin', DEPLOY_PACKAGE_NPMRC: '/private/temporary/npmrc' };
    assert.deepEqual(releaseStepEnvironment('install', env), {
      PATH: '/bin',
      NPM_CONFIG_USERCONFIG: '/private/temporary/npmrc',
    });
    assert.deepEqual(releaseStepEnvironment('test', env), { PATH: '/bin' });
    assert.deepEqual(releaseStepEnvironment('install', { PATH: '/bin' }), { PATH: '/bin' });
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});

test('self-update pins retain live and rollback releases and discard a failed candidate only', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { finishSelfUpdatePins } = await import('./self-update.mjs');
  const root = await mkdtemp(join(tmpdir(), 'update-pins-'));
  const database = new Database(join(root, 'deploy.db'));
  try {
    database.exec(
      'CREATE TABLE package_pins(project_id TEXT,release_id TEXT,reason TEXT); CREATE TABLE system_settings(key TEXT,value TEXT,updated_at TEXT);',
    );
    const insert = database.prepare("INSERT INTO package_pins VALUES('self',?,'self-release')");
    for (const id of ['old', 'from', 'to']) insert.run(id);
    finishSelfUpdatePins(
      { data: root, packageProject: 'self' },
      { from: 'from', to: 'to' },
      'done',
    );
    assert.deepEqual(
      database.prepare('SELECT release_id FROM package_pins ORDER BY release_id').all(),
      [{ release_id: 'from' }, { release_id: 'to' }],
    );
    insert.run('failed');
    finishSelfUpdatePins(
      { data: root, packageProject: 'self' },
      { from: 'to', to: 'failed' },
      'failed',
    );
    assert.equal(database.prepare('SELECT COUNT(*) n FROM package_pins').get().n, 2);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
