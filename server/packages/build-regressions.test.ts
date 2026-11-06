import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { preparePackageInstall, secretOutput } from '../../shared/package-install.mjs';
const root = await mkdtemp(join(tmpdir(), 'build-regressions-'));
process.env.DEPLOY_DATA_DIR = root;
const { nodeDockerfile, buildRegistryArgs, imageBuildArguments } = await import('../docker.ts');
const exec = promisify(execFile);
const key = 'dlp_' + 'x'.repeat(43);
after(async () => {
  const { _resetDb } = await import('../store.ts');
  const { db } = await import('../workspace/store.ts');
  _resetDb();
  db.close();
  await rm(root, { recursive: true, force: true });
});

test('exact build argument lists for docker, docker-container and failed gateway inspection', async () => {
  const install = { npmrc: '/private/npmrc', ca: '/private/ca', key };
  const args = (registryArgs: string[]) =>
    imageBuildArguments({
      tag: 'app',
      cacheDir: '/cache',
      noCache: false,
      useBuildx: true,
      cacheExists: true,
      registryArgs,
    });
  const prefix = [
    'buildx',
    'build',
    '--builder',
    'deploy-local',
    '--load',
    '--cache-from',
    'type=local,src=/cache',
    '--cache-to',
    'type=local,dest=/cache,mode=max',
  ];
  const secrets = ['--secret', 'id=npmrc,src=/private/npmrc', '--secret', 'id=ca,src=/private/ca'];
  assert.deepEqual(
    args(
      await buildRegistryArgs('docker', install, async () => {
        throw Error('must not inspect');
      }),
    ),
    [...prefix, ...secrets, '--add-host', 'deploy.local:host-gateway', '-t', 'app', '.'],
  );
  assert.deepEqual(
    args(
      await buildRegistryArgs(
        'docker-container',
        install,
        async () =>
          ({ stdout: JSON.stringify([{ IPAM: { Config: [{ Gateway: '172.17.0.1' }] } }]) }) as any,
      ),
    ),
    [...prefix, ...secrets, '--add-host', 'deploy.local:172.17.0.1', '-t', 'app', '.'],
  );
  for (const inspect of [
    async () => {
      throw Error('timeout');
    },
    async () => ({ stdout: '[]' }),
    async () => ({ stdout: 'invalid' }),
    async () => ({ stdout: '[{"IPAM":{"Config":[{"Gateway":"host-gateway"}]}}]' }),
  ])
    assert.deepEqual(args(await buildRegistryArgs('docker-container', install, inspect as any)), [
      ...prefix,
      '-t',
      'app',
      '.',
    ]);
  assert.deepEqual(
    imageBuildArguments({
      tag: 'app',
      cacheDir: '/cache',
      noCache: true,
      useBuildx: false,
      cacheExists: false,
      registryArgs: [],
    }),
    ['build', '--no-cache', '-t', 'app', '.'],
  );
});

test('gateway inspection is asynchronous and bounded with the exact Docker command', async () => {
  const bin = join(root, 'docker-bin');
  await mkdir(bin);
  const call = join(root, 'docker-call');
  await writeFile(
    join(bin, 'docker'),
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${call}'\nexec sleep 10\n`,
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  process.env.PATH = bin + ':' + path;
  let ticks = 0;
  const timer = setInterval(() => ticks++, 20);
  const before = Date.now();
  try {
    assert.deepEqual(
      await buildRegistryArgs('docker-container', { npmrc: 'npmrc', ca: 'ca', key }),
      [],
    );
    assert.ok(Date.now() - before < 6000);
    assert.ok(ticks > 10, 'event loop remains available');
    assert.equal(await readFile(call, 'utf8'), 'network\ninspect\nbridge\n');
  } finally {
    process.env.PATH = path;
    clearInterval(timer);
  }
});

test('generated install shell succeeds, retries without config, and preserves final failure for every package manager', async () => {
  const dockerfile = nodeDockerfile();
  assert.equal(
    dockerfile.split('\n').find((line) => line.startsWith('COPY ')),
    'COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./',
  );
  const original = dockerfile
    .slice(dockerfile.indexOf('RUN ') + 4, dockerfile.indexOf('\nCOPY . .'))
    .replace(/\\\n/g, '\n')
    .replace(/--mount=\S+\s*/g, '');
  for (const [manager, lock] of [
    ['npm', ''],
    ['npm', 'package-lock.json'],
    ['pnpm', 'pnpm-lock.yaml'],
    ['yarn', 'yarn.lock'],
  ]) {
    for (const outcome of ['success', 'fallback', 'both-fail', 'no-config']) {
      const cwd = await mkdtemp(join(root, 'shell-'));
      const bin = join(cwd, 'bin');
      await mkdir(bin);
      const config = join(cwd, 'registry');
      await mkdir(config);
      if (outcome !== 'no-config')
        await writeFile(
          join(config, 'npmrc'),
          `registry=https://deploy.local/npm/\n//deploy.local/npm/:_authToken=${key}\n`,
        );
      await writeFile(join(config, 'ca.crt'), 'test CA');
      await writeFile(join(cwd, 'package.json'), '{"packageManager":"yarn@4.0.0"}');
      if (lock) await writeFile(join(cwd, lock), manager === 'yarn' ? '__metadata:\n' : '');
      await writeFile(join(bin, 'corepack'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await writeFile(
        join(bin, manager),
        `#!/bin/sh
printf '%s|%s|%s|%s|%s|%s\\n' "$*" "$NPM_CONFIG_USERCONFIG" "$YARN_NPM_REGISTRY_SERVER" "$YARN_NPM_AUTH_TOKEN" "$YARN_NPM_ALWAYS_AUTH" "$YARN_HTTPS_CA_FILE_PATH" >> calls
if [ "$OUTCOME" = both-fail ]; then exit 7; fi
if [ "$OUTCOME" = fallback ] && [ -n "$NPM_CONFIG_USERCONFIG" ]; then exit 8; fi
exit 0
`,
        { mode: 0o755 },
      );
      const result = await exec('sh', ['-c', original.replaceAll('/run/deploy-packages', config)], {
        cwd,
        env: { PATH: bin + ':' + process.env.PATH, OUTCOME: outcome },
      }).then(
        (r) => ({ ...r, code: 0 }),
        (e) => e,
      );
      assert.equal(
        result.code,
        outcome === 'both-fail' ? 7 : 0,
        `${manager} ${outcome}: ${result.stderr}`,
      );
      const calls = (await readFile(join(cwd, 'calls'), 'utf8')).trim().split('\n');
      assert.equal(calls.length, ['fallback', 'both-fail'].includes(outcome) ? 2 : 1);
      if (outcome !== 'no-config')
        assert.ok(calls[0].includes(key), 'Berry configuration is environment-only');
      if (calls.length === 2 || outcome === 'no-config') assert.match(calls.at(-1)!, /\|\|\|\|\|$/);
      assert.equal(
        (result.stdout.match(/retrying without registry configuration/g) || []).length,
        calls.length === 2 ? 1 : 0,
      );
    }
  }
});

test('host configs retain scoped user credentials, override registry and CA, and never copy them into containers', async () => {
  const cwd = join(root, 'personal');
  await mkdir(cwd);
  const personal =
    'registry=https://personal.invalid/\ncafile=/personal/ca\n@scope:registry=https://scope.invalid/\n//scope.invalid/:_authToken=scope-token\nalways-auth=true\n';
  await writeFile(join(cwd, '.npmrc'), personal);
  const project = join(cwd, 'project');
  await mkdir(project);
  const custom = join(cwd, 'custom');
  await writeFile(custom, personal.replace('scope-token', 'custom-token'));
  for (const configured of [false, true])
    for (const container of [false, true]) {
      const prepared = await preparePackageInstall(
        { registry: 'https://deploy.local/npm/', key, ca: 'CA', address: '192.0.2.1' },
        {
          cwd: project,
          root,
          container,
          ping: async () => true,
          environment: { HOME: cwd, ...(configured ? { NPM_CONFIG_USERCONFIG: custom } : {}) },
        },
      );
      try {
        const content = await readFile(prepared.npmrc!, 'utf8');
        assert.match(content, /^registry=https:\/\/deploy.local\/npm\//m);
        assert.doesNotMatch(content, /personal.invalid|\/personal\/ca/);
        assert.equal(content.includes('@scope:registry=https://scope.invalid/'), !container);
        assert.equal(content.includes(configured ? 'custom-token' : 'scope-token'), !container);
        assert.equal((await stat(prepared.npmrc!)).mode & 0o777, 0o600);
      } finally {
        await prepared.cleanup();
      }
    }
});

test('redaction retains public prefix suffixes and hides incomplete secret material', () => {
  for (const suffix of ['d', 'dl', 'dlp', 'dlp_', 'dlp_x', key.slice(0, 25), key]) {
    let text = '';
    const output = secretOutput([key], (chunk) => {
      text += chunk;
    });
    output.write('end ' + suffix);
    output.end();
    assert.equal(text, 'end ' + (suffix.length <= 4 ? suffix : '[redacted]'));
  }
});
