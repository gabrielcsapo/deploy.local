import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'smol-toml';
import {
  cargoConfig,
  cargoMetadata,
  cargoPackage,
  updateCargoSetting,
  CRATES_IO_INDEX,
} from './cargo.mjs';
import { preparePackageInstall } from './package-install.mjs';
import { runPackages } from '../bin/packages.mjs';
const exec = promisify(execFile);

test('TOML settings preserve comments, quoted tables, unrelated settings and registries', () => {
  const input = '# keep\n[http]\ntimeout = 20\ncainfo = "old"\n[alias]\nb = "build"\n';
  const updated = updateCargoSetting(input, 'http', 'cainfo', '/new/ca');
  assert.match(updated, /# keep/);
  assert.deepEqual(JSON.parse(JSON.stringify(parse(updated))), {
    http: { timeout: 20, cainfo: '/new/ca' },
    alias: { b: 'build' },
  });
  const unusual = updateCargoSetting(
    '[registries."deploy-local"]\nindex="old"\n[registries.other]\ntoken="keep"\n',
    'registries.deploy-local',
    'index',
    'new',
  );
  assert.equal(parse(unusual).registries.other.token, 'keep');
  assert.equal(parse(unusual).registries['deploy-local'].index, 'new');
});

test('CLI trust/login preserve Cargo settings; use writes no keys and off keeps unrelated config', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cargo-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'),
    cwd = join(root, 'project');
  await mkdir(join(home, '.cargo'), { recursive: true });
  await mkdir(join(cwd, '.cargo'), { recursive: true });
  await writeFile(
    join(home, '.cargo/config.toml'),
    '# keep\n[http]\ntimeout=20\n[alias]\nb="build"\n',
  );
  await writeFile(
    join(home, '.cargo/credentials.toml'),
    '[registries.other]\ntoken="other-secret"\n',
  );
  await writeFile(join(cwd, '.cargo/config.toml'), '[build]\njobs=2\n');
  const key = 'dlp_' + 'a'.repeat(43);
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----'),
  );
  const context = {
    serverUrl: 'https://deploy.local',
    config: { username: 'owner', token: 'session' },
    home,
    cwd,
    print() {},
    api: async () => ({ key, label: 'test' }),
    prompt: async () => '',
  };
  await runPackages(
    ['trust'],
    {},
    {
      ...context,
      config: {},
      api() {
        throw Error('trust must not mint a key');
      },
    },
  );
  const trusted = parse(await readFile(join(home, '.cargo/config.toml'), 'utf8'));
  assert.deepEqual(JSON.parse(JSON.stringify(trusted)), {
    http: { timeout: 20, cainfo: join(home, '.deploy/packages/ca.crt') },
    alias: { b: 'build' },
  });
  await runPackages(['login'], {}, context);
  const settings = parse(await readFile(join(home, '.cargo/config.toml'), 'utf8'));
  assert.deepEqual(settings.http, trusted.http);
  assert.deepEqual(settings.alias, trusted.alias);
  assert.equal(
    settings.registries['deploy-local'].index,
    'sparse+https://deploy.local/cargo/index/',
  );
  const credentials = parse(await readFile(join(home, '.cargo/credentials.toml'), 'utf8'));
  assert.equal(credentials.registries.other.token, 'other-secret');
  assert.equal(credentials.registries['deploy-local'].token, key);
  assert.equal((await stat(join(home, '.cargo/credentials.toml'))).mode & 0o777, 0o600);
  for (let i = 0; i < 2; i++) await runPackages(['use'], {}, context);
  const project = await readFile(join(cwd, '.cargo/config.toml'), 'utf8');
  assert.ok(!project.includes(key));
  assert.ok(!project.includes('session'));
  assert.equal(parse(project).source['crates-io']['replace-with'], 'deploy-local-crates-io');
  assert.equal(parse(project).build.jobs, 2);
  assert.deepEqual(await readdir(join(cwd, '.cargo')), ['config.toml']);
  await runPackages(['use'], { off: true }, context);
  assert.equal(await readFile(join(cwd, '.cargo/config.toml'), 'utf8'), '[build]\njobs=2\n');
});

test('workers retain Cargo cache and mount anonymous config and CA for Rust containers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cargo-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    registry: 'https://deploy.local/npm/',
    key: 'dlp_' + 'b'.repeat(43),
    ca: 'certificate',
    address: 'host-gateway',
  };
  const npmOnly = await preparePackageInstall(config, { cwd: root, root, ping: async () => true });
  assert.equal(npmOnly.env.CARGO_HOME, undefined);
  await npmOnly.cleanup();
  await writeFile(join(root, 'Cargo.toml'), '[package]\nname = "app"\nversion = "0.1.0"\n');
  const install = await preparePackageInstall(config, { cwd: root, root, ping: async () => true });
  assert.equal(install.env.CARGO_HOME, join(root, 'cargo-home'));
  const settings = parse(await readFile(join(install.env.CARGO_HOME, 'config.toml'), 'utf8'));
  assert.equal(settings.http.cainfo, join(root, 'cargo-home/ca.crt'));
  await writeFile(join(install.env.CARGO_HOME, 'kept'), 'cache');
  await install.cleanup();
  const container = await preparePackageInstall(config, {
    cwd: root,
    root,
    container: true,
    ping: async () => true,
  });
  assert.equal(container.env.CARGO_HOME, '/run/deploy-cargo');
  assert.ok(container.args.includes('deploy.local:host-gateway'));
  assert.ok(container.args.includes(`${root}/cargo-home:/run/deploy-cargo`));
  const text = await readFile(container.cargoConfig, 'utf8');
  assert.ok(!text.includes('dlp_'));
  assert.equal(container.env.CARGO_REGISTRIES_DEPLOY_LOCAL_TOKEN, undefined);
  assert.equal(parse(text).http.cainfo, '/run/deploy-packages/ca.crt');
  await container.cleanup();
  assert.equal(await readFile(join(root, 'cargo-home/kept'), 'utf8'), 'cache');
  await writeFile(join(root, '.npmrc'), 'registry=https://example.invalid/\n');
  const mixed = await preparePackageInstall(config, { cwd: root, root, ping: async () => true });
  assert.ok(mixed.env.CARGO_HOME);
  assert.equal(mixed.env.NPM_CONFIG_USERCONFIG, undefined);
  await mixed.cleanup();
});

test('normalized Cargo manifests retain aliases, targets, features and registry identities', () => {
  const metadata = cargoMetadata(
    `[package]\nname="test"\nversion="1.0.0"\nrust-version="1.70"\n[features]\nfeature=["dep:alias"]\n[dependencies.alias]\npackage="original"\nversion="1"\noptional=true\n[dependencies.private]\nversion="2"\nregistry-index="sparse+https://deploy.local/cargo/index/"\n[target.'cfg(unix)'.build-dependencies]\nbuilder="3"\n`,
    'sparse+https://deploy.local/cargo/index/',
  );
  assert.equal(metadata.deps[0].name, 'original');
  assert.equal(metadata.deps[0].explicit_name_in_toml, 'alias');
  assert.equal(metadata.deps[0].registry, CRATES_IO_INDEX);
  assert.equal(metadata.deps[1].registry, null);
  assert.equal(metadata.deps[2].target, 'cfg(unix)');
  assert.equal(metadata.deps[2].kind, 'build');
  assert.equal(metadata.rust_version, '1.70');
  assert.equal(
    cargoPackage('[package]\nname="test"\nversion.workspace=true', { version: '2.0.0' }).version,
    '2.0.0',
  );
});

test(
  'real cargo package is uploaded by the CLI as Cargo binary framing',
  { skip: spawnSync('cargo', ['--version']).status !== 0, timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'cargo-cli-publish-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, 'home'),
      cwd = join(root, 'crate');
    await mkdir(home);
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(
      join(cwd, 'Cargo.toml'),
      '[package]\nname="cli_fixture"\nversion="1.0.0"\nedition="2021"\n',
    );
    await writeFile(join(cwd, 'src/lib.rs'), 'pub fn value() -> u32 { 1 }');
    await writeFile(join(home, '.npmrc'), '//127.0.0.1:1234/npm/:_authToken=dlp_test\n');
    let uploaded = false;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(String(url), 'http://127.0.0.1:1234/cargo/api/v1/crates/new');
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      const body = Buffer.concat(chunks),
        length = body.readUInt32LE();
      const metadata = JSON.parse(body.subarray(4, 4 + length));
      assert.equal(metadata.name, 'cli_fixture');
      assert.equal(metadata.vers, '1.0.0');
      const size = body.readUInt32LE(4 + length);
      assert.equal(body.length, size + length + 8);
      const file = join(root, 'packed.crate');
      await writeFile(file, body.subarray(8 + length));
      const result = await exec('tar', ['-xOf', file, 'cli_fixture-1.0.0/Cargo.toml']);
      assert.equal(parse(result.stdout).package.version, '1.0.0');
      uploaded = true;
      return new Response(
        JSON.stringify({ warnings: { invalid_categories: [], invalid_badges: [], other: [] } }),
      );
    });
    // No dependencies: a real local package/build needs no index or network access.
    await mkdir(join(home, '.cargo'));
    await writeFile(
      join(home, '.cargo/config.toml'),
      cargoConfig('http://127.0.0.1:1234') + '\n[net]\noffline=true\n',
    );
    await runPackages(
      ['publish'],
      {},
      { serverUrl: 'http://127.0.0.1:1234', home, cwd, config: {}, print() {} },
    );
    assert.equal(uploaded, true);
  },
);

test('Rust app builds receive Cargo and CA secrets when npm has its own registry', async (t) => {
  const { registryBuildDocker } = await import('../server/package-build.ts');
  const { shellEnvironment } = await import('../server/workspace/shell-environment.ts');
  assert.equal(
    shellEnvironment({ CARGO_REGISTRIES_DEPLOY_LOCAL_TOKEN: 'publish-secret' })
      .CARGO_REGISTRIES_DEPLOY_LOCAL_TOKEN,
    undefined,
  );
  const root = await mkdtemp(join(tmpdir(), 'cargo-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.npmrc'), 'registry=https://example.invalid/\n');
  await writeFile(join(root, 'Cargo.toml'), '[package]\nname = "app"\nversion = "0.1.0"\n');
  let built = false;
  const docker = registryBuildDocker(
    {
      async run(args) {
        if (args.includes('version')) return { exitCode: 0, stdout: '', stderr: '' };
        if (args.includes('--help')) return { exitCode: 0, stdout: '--secret', stderr: '' };
        const cargo = args.find((arg) => arg.startsWith('id=cargo,src='));
        const ca = args.find((arg) => arg.startsWith('id=ca,src='));
        assert.ok(cargo && ca);
        assert.ok(!args.some((arg) => arg.startsWith('id=npmrc,')));
        const doc = parse(await readFile(cargo.slice('id=cargo,src='.length), 'utf8'));
        assert.equal(doc.source['crates-io']['replace-with'], 'deploy-local-crates-io');
        assert.equal(doc.http.cainfo, '/run/deploy-packages/ca.crt');
        assert.equal(await readFile(ca.slice('id=ca,src='.length), 'utf8'), 'certificate');
        assert.ok(args.includes('deploy.local:host-gateway'));
        built = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
    {
      root,
      config: async () => ({
        registry: 'https://deploy.local/npm/',
        key: 'dlp_test',
        ca: 'certificate',
        address: 'host-gateway',
      }),
      ping: async () => true,
      log() {},
    },
  );
  await docker.run(['build', root]);
  assert.equal(built, true);
});
