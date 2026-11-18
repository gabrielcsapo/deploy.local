import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import tar from 'tar-stream';
import {
  preparePackageInstall,
  registryPing,
  secretOutput,
  registryFallback,
} from '../../shared/package-install.mjs';
import { JobRunner } from '../workspace/job-runner.ts';
import { captureSnapshot } from '../workspace/checkpoint.ts';
const root = await mkdtemp(join(tmpdir(), 'package-builds-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_MDNS_ADDRESS = '127.0.0.1';
const { registerUser, getSqlite, _resetDb, authenticate } = await import('../store.ts');
await import('./hooks.ts');
const { db: workspace, save } = await import('../workspace/store.ts');
const { computerPackageKey, listKeys, registryIdentity, revokeComputerPackageKey } =
  await import('./keys.ts');
const { workerAuthentication } = await import('../workspace/credentials.ts');
const { createNpmRegistry } = await import('./npm.ts');
const { nodeDockerfile, ensureDockerfile } = await import('../docker.ts');
const { copiesStatus, CopyWarmer, matchesPlatforms, cleanupCopies, queueAllCopies } =
  await import('./copies.ts');
const { objectPath } = await import('./store.ts');
const { projectPackagesEnabled, computerInstallConfig } = await import('./builds.ts');
registerUser('build-owner', 'test-password-long');
registerUser('other-owner', 'test-password-long');
const key = computerPackageKey('build-owner', 'test-computer');
const servers: Server[] = [];
const listen = async (server: Server) => {
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return 'http://127.0.0.1:' + (server.address() as { port: number }).port;
};
const close = async (server: Server) => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
};
const exec = promisify(execFile);
let registry: ReturnType<typeof createNpmRegistry>;
after(async () => {
  registry?.copy.close();
  for (const server of servers) await close(server);
  _resetDb();
  workspace.close();
  await rm(root, { recursive: true, force: true });
});

test('computer key is separate, private, install-only, revocable, and rejected by other authentication paths', async () => {
  assert.equal(computerPackageKey('build-owner', 'test-computer'), key);
  assert.match(key, /^dlp_[\w-]{43}$/);
  assert.deepEqual(listKeys('build-owner'), []);
  const req = { headers: { authorization: 'Bearer ' + key } } as any;
  assert.equal(registryIdentity(req)?.publish, false);
  assert.equal(registryIdentity(req)?.computer, true);
  assert.equal(workerAuthentication(req), null);
  assert.equal(
    workerAuthentication({
      headers: {
        'x-deploy-worker-id': 'test-computer',
        'x-deploy-worker-token': key,
      },
    } as any),
    null,
  );
  assert.equal(
    workerAuthentication({
      headers: {
        authorization:
          'Basic ' + Buffer.from('workspace-worker.test-computer:' + key).toString('base64'),
      },
    } as any),
    null,
  );
  assert.equal(authenticate('build-owner', key), false);
  const { authenticateNode } = await import('../store.ts');
  const { authenticateAgent } = await import('../workspace/coordination.ts');
  const { authenticateCi } = await import('../ci-releases.ts');
  assert.equal(authenticateNode('test-computer', key), false);
  assert.equal(authenticateAgent(key), null);
  assert.throws(() => authenticateCi(key), /Unauthorized/);
  const disposable = computerPackageKey('build-owner', 'remove-me');
  revokeComputerPackageKey('build-owner', 'remove-me');
  assert.equal(
    registryIdentity({ headers: { authorization: 'Bearer ' + disposable } } as any),
    null,
  );
  const stored = JSON.stringify(getSqlite()!.prepare('SELECT * FROM package_computer_keys').all());
  assert.ok(!stored.includes(key));
});

test('job configs are 0600, use only the install key, mount CA and host mapping, preserve committed configuration, clean up', async () => {
  const { shellEnvironment } = await import('../workspace/shell-environment.ts');
  assert.deepEqual(
    shellEnvironment({
      BUN_CONFIG_REGISTRY: 'inherited',
      BUN_CONFIG_TOKEN: 'secret',
      NPM_CONFIG_TOKEN: 'secret',
      DEPLOY_WORKER_TOKEN: 'worker',
    }),
    {},
  );
  const cwd = join(root, 'config');
  await mkdir(cwd);
  await writeFile(join(cwd, 'package.json'), '{"packageManager":"yarn@4.0.0"}');
  const config = {
    registry: 'https://deploy.local/npm/',
    key,
    ca: 'certificate',
    address: '192.0.2.1',
  };
  const prepared = await preparePackageInstall(config, {
    cwd,
    root,
    container: true,
    ping: async () => true,
  });
  assert.equal((await stat(prepared.npmrc!)).mode & 0o777, 0o600);
  assert.equal(prepared.env.YARN_NPM_AUTH_TOKEN, key);
  assert.equal(prepared.env.YARN_HTTPS_CA_FILE_PATH, '/run/deploy-packages/ca.crt');
  assert.equal(prepared.env.NODE_EXTRA_CA_CERTS, undefined);
  assert.ok(prepared.args.includes('deploy.local:192.0.2.1'));
  assert.ok(!prepared.args.join(' ').includes(key));
  assert.match(await readFile(prepared.npmrc!, 'utf8'), /cafile=\/run\/deploy-packages\/ca.crt/);
  await prepared.cleanup();
  assert.equal(await stat(prepared.npmrc!).catch(() => null), null);
  await writeFile(join(cwd, '.npmrc'), 'registry=https://example.invalid/\n');
  assert.deepEqual(
    (
      await preparePackageInstall(config, {
        cwd,
        root,
        ping: async () => {
          throw Error('must not probe');
        },
      })
    ).env,
    {},
  );
  assert.equal(await readFile(join(cwd, '.npmrc'), 'utf8'), 'registry=https://example.invalid/\n');
});

test('redacts a key across stdout chunks and withholds incomplete credential prefixes', () => {
  let output = '';
  const redact = secretOutput([key], (chunk) => {
    output += chunk;
  });
  redact.write('before ' + key.slice(0, 17));
  assert.equal(output, 'before ');
  redact.write(key.slice(17) + ' after');
  redact.end();
  assert.equal(output, 'before [redacted] after');
});

test('generated Dockerfile uses ephemeral BuildKit secrets; legacy generation and project Dockerfiles stay independent', async () => {
  const content = nodeDockerfile();
  assert.match(content, /RUN --mount=type=cache/);
  assert.match(
    content,
    /--mount=type=secret,id=npmrc,target=\/run\/deploy-packages\/npmrc,mode=0600/,
  );
  assert.match(content, /--mount=type=secret,id=ca/);
  assert.ok(!content.includes(key));
  assert.doesNotMatch(content, /^(?:ARG|ENV).*TOKEN/m);
  assert.doesNotMatch(nodeDockerfile(false), /--mount|deploy-packages|YARN_NPM_AUTH_TOKEN/);
  const cwd = join(root, 'custom-docker');
  await mkdir(cwd);
  await writeFile(join(cwd, 'Dockerfile'), 'FROM scratch\n');
  ensureDockerfile(cwd, 'node');
  assert.equal(await readFile(join(cwd, 'Dockerfile'), 'utf8'), 'FROM scratch\n');
});

test('project opt-out selects public registries and defaults on', async () => {
  assert.equal(projectPackagesEnabled('build-owner', 'settings'), true);
  save('v2-project-policy', 'build-owner', { id: 'settings', installThroughDeploy: false });
  assert.equal(projectPackagesEnabled('build-owner', 'settings'), false);
  assert.equal(
    (await computerInstallConfig('build-owner', 'test-computer', 'settings'))!.registry,
    'https://registry.npmjs.org/',
  );
});

test('workers enrolled on one computer share its install-only key', async () => {
  save('managed-worker', 'build-owner', { id: 'managed-build-worker' });
  const local = await computerInstallConfig('build-owner', 'local');
  const managed = await computerInstallConfig('build-owner', 'managed-build-worker');
  assert.equal(local.key, managed.key);
  assert.equal(managed.address, 'host-gateway');
  assert.equal(local.key, computerPackageKey('build-owner', 'coordinator'));
  revokeComputerPackageKey('build-owner', 'coordinator');
  assert.equal(
    registryIdentity({ headers: { authorization: 'Bearer ' + local.key } } as any),
    null,
  );
});

test(
  'real jobs with npm and pnpm install through the registry, then use public fallback when registry stops',
  { timeout: 120000 },
  async (t) => {
    const pack = tar.pack();
    pack.entry(
      { name: 'package/package.json' },
      JSON.stringify({ name: 'fixture-package', version: '1.0.0', main: 'index.js' }),
    );
    pack.entry({ name: 'package/index.js' }, 'module.exports = 42;');
    pack.finalize();
    const chunks: Buffer[] = [];
    for await (const chunk of pack) chunks.push(chunk as Buffer);
    const bytes = gzipSync(Buffer.concat(chunks));
    let upstreamHits = 0,
      registryHits = 0;
    const upstream = createServer((req, res) => {
      upstreamHits++;
      if (req.url?.endsWith('.tgz')) {
        res.end(bytes);
        return;
      }
      if (req.url === '/-/ping') {
        res.end('{}');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          name: 'fixture-package',
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name: 'fixture-package',
              version: '1.0.0',
              dist: {
                tarball: upstreamURL + '/fixture-package/-/fixture-package-1.0.0.tgz',
                integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
              },
            },
          },
        }),
      );
    });
    const upstreamURL = await listen(upstream);
    const registryServer = createServer(async (req, res) => {
      registryHits++;
      if (await registry.handle(req, res)) return;
      res.writeHead(401).end();
    });
    const registryURL = await listen(registryServer);
    registry = createNpmRegistry({ upstreamBase: upstreamURL, publicBase: registryURL + '/npm/' });
    // This fallback URL is supplied only by this fixture. Production always uses npmjs.org.
    const config = {
      registry: registryURL + '/npm/',
      key,
      ca: '',
      fallbackRegistry: upstreamURL + '/',
    };
    const yarnVersion = spawnSync('yarn', ['--version'], { encoding: 'utf8' });
    const yarnMajor = Number(yarnVersion.stdout?.trim().split('.')[0]);
    const clients = [
      { name: 'npm', command: 'npm', available: spawnSync('npm', ['--version']).status === 0 },
      { name: 'pnpm', command: 'pnpm', available: spawnSync('pnpm', ['--version']).status === 0 },
      { name: 'Yarn classic', command: 'yarn', available: yarnMajor === 1 },
      { name: 'Yarn Berry', command: 'yarn', available: yarnMajor >= 2 },
      { name: 'Bun', command: 'bun', available: spawnSync('bun', ['--version']).status === 0 },
    ];
    assert.equal(
      (
        await fetch(registryURL + '/npm/fixture-package', {
          method: 'PUT',
          headers: { Authorization: 'Bearer ' + key },
          body: '{}',
        })
      ).status,
      403,
    );
    for (const down of [false, true]) {
      if (down) await close(registryServer);
      for (const { name: client, command: binary, available } of clients)
        await t.test(
          `${client}: ${down ? 'stopped registry fallback' : 'registry'}`,
          { skip: !available },
          async () => {
            const assigned = config;
            const source = join(root, randomUUID());
            await mkdir(source);
            await exec('git', ['init', '--template=', source]);
            await writeFile(
              join(source, 'package.json'),
              JSON.stringify({
                name: 'install-test',
                version: '1.0.0',
                ...(client === 'Yarn Berry'
                  ? { packageManager: 'yarn@' + yarnVersion.stdout.trim() }
                  : {}),
                dependencies: { 'fixture-package': '1.0.0' },
              }),
            );
            const command =
              client === 'npm'
                ? `npm install --ignore-scripts --no-audit --no-fund --cache '${source}/npm-cache'`
                : client === 'pnpm'
                  ? `pnpm install --ignore-scripts --ignore-workspace --config.minimum-release-age=0 --config.manage-package-manager-versions=false --store-dir '${source}/pnpm-store'`
                  : client === 'Yarn Berry'
                    ? `YARN_UNSAFE_HTTP_WHITELIST=127.0.0.1 YARN_NODE_LINKER=node-modules yarn install --mode=skip-builds`
                    : client === 'Yarn classic'
                      ? `yarn install --ignore-scripts --non-interactive --cache-folder '${source}/yarn-cache'`
                      : `BUN_INSTALL_CACHE_DIR='${source}/bun-cache' ${binary} install --ignore-scripts`;
            const workerCredential = 'worker-secret-must-never-reach-a-job';
            process.env.DEPLOY_WORKER_TOKEN = workerCredential;
            let result: any,
              polled = false;
            const directory = join(root, randomUUID());
            const runner = new JobRunner(directory, async (action, body) => {
              if (action === 'packages') return assigned;
              if (action === 'poll' && !polled) {
                polled = true;
                return {
                  job: {
                    id: 'install',
                    generation: '1',
                    instanceId: 'fixture',
                    timeoutMs: 45000,
                    command: `${command} && node -e 'if (require("fixture-package") !== 42) process.exit(1); if (process.env.DEPLOY_WORKER_TOKEN) process.exit(2); console.log(process.env.NPM_CONFIG_USERCONFIG)' && cat "$NPM_CONFIG_USERCONFIG"`,
                  },
                  snapshot: captureSnapshot(source),
                };
              }
              if (action === 'complete') result = body;
              return {};
            });
            const before = registryHits;
            try {
              const deadline = Date.now() + 50000;
              while (!result && Date.now() < deadline) {
                await runner.tick();
                await new Promise((done) => setTimeout(done, 30));
              }
              assert.ok(result, 'job completed');
              assert.equal(
                result.status,
                'succeeded',
                `${client} down=${down}: ${result.output || result.error || result.status}`,
              );
              assert.ok(!result.output.includes(workerCredential));
              assert.ok(!result.output.includes(key));
              assert.equal(result.output.includes(registryFallback), down);
              if (!down) assert.ok(registryHits > before);
              assert.ok(
                !(await readdir(directory)).some((name) => name.startsWith('package-install-')),
              );
              assert.ok(!(await readFile(join(directory, 'job.json'), 'utf8')).includes(key));
            } finally {
              runner.shutdown();
              delete process.env.DEPLOY_WORKER_TOKEN;
            }
          },
        );
    }
    assert.ok(upstreamHits > 0);
  },
);

test('platform filtering, owner-isolated warming, pins, cleanup races and tombstones', async () => {
  assert.equal(
    matchesPlatforms({ os: ['linux'], cpu: ['arm64'] }, [{ os: 'darwin', cpu: 'arm64' }]),
    false,
  );
  assert.equal(
    matchesPlatforms({ os: ['!win32'], cpu: ['x64'] }, [{ os: 'linux', cpu: 'x64' }]),
    true,
  );
  const source = join(root, 'lock-project');
  await mkdir(source);
  await exec('git', ['init', '--template=', source]);
  await writeFile(
    join(source, 'pnpm-lock.yaml'),
    `lockfileVersion: '9.0'\npackages:\n  fixture-package@1.0.0: {}\n  irrelevant@1.0.0:\n    os: [nonexistent]\n    cpu: [nonexistent]\n`,
  );
  await exec('git', ['-C', source, 'add', '.']);
  await exec('git', [
    '-C',
    source,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'fixture',
  ]);
  const commit = (await exec('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
  const project = { id: 'own-project', name: 'My project', repositoryPath: source };
  save('project', 'build-owner', project);
  save('project', 'other-owner', { id: 'secret-project', name: 'Secret project' });
  await new CopyWarmer(registry.copy).scan('build-owner', project, commit);
  const status = copiesStatus('build-owner', registry.copy);
  assert.deepEqual(
    status.projects.map((p) => p.name),
    ['My project'],
  );
  assert.equal(status.projects[0].total, 1);
  assert.equal(status.projects[0].missing, 0);
  queueAllCopies();
  assert.equal(
    (workspace.prepare("SELECT COUNT(*) n FROM records WHERE kind='package-warm'").get() as any).n,
    2,
  );
  const database = getSqlite()!;
  database
    .prepare(
      "INSERT INTO package_pins VALUES('npm','@scope/rollback@2.0.0','own-project','previous','release')",
    )
    .run();
  database
    .prepare(
      "INSERT INTO package_pins VALUES('npm','@scope/rollback','own-project','previous','release')",
    )
    .run();
  assert.equal(copiesStatus('build-owner', registry.copy).projects[0].total, 2);
  assert.equal(copiesStatus('build-owner', registry.copy).projects[0].missing, 1);
  database.prepare("DELETE FROM package_pins WHERE release_id='previous'").run();
  const file = database
    .prepare("SELECT * FROM package_cache_entries WHERE key='fixture-package@1.0.0'")
    .get() as any;
  database
    .prepare("UPDATE package_cache_entries SET last_used_at='2000-01-01' WHERE kind='file'")
    .run();
  await cleanupCopies();
  assert.ok(await stat(objectPath('cache', file.sha256)));
  database.prepare("DELETE FROM package_pins WHERE project_id='own-project'").run();
  const handle = await registry.copy.openTarball('fixture-package', 'fixture-package-1.0.0.tgz');
  await cleanupCopies();
  assert.ok(await stat(objectPath('cache', file.sha256)), 'install touch prevents stale cleanup');
  await handle.handle.close();
  database
    .prepare(
      "UPDATE package_cache_entries SET removed_at='2026-11-02' WHERE key='fixture-package@1.0.0'",
    )
    .run();
  assert.equal(
    copiesStatus('build-owner', registry.copy).projects[0].removed[0].removedAt,
    '2026-11-02',
  );
  await assert.rejects(
    registry.copy.openTarball('fixture-package', 'fixture-package-1.0.0.tgz'),
    /removed from npmjs.org on 2026-11-02/,
  );
  database
    .prepare(
      "UPDATE package_cache_entries SET removed_at=NULL,last_used_at='2000-01-01' WHERE kind='file'",
    )
    .run();
  await cleanupCopies();
  assert.ok(
    await stat(objectPath('cache', file.sha256)),
    "a version main's lockfile needs is never cleaned up, even with no pin",
  );
  database.prepare('DELETE FROM package_project_requirements').run();
  await cleanupCopies();
  assert.equal(await stat(objectPath('cache', file.sha256)).catch(() => null), null);
});

test('failed lockfile reads cannot clear a previous pin snapshot', async () => {
  const { LockfileCache, readLockfile } = await import('./project-index.ts');
  const cache = new LockfileCache(async () => {
    throw new Error('Git operation timed out');
  });
  await assert.rejects(cache.read('unused', 'main', 'package-lock.json'), /timed out/);
  await assert.rejects(readLockfile('package-lock.json', '{broken'));
  await assert.rejects(readLockfile('pnpm-lock.yaml', 'packages: [broken'));
});

test('source requires two failures, and registry ping has a short deadline', async () => {
  const server = createServer((_req, res) => res.writeHead(503).end());
  const url = await listen(server);
  const copy = createNpmRegistry({ upstreamBase: url, publicBase: url + '/npm/' }).copy;
  try {
    await assert.rejects(copy.fetch('-/ping'));
    assert.equal(copy.reachable, true);
    await assert.rejects(copy.fetch('-/ping'));
    assert.equal(copy.reachable, false);
    assert.ok(copy.downSince);
    const hung = createServer(() => {});
    const origin = await listen(hung);
    const started = Date.now();
    assert.equal(await registryPing({ registry: origin + '/npm/', key, ca: '' }, 40), false);
    assert.ok(Date.now() - started < 1000);
  } finally {
    copy.close();
  }
});

test('old workers receive no package config; only a matching live job can request its install key', async () => {
  const { jobCommand, revokeWorker } = await import('../workspace/coordination.ts');
  save('worker', 'build-owner', {
    id: 'old-worker',
    instanceId: 'process',
    platform: 'linux',
    architecture: 'x64',
  });
  save('task', 'build-owner', { id: 'old-task', projectId: 'settings' });
  save('checkpoint', 'build-owner', { id: 'old-checkpoint', snapshot: { files: [] } });
  save('job', 'build-owner', {
    id: 'old-job',
    taskId: 'old-task',
    checkpointId: 'old-checkpoint',
    workerId: 'old-worker',
    status: 'running',
    instanceId: 'process',
    generation: 'generation',
  });
  const assignment = jobCommand('build-owner', 'old-worker', 'poll', { instanceId: 'process' });
  assert.equal(assignment.job.id, 'old-job');
  assert.equal(assignment.packages, undefined);
  assert.ok(!JSON.stringify(assignment).includes('dlp_'));
  assert.throws(
    () =>
      jobCommand('build-owner', 'old-worker', 'packages', {
        jobId: 'old-job',
        instanceId: 'process',
        generation: 'stale',
      }),
    /Stale/,
  );
  const publicConfig = await jobCommand('build-owner', 'old-worker', 'packages', {
    jobId: 'old-job',
    instanceId: 'process',
    generation: 'generation',
  });
  assert.equal(publicConfig.key, '');
  save('v2-project-policy', 'build-owner', { id: 'settings', installThroughDeploy: true });
  const config = await jobCommand('build-owner', 'old-worker', 'packages', {
    jobId: 'old-job',
    instanceId: 'process',
    generation: 'generation',
  });
  assert.match(config.key, /^dlp_/);
  revokeWorker('build-owner', 'old-worker');
  assert.equal(
    registryIdentity({ headers: { authorization: 'Bearer ' + config.key } } as any),
    null,
  );
});

test('pressure clears oldest unpinned files, preserves pinned overflow and respects retention settings', async () => {
  const { storageStatus } = await import('./copies.ts');
  const { storeFile } = await import('./store.ts');
  const { Readable } = await import('node:stream');
  const database = getSqlite()!;
  const files = [];
  for (const [key, text, used] of [
    ['old@1.0.0', 'old bytes', '2020-01-01'],
    ['pinned@1.0.0', 'pinned bytes', '2020-01-02'],
    ['new@1.0.0', 'new bytes', new Date().toISOString()],
  ]) {
    const bytes = Buffer.from(text);
    const file = await storeFile(
      Readable.from(bytes),
      'cache',
      'sha512-' + createHash('sha512').update(bytes).digest('base64'),
    );
    files.push(file);
    database
      .prepare(
        "INSERT INTO package_cache_entries(ecosystem,kind,key,sha256,size,fetched_at,last_used_at) VALUES('npm','file',?,?,?,?,?)",
      )
      .run(key, file.sha256, file.size, used, used);
  }
  database
    .prepare("INSERT INTO package_pins VALUES('npm','pinned@1.0.0','live','release','release')")
    .run();
  database
    .prepare("INSERT OR REPLACE INTO system_settings VALUES('packages.cache.limitBytes','1',?)")
    .run(new Date().toISOString());
  database
    .prepare("INSERT OR REPLACE INTO system_settings VALUES('packages.cache.days','30',?)")
    .run(new Date().toISOString());
  assert.equal(storageStatus().days, 30);
  assert.equal(storageStatus().pinnedOverLimit, true);
  await cleanupCopies();
  assert.equal(await stat(objectPath('cache', files[0].sha256)).catch(() => null), null);
  assert.ok(await stat(objectPath('cache', files[1].sha256)));
  assert.equal(storageStatus().pinnedOverLimit, true);
});

test('worker restart clears abandoned install configuration before accepting another job', async () => {
  const directory = join(root, 'restarted-worker');
  const stale = join(directory, 'package-install-abandoned');
  await mkdir(stale, { recursive: true });
  await writeFile(join(stale, 'npmrc'), 'secret', { mode: 0o600 });
  const runner = new JobRunner(directory, async () => ({ job: null }));
  try {
    await runner.tick();
    assert.equal(await stat(stale).catch(() => null), null);
  } finally {
    runner.shutdown();
  }
});

test('a queued job with no computer can not fail an install, and running jobs are pinned', async () => {
  const { pinComputerInstall } = await import('./copies.ts');
  save('job', 'build-owner', { id: 'queued-no-worker', status: 'queued', taskId: 'none' });
  save('job', 'build-owner', { id: 'broken-record', status: 'running' });
  assert.doesNotThrow(() => pinComputerInstall('build-owner', 'pin-computer', 'left-pad@1.3.0'));
  // Nor can bad data elsewhere: a release record with no release inside is skipped.
  save('v2-release', 'build-owner', { id: 'no-release-inside' });
  assert.doesNotThrow(() => pinComputerInstall('build-owner', 'pin-computer-2', 'left-pad@1.3.0'));
});
