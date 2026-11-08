import { registryBuildDocker } from '../package-build.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
const root = await mkdtemp(join(tmpdir(), 'app-build-registry-'));
process.env.DEPLOY_DATA_DIR = root;
const { buildImage } = await import('../docker.ts');
const { setPackageHooks } = await import('../workspace/package-hooks.ts');
const key = 'dlp_test_install_only_credential';
process.env.DEPLOY_MDNS_ADDRESS = '127.0.0.1';
const registry = createServer((_req, res) => {
  res.writeHead(200);
  res.end('{}');
});
await new Promise<void>((done) => registry.listen(5301, '127.0.0.1', done));
const config = { registry: 'http://127.0.0.1:5301/npm/', key, ca: '', address: '192.0.2.19' };
const bin = join(root, 'bin');
await mkdir(bin);
const calls = join(root, 'calls.json');
await writeFile(
  join(bin, 'docker'),
  `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'buildx' && args[1] === 'version') process.exit(0);
if (args.includes('--help')) { console.log(fs.readFileSync(${JSON.stringify(join(root, 'capability'))}, 'utf8') === 'supported' ? '--secret' : ''); process.exit(0); }
if (args[0] === 'buildx' && args[1] === 'inspect') { console.log('docker-container'); process.exit(0); }
if (args[0] === 'network') { console.log('[{"IPAM":{"Config":[{"Gateway":"172.17.0.1"}]}}]'); process.exit(0); }
if (args.includes('--secret') && fs.existsSync(${JSON.stringify(join(root, 'reject-secret'))})) { console.error('unknown flag: --secret'); process.exit(1); }
const secrets = args.filter(a => a.startsWith('id=')).map(a => fs.readFileSync(a.split(',src=')[1], 'utf8'));
fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify({args, secrets}));
const token = secrets.join('').match(/_authToken=(.+)/)?.[1];
if (token) { process.stdout.write(token.slice(0, 9)); process.stdout.write(token.slice(9)); }
console.log('built');
`,
  { mode: 0o755 },
);
const previousPath = process.env.PATH;
process.env.PATH = bin + ':' + previousPath;
after(async () => {
  registry.close();
  process.env.PATH = previousPath;
  const { _resetDb } = await import('../store.ts');
  const { db } = await import('../workspace/store.ts');
  _resetDb();
  db.close();
  await rm(root, { recursive: true, force: true });
});

for (const mounts of [true, false])
  test(`project Dockerfile ${mounts ? 'with' : 'without'} mounts receives scoped secrets without edits or leaked output`, async () => {
    const cwd = await mkdtemp(join(root, 'project-'));
    const dockerfile = mounts
      ? 'FROM node:22\nRUN --mount=type=secret,id=npmrc npm ci\n'
      : 'FROM scratch\nCOPY package.json /package.json\n';
    await writeFile(join(cwd, 'Dockerfile'), dockerfile);
    const requested: unknown[][] = [];
    setPackageHooks({
      installConfig: async (...args) => {
        requested.push(args);
        return config;
      },
      revokeComputer() {},
      finishJob() {},
    });
    let output = '';
    const result = await buildImage(
      'custom',
      cwd,
      (line) => {
        output += line;
      },
      { owner: 'alice', projectId: 'project' },
    );
    assert.equal(result.success, true);
    assert.deepEqual(requested, [['alice', 'local', 'project']]);
    const built = JSON.parse(await readFile(calls, 'utf8'));
    assert.ok(built.args.includes('--secret'));
    assert.ok(built.args.includes('deploy.local:172.17.0.1'));
    assert.ok(built.secrets.some((text: string) => text.includes(key)));
    assert.equal(await readFile(join(cwd, 'Dockerfile'), 'utf8'), dockerfile);
    assert.doesNotMatch(output + result.output, new RegExp(key));
    assert.deepEqual(await readdir(join(root, 'packages/tmp')), []);
  });

for (const capability of ['supported', 'no-buildx', 'no-secrets'])
  test(`remote build requests install key, redacts output and cleans up (${capability})`, async () => {
    const cwd = await mkdtemp(join(root, 'remote-'));
    const commands: string[][] = [];
    const requests: string[] = [];
    let output = '';
    const log: string[] = [];
    const docker = {
      async run(args: string[], options: any = {}) {
        commands.push([...args]);
        if (args[1] === 'version')
          return { exitCode: capability === 'no-buildx' ? 1 : 0, stdout: '', stderr: '' };
        if (args.includes('--help'))
          return {
            exitCode: 0,
            stdout: capability === 'no-secrets' ? '' : '--secret stringArray',
            stderr: '',
          };
        for (const arg of args.filter((a) => a.startsWith('id='))) {
          const path = arg.split(',src=')[1];
          assert.equal((await stat(path)).mode & 0o777, 0o600);
          if (arg.startsWith('id=npmrc'))
            assert.match(await readFile(path, 'utf8'), new RegExp(key));
        }
        options.onOutput?.(key.slice(0, 8));
        options.onOutput?.(key.slice(8));
        return { exitCode: 0, stdout: key, stderr: key };
      },
    };
    const wrapped = registryBuildDocker(docker, {
      root: join(cwd, 'tmp'),
      config: async () => {
        requests.push('computer-key');
        return config;
      },
      ping: async () => true,
      log: (line: string) => log.push(line),
    });
    const original = ['build', '--tag', 'app', '--target', 'web', cwd];
    const result = await wrapped.run(original, {
      onOutput: (s: string) => {
        output += s;
      },
    });
    const built = commands.at(-1)!;
    if (capability === 'supported') {
      assert.deepEqual(requests, ['computer-key']);
      assert.deepEqual(built.slice(0, 3), ['buildx', 'build', '--load']);
      assert.ok(built.includes('deploy.local:192.0.2.19'));
      assert.equal(built.filter((a) => a.startsWith('id=')).length, 2);
      assert.doesNotMatch(output + result.stdout + result.stderr, new RegExp(key));
      assert.deepEqual(await readdir(join(cwd, 'tmp')), []);
      assert.deepEqual(log, []);
    } else {
      assert.deepEqual(built, original);
      assert.equal(log.length, 1);
      assert.match(log[0], /registry.*not available/i);
      assert.deepEqual(requests, []);
    }
  });

test('legacy remote builder requests its install config and uses the host-resolved address', async () => {
  const cwd = await mkdtemp(join(root, 'legacy-remote-'));
  await writeFile(join(cwd, 'Dockerfile'), 'FROM scratch\n');
  let requested = 0;
  await writeFile(join(root, 'capability'), 'supported');
  const result = await buildImage('remote', cwd, undefined, {
    remoteRegistry: true,
    installConfig: async () => {
      requested++;
      return config;
    },
  });
  assert.equal(result.success, true);
  assert.equal(requested, 1);
  const built = JSON.parse(await readFile(calls, 'utf8'));
  assert.ok(built.args.includes('deploy.local:192.0.2.19'));
  assert.equal(built.args.filter((arg: string) => arg.startsWith('id=')).length, 2);
});

test('legacy remote builder without secret support preserves the existing Docker command and logs once', async () => {
  const cwd = await mkdtemp(join(root, 'legacy-no-secrets-'));
  await writeFile(join(cwd, 'Dockerfile'), 'FROM scratch\n');
  await writeFile(join(root, 'capability'), 'unsupported');
  let requested = 0;
  const output: string[] = [];
  const result = await buildImage('remote', cwd, (line) => output.push(line), {
    remoteRegistry: true,
    installConfig: async () => {
      requested++;
      return config;
    },
  });
  assert.equal(result.success, true);
  assert.equal(requested, 0);
  const built = JSON.parse(await readFile(calls, 'utf8'));
  assert.deepEqual(built.args.slice(0, 6), [
    'buildx',
    'build',
    '--builder',
    'deploy-local',
    '--load',
    '--cache-to',
  ]);
  assert.equal(built.args.includes('--secret'), false);
  assert.equal(output.filter((line) => line.includes('registry was not available')).length, 1);
});

test('remote Docker rejecting --secret falls back once without exposing a credential or retrying install failures', async () => {
  for (const unsupported of [true, false]) {
    const cwd = await mkdtemp(join(root, 'reject-secret-'));
    const commands: string[][] = [];
    const logs: string[] = [];
    const docker = registryBuildDocker(
      {
        async run(args, options = {}) {
          commands.push([...args]);
          if (args[1] === 'version') return { exitCode: 0, stdout: '', stderr: '' };
          if (args.includes('--help')) return { exitCode: 0, stdout: '--secret', stderr: '' };
          if (args[0] === 'buildx') {
            options.onOutput?.(key);
            return {
              exitCode: 1,
              stdout: key,
              stderr: unsupported ? 'unknown flag: --secret' : 'package install failed: ' + key,
            };
          }
          return { exitCode: 0, stdout: 'built', stderr: '' };
        },
      },
      {
        root: join(cwd, 'tmp'),
        config: async () => config,
        ping: async () => true,
        log: (line) => logs.push(line),
      },
    );
    let output = '';
    const result = await docker.run(['build', '--tag', 'app', cwd], {
      onOutput: (text) => {
        output += text;
      },
    });
    assert.equal(result.exitCode, unsupported ? 0 : 1);
    assert.equal(commands.filter((args) => args[0] === 'build').length, unsupported ? 1 : 0);
    assert.equal(logs.length, unsupported ? 1 : 0);
    assert.doesNotMatch(result.stdout + result.stderr + output, new RegExp(key));
    assert.deepEqual(await readdir(join(cwd, 'tmp')), []);
  }
});

test('coordinator graph builds request scoped configuration and pass secrets with the Docker bridge gateway', async () => {
  const { DockerCliGraphAdapter } = await import('../graph-docker-adapter.ts');
  const cwd = await mkdtemp(join(root, 'coordinator-graph-'));
  await writeFile(join(cwd, 'Dockerfile'), 'FROM scratch\n');
  await writeFile(join(root, 'capability'), 'supported');
  const requested: string[][] = [];
  setPackageHooks({
    installConfig: async () => null,
    applicationInstallConfig: async (...args) => {
      requested.push(args);
      return config;
    },
    revokeComputer() {},
    finishJob() {},
  });
  await new DockerCliGraphAdapter().prepareImage({
    applicationId: 'forma-id',
    component: 'web',
    releaseDigest: 'sha256:' + '1'.repeat(64),
    source: { kind: 'build', context: '.', dockerfile: 'Dockerfile', ignore: [] },
    projectDirectory: cwd,
    forceBuild: true,
  });
  assert.deepEqual(requested, [['forma-id', 'local']]);
  const built = JSON.parse(await readFile(calls, 'utf8'));
  assert.ok(built.args.includes('deploy.local:172.17.0.1'));
  assert.equal(built.args.filter((arg: string) => arg.startsWith('id=')).length, 2);
});

test('legacy remote builder falls back if Docker rejects secrets at build time', async () => {
  const cwd = await mkdtemp(join(root, 'legacy-rejected-'));
  await writeFile(join(cwd, 'Dockerfile'), 'FROM scratch\n');
  await writeFile(join(root, 'capability'), 'supported');
  await writeFile(join(root, 'reject-secret'), '1');
  const logs: string[] = [];
  try {
    const result = await buildImage('remote', cwd, (line) => logs.push(line), {
      remoteRegistry: true,
      installConfig: async () => config,
    });
    assert.equal(result.success, true);
    const built = JSON.parse(await readFile(calls, 'utf8'));
    assert.equal(built.args.includes('--secret'), false);
    assert.equal(logs.filter((line) => line.includes('registry was not available')).length, 1);
    assert.deepEqual(await readdir(join(root, 'packages/tmp')), []);
  } finally {
    await rm(join(root, 'reject-secret'));
  }
});
