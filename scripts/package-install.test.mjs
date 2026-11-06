import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { selfUpdateInstall, prepareSelfUpdate, cleanupUpdatePackages } from './self-update.mjs';
const isolatedHome = await mkdtemp(join(tmpdir(), 'update-packages-home-'));
process.env.NPM_CONFIG_USERCONFIG = join(isolatedHome, 'npmrc');
delete process.env.npm_config_userconfig;
await writeFile(process.env.NPM_CONFIG_USERCONFIG, '');
after(() => rm(isolatedHome, { recursive: true, force: true }));

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
    assert.match(
      await readFile(prepared.npmrc, 'utf8'),
      /^registry=https:\/\/registry.npmjs.org\//m,
    );
    assert.equal((await stat(prepared.npmrc)).mode & 0o777, 0o600);
    assert.equal(await stat(packageConfig).catch(() => null), null);
    assert.ok(!prepared.npmrc.startsWith(release + '/'));
    assert.equal(await readFile(join(release, 'package.json'), 'utf8'), '{}');
    assert.equal(await stat(join(release, '.npmrc')).catch(() => null), null);
    await prepared.cleanup();
    assert.equal(await stat(prepared.npmrc).catch(() => null), null);
    assert.deepEqual((await selfUpdateInstall({ data: root, release })).env, {});
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

test('prepare uses the update directory and the installed helper environment; retries once and removes secrets on all outcomes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prepare-registry-'));
  const release = join(root, 'release');
  const updates = join(root, 'updates');
  await mkdir(release);
  await mkdir(updates);
  const server = createServer((_req, res) => res.end('{}'));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    for (const outcome of ['success', 'fallback', 'both-fail', 'test-fail', 'unknown-fail']) {
      const packageConfig = join(updates, 'run.packages.json');
      const key = 'dlp_' + 'a'.repeat(43);
      await writeFile(
        packageConfig,
        JSON.stringify({ registry: `http://127.0.0.1:${server.address().port}/npm/`, key, ca: '' }),
        { mode: 0o600 },
      );
      const plan = {
        release,
        packageConfig,
        data: '/inaccessible/root/packages',
        history: join(updates, 'history.json'),
      };
      const install = await selfUpdateInstall(plan);
      assert.ok(install.npmrc.startsWith(updates + '/package-install-'));
      assert.equal(await stat(packageConfig).catch(() => null), null);
      let calls = 0;
      const logs = [];
      const prepare = prepareSelfUpdate(
        plan,
        install,
        async (command, args, options) => {
          calls++;
          assert.equal(command, 'deploy-update');
          assert.deepEqual(args, ['prepare', release]);
          assert.equal(options.env.DEPLOY_PACKAGE_NPMRC, undefined);
          if (calls === 1) {
            assert.equal(options.env.NPM_CONFIG_USERCONFIG, install.npmrc);
            assert.ok((await readFile(install.npmrc, 'utf8')).includes(key));
            if (outcome === 'test-fail')
              throw Object.assign(Error('tests failed'), {
                output: 'pnpm install --frozen-lockfile\npnpm test\nCommand failed: pnpm test\n',
              });
            if (outcome === 'unknown-fail') throw Error('prepare interrupted');
            if (outcome !== 'success')
              throw Object.assign(Error('registry disappeared'), {
                output: 'Command failed: pnpm install --frozen-lockfile\n',
              });
          } else {
            assert.equal(options.env.NPM_CONFIG_USERCONFIG, process.env.NPM_CONFIG_USERCONFIG);
            assert.equal(await stat(install.npmrc).catch(() => null), null);
            if (outcome === 'both-fail') throw Error('public install also failed');
          }
          return 'prepared';
        },
        (line) => logs.push(line),
      );
      if (outcome === 'test-fail') await assert.rejects(prepare, /tests failed/);
      else if (outcome === 'unknown-fail') await assert.rejects(prepare, /prepare interrupted/);
      else if (outcome === 'both-fail') await assert.rejects(prepare, /public install also failed/);
      else assert.equal(await prepare, 'prepared');
      assert.equal(calls, ['success', 'test-fail', 'unknown-fail'].includes(outcome) ? 1 : 2);
      assert.equal(logs.length, calls - 1);
      assert.equal(await stat(install.directory).catch(() => null), null);
    }
    const stale = join(updates, 'package-install-crashed');
    await mkdir(stale);
    await writeFile(join(stale, 'npmrc'), 'secret');
    await writeFile(join(updates, 'old.packages.json'), 'secret');
    await writeFile(join(updates, 'new.packages.json'), 'new');
    cleanupUpdatePackages(updates, join(updates, 'new.packages.json'));
    assert.equal(await stat(stale).catch(() => null), null);
    assert.equal(await stat(join(updates, 'old.packages.json')).catch(() => null), null);
    assert.equal(await readFile(join(updates, 'new.packages.json'), 'utf8'), 'new');
    cleanupUpdatePackages(updates);
    assert.equal(await stat(join(updates, 'new.packages.json')).catch(() => null), null);
    let calls = 0;
    await assert.rejects(
      prepareSelfUpdate({ release }, { env: {}, cleanup: async () => {} }, async () => {
        calls++;
        throw Error('manual failure');
      }),
      /manual failure/,
    );
    assert.equal(calls, 1, 'manual prepare is unchanged');
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});

test('a terminated updater removes its prepare config; the next start removes an uncatchable crash leftover', async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { resolve } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'update-crash-'));
  const current = join(root, 'current');
  const release = join(root, 'next');
  const bin = join(root, 'bin');
  await mkdir(current);
  await mkdir(bin);
  const marker = join(root, 'prepare-started');
  await writeFile(join(bin, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(
    join(bin, 'deploy-update'),
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, process.env.NPM_CONFIG_USERCONFIG); setInterval(() => {}, 1000);\n`,
    { mode: 0o755 },
  );
  const server = createServer((_req, res) => res.end('{}'));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const file = join(root, 'current.json');
  const packageConfig = join(root, 'run.packages.json');
  await writeFile(
    packageConfig,
    JSON.stringify({
      registry: `http://127.0.0.1:${server.address().port}/npm/`,
      key: 'dlp_' + 'c'.repeat(43),
      ca: '',
    }),
  );
  await writeFile(
    file,
    JSON.stringify({
      from: 'aaa',
      to: 'bbb',
      steps: ['prepare', 'backup', 'restart', 'check'].map((id) => ({ id, state: 'waiting' })),
      plan: {
        current,
        release,
        repository: root,
        data: root,
        log: join(root, 'run.log'),
        history: join(root, 'history.json'),
        packageConfig,
      },
    }),
  );
  const child = spawn(process.execPath, [resolve('scripts/self-update.mjs'), file], {
    detached: true,
    env: { ...process.env, PATH: bin + ':' + process.env.PATH },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let error = '';
  child.stderr.on('data', (chunk) => {
    error += chunk;
  });
  try {
    const deadline = Date.now() + 10000;
    while (!(await stat(marker).catch(() => null))) {
      assert.equal(child.exitCode, null, error);
      assert.ok(Date.now() < deadline, 'prepare started');
      await new Promise((done) => setTimeout(done, 25));
    }
    const npmrc = await readFile(marker, 'utf8');
    assert.ok((await readFile(npmrc, 'utf8')).includes('dlp_'));
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    assert.equal(await stat(npmrc).catch(() => null), null);
    assert.equal(await stat(packageConfig).catch(() => null), null);
  } finally {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
