import { routeFetch } from '../v2/test-request.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'cargo-registry-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_MDNS_ADDRESS = '127.0.0.1';
await import('../test-backups.ts');
const { registerUser, getSqlite, _resetDb } = await import('../store.ts');
const { db: workspace } = await import('../workspace/store.ts');
const { createKey } = await import('./keys.ts');
const { createCargoRegistry } = await import('./cargo.ts');
const { indexPath } = await import('./cargo-copy.ts');
const { cargoConfig } = await import('../../shared/cargo.mjs');
registerUser('cargo-owner', 'test-password-long');
registerUser('cargo-other', 'test-password-long');
const key = createKey('cargo-owner', 'cargo', 'publish').key;
const other = createKey('cargo-other', 'cargo', 'publish').key;
const install = createKey('cargo-owner', 'cargo', 'install').key;
const upstreamFiles = new Map<string, Buffer>();
let down = false,
  hits = 0;
const upstream = createServer((req, res) => {
  hits++;
  if (down) return res.writeHead(503).end();
  const bytes = upstreamFiles.get(req.url!);
  if (!bytes) return res.writeHead(404).end();
  const etag = '"' + createHash('sha256').update(bytes).digest('hex') + '"';
  if (req.headers['if-none-match'] === etag) return res.writeHead(304).end();
  res.setHeader('ETag', etag);
  res.end(bytes);
});
const inProcess = process.env.DEPLOY_CARGO_TEST_IN_PROCESS === '1';
if (!inProcess)
  await new Promise<void>((done, reject) =>
    upstream.once('error', reject).listen(0, '127.0.0.1', done),
  );
const upstreamBase = `http://127.0.0.1:${(upstream.address() as any)?.port || 12345}/`;
const registry = createCargoRegistry({
  upstreamBase,
  downloadBase: upstreamBase,
  revalidateMs: 0,
  timeoutMs: 1000,
});
const server = createServer((req, res) => {
  void registry.handle(req, res);
});
if (!inProcess)
  await new Promise<void>((done, reject) =>
    server.once('error', reject).listen(0, '127.0.0.1', done),
  );
const origin = `http://127.0.0.1:${(server.address() as any)?.port || 12346}`;
const originalFetch = globalThis.fetch;
const localFetch = inProcess ? routeFetch(registry.handle) : originalFetch;
if (inProcess) {
  const upstreamFetch = routeFetch(async (req, res) => {
    upstream.emit('request', req, res);
  });
  globalThis.fetch = ((url: any, options: any) =>
    upstreamFetch(String(url), options)) as typeof fetch;
}
after(async () => {
  globalThis.fetch = originalFetch;
  registry.copy.close();
  for (const s of [server, upstream]) {
    s.closeAllConnections();
    await new Promise<void>((done) => s.close(() => done()));
  }
  workspace.close();
  _resetDb();
  await rm(root, { recursive: true, force: true });
});
const checksum = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function body(name: string, version = '1.0.0', bytes = Buffer.from('test crate'), extra = {}) {
  const json = Buffer.from(
    JSON.stringify({ name, vers: version, deps: [], features: {}, ...extra }),
  );
  const a = Buffer.alloc(4),
    b = Buffer.alloc(4);
  a.writeUInt32LE(json.length);
  b.writeUInt32LE(bytes.length);
  return Buffer.concat([a, json, b, bytes]);
}
const request = (path: string, method = 'GET', token?: string, bytes?: Buffer) =>
  localFetch(origin + '/cargo/' + path, {
    method,
    headers: token ? { Authorization: token } : {},
    body: bytes as any,
  });
const publish = (name: string, token = key, extra = {}) =>
  request('api/v1/crates/new', 'PUT', token, body(name, '1.0.0', undefined, extra));

test('Cargo config, binary framing, all sparse paths, auth, immutable versions and yank', async () => {
  assert.deepEqual(await (await request('index/config.json')).json(), {
    dl: origin + '/cargo/api/v1/crates',
    api: origin + '/cargo',
  });
  assert.deepEqual(await (await request('crates-io/config.json')).json(), {
    dl: origin + '/cargo/crates-io/api/v1/crates',
  });
  const anonymous = await publish('anon', '');
  assert.equal(anonymous.status, 401);
  assert.match((await anonymous.json()).errors[0].detail, /deploy packages login/);
  assert.equal((await publish('readonly', install)).status, 403);
  assert.equal((await request('api/v1/crates/new', 'PUT', key, Buffer.from([0, 1]))).status, 422);
  const malformed = body('malformed');
  malformed.writeUInt32LE(0, malformed.length - 14);
  assert.equal((await request('api/v1/crates/new', 'PUT', key, malformed)).status, 422);
  for (const [name, path] of [
    ['a', '1/a'],
    ['ab', '2/ab'],
    ['abc', '3/a/abc'],
    ['Abcd', 'ab/cd/abcd'],
  ]) {
    assert.equal(indexPath(name), path);
    assert.equal((await publish(name, 'Bearer ' + key)).status, 200);
    const line = JSON.parse(await (await request('index/' + path)).text());
    assert.equal(line.name, name);
    assert.equal(line.cksum, checksum(Buffer.from('test crate')));
    assert.equal(line.yanked, false);
    assert.equal((await request('index/wrong/' + name)).status, 404);
  }
  assert.equal((await publish('abc')).status, 409);
  assert.equal(
    (await request('api/v1/crates/new', 'PUT', other, body('abc', '2.0.0'))).status,
    403,
  );
  assert.equal((await request('api/v1/crates/abc/1.0.0/yank', 'DELETE')).status, 401);
  assert.equal((await request('api/v1/crates/abc/1.0.0/unyank', 'PUT')).status, 401);
  for (const [action, method, expected] of [
    ['yank', 'DELETE', true],
    ['unyank', 'PUT', false],
  ] as const) {
    assert.equal((await request(`api/v1/crates/abc/1.0.0/${action}`, method, key)).status, 200);
    assert.equal(JSON.parse(await (await request('index/3/a/abc')).text()).yanked, expected);
    assert.equal(await (await request('api/v1/crates/abc/1.0.0/download')).text(), 'test crate');
  }
  const response = await request('index/3/a/abc');
  await response.text();
  assert.equal(
    (
      await localFetch(origin + '/cargo/index/3/a/abc', {
        headers: { 'If-None-Match': response.headers.get('etag')! },
      })
    ).status,
    304,
  );
});

test('publish translates renamed dependencies, registry defaults and version-two features', async () => {
  const response = await publish('metadata', key, {
    deps: [
      {
        name: 'original',
        explicit_name_in_toml: 'alias',
        version_req: '^1',
        registry: 'https://github.com/rust-lang/crates.io-index',
      },
      { name: 'abc', version_req: '1' },
    ],
    features: { plain: [], new: ['dep:alias'] },
    rust_version: '1.70',
  });
  assert.equal(response.status, 200);
  const line = JSON.parse(await (await request('index/' + indexPath('metadata'))).text());
  assert.equal(line.deps[0].name, 'alias');
  assert.equal(line.deps[0].package, 'original');
  assert.equal(line.deps[0].req, '^1');
  assert.equal(line.deps[1].registry, null);
  assert.equal(line.v, 2);
  assert.deepEqual(line.features2, { new: ['dep:alias'] });
  assert.equal(line.rust_version, '1.70');
});
function upstreamCrate(name: string, bytes: Buffer, hash = checksum(bytes)) {
  const line = {
    name,
    vers: '1.0.0',
    deps: [],
    cksum: hash,
    features: {},
    yanked: false,
    links: null,
    v: 1,
  };
  upstreamFiles.set('/' + indexPath(name), Buffer.from(JSON.stringify(line) + '\n'));
  upstreamFiles.set(`/${name}/${name}-1.0.0.crate`, bytes);
}
test('copy verifies checksums, revalidates, keeps exact index offline and refuses removed versions', async () => {
  upstreamCrate('badchecksum', Buffer.from('bad'), '0'.repeat(64));
  assert.equal((await request('crates-io/api/v1/crates/badchecksum/1.0.0/download')).status, 422);
  assert.equal(
    getSqlite()!
      .prepare(
        "SELECT 1 FROM package_cache_entries WHERE ecosystem='cargo' AND kind='file' AND key='badchecksum@1.0.0'",
      )
      .get(),
    undefined,
  );
  upstreamCrate('copied', Buffer.from('kept crate'));
  const path = 'crates-io/' + indexPath('copied');
  const index = await (await request(path)).text();
  assert.equal(index, upstreamFiles.get('/' + indexPath('copied'))!.toString());
  assert.equal(
    await (await request('crates-io/api/v1/crates/copied/1.0.0/download')).text(),
    'kept crate',
  );
  const before = hits;
  assert.equal(await (await request(path)).text(), index);
  assert.ok(hits > before);
  down = true;
  assert.equal(await (await request(path)).text(), index);
  const failed = hits;
  assert.equal(
    await (await request('crates-io/api/v1/crates/copied/1.0.0/download')).text(),
    'kept crate',
  );
  assert.equal(hits, failed);
  down = false;
  registry.copy.reachable = true;
  upstreamFiles.set('/' + indexPath('copied'), Buffer.from(''));
  assert.equal((await request('crates-io/api/v1/crates/copied/1.0.0/download')).status, 404);
});

const hasCargo = spawnSync('cargo', ['--version']).status === 0;
test(
  'real cargo publishes private dependencies and crates.io aliases, builds locked, then builds from kept files and offline',
  { skip: !hasCargo, timeout: 120000 },
  async () => {
    const home = join(root, 'cargo-home');
    await mkdir(home);
    await writeFile(join(home, 'config.toml'), cargoConfig(origin));
    const env = {
      ...process.env,
      CARGO_HOME: home,
      CARGO_REGISTRIES_DEPLOY_LOCAL_TOKEN: key,
      CARGO_HTTP_TIMEOUT: '5',
    };
    const cargo = (cwd: string, args: string[], extra = {}) =>
      exec('cargo', args, {
        cwd,
        env: { ...env, ...extra },
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      });
    async function crate(name: string, dependencies = '', code = 'pub fn value() -> u32 { 1 }') {
      const cwd = join(root, name);
      await mkdir(join(cwd, 'src'), { recursive: true });
      await writeFile(
        join(cwd, 'Cargo.toml'),
        `[package]\nname = "${name}"\nversion = "1.0.0"\nedition = "2021"\nlicense = "MIT"\ndescription = "test"\n${dependencies}\n`,
      );
      await writeFile(join(cwd, 'src/lib.rs'), code);
      return cwd;
    }
    // This tiny crates.io crate is built locally. Tests never fetch the real upstream.
    const publicCrate = await crate('upstream_fixture');
    await cargo(publicCrate, ['package', '--allow-dirty', '--no-verify']);
    upstreamCrate(
      'upstream_fixture',
      await readFile(join(publicCrate, 'target/package/upstream_fixture-1.0.0.crate')),
    );
    const a = await crate('private_a');
    await cargo(a, ['publish', '--registry', 'deploy-local', '--allow-dirty']);
    const b = await crate(
      'private_b',
      '[dependencies]\nprivate_alias = { package = "private_a", version = "1", registry = "deploy-local" }\npublic_alias = { package = "upstream_fixture", version = "1" }',
      'pub fn value() -> u32 { private_alias::value() + public_alias::value() }',
    );
    await cargo(b, ['publish', '--registry', 'deploy-local', '--allow-dirty']);
    const line = JSON.parse(await (await request('index/' + indexPath('private_b'))).text());
    assert.equal(line.deps.find((dep: any) => dep.name === 'private_alias').registry, null);
    assert.equal(
      line.deps.find((dep: any) => dep.name === 'public_alias').registry,
      'https://github.com/rust-lang/crates.io-index',
    );
    const consumer = await crate(
      'consumer',
      '[dependencies]\nprivate_b = { version = "1", registry = "deploy-local" }',
      'pub fn value() -> u32 { private_b::value() }',
    );
    await cargo(consumer, ['generate-lockfile']);
    await cargo(consumer, ['build', '--locked'], { CARGO_REGISTRIES_DEPLOY_LOCAL_TOKEN: '' });
    await cargo(a, ['yank', '--registry', 'deploy-local', '--version', '1.0.0']);
    await cargo(a, ['yank', '--registry', 'deploy-local', '--version', '1.0.0', '--undo']);
    down = true;
    try {
      await rm(join(home, 'registry'), { recursive: true, force: true });
      await rm(join(consumer, 'target'), { recursive: true, force: true });
      await cargo(consumer, ['build', '--locked'], { CARGO_REGISTRIES_DEPLOY_LOCAL_TOKEN: '' });
      await rm(join(consumer, 'target'), { recursive: true, force: true });
      await cargo(consumer, ['build', '--locked', '--offline'], {
        CARGO_REGISTRIES_DEPLOY_LOCAL_TOKEN: '',
      });
    } finally {
      down = false;
      registry.copy.reachable = true;
    }
  },
);
