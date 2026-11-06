import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir, utimes, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
const exec = promisify(execFile);
// Nothing here can rely on ignored folders: a release runs these tests from a clean checkout.
const root = await mkdtemp(join(tmpdir(), 'packages-test-'));
const freePort = () =>
  new Promise<number>((done) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });
const port = await freePort(),
  upstreamPort = await freePort();
const has = (command: string) => spawnSync(command, ['--version']).status === 0;
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_MDNS_ADDRESS = '127.0.0.1';
process.env.NPM_CONFIG_CACHE = join(root, 'cli-npm-cache');
const { registerUser, getSqlite, _resetDb } = await import('../store.ts');
const { db: workspaceDb, save } = await import('../workspace/store.ts');
const { createNpmRegistry } = await import('./npm.ts');
const { packagesApi } = await import('./api.ts');
const { createKey, listKeys, computerPackageKey } = await import('./keys.ts');
const { objectPath, storeFile, nameOf, fileOf, MAX_FILE } = await import('./store.ts');
const { enrollWorker } = await import('../workspace/credentials.ts');
const { lockfileVersions } = await import('./projects.ts');
const { Readable } = await import('node:stream');
const alice = registerUser('alice', 'long-test-password');
registerUser('bob', 'long-test-password');
getSqlite()!.prepare("UPDATE users SET role='admin' WHERE username='alice'").run();
const aliceKey = createKey('alice', 'MacBook Pro', 'publish');
const bobKey = createKey('bob', 'bazzite', 'publish');
const installKey = createKey('alice', 'read-only', 'install');
const worker = enrollWorker('alice', { workerId: 'packages-test' });
const origin = `http://127.0.0.1:${port}`;
const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;
const registry = createNpmRegistry({ upstreamBase: upstreamOrigin, publicBase: origin + '/npm/' });
const docs = new Map<string, any>(),
  tarballs = new Map<string, Buffer>();
let upstreamHits = 0,
  revalidations = 0,
  sourceDown = false;
const upstreamHandlers = new Map<string, (req: IncomingMessage, res: ServerResponse) => void>();
const upstream = createServer((req, res) => {
  upstreamHits++;
  const handler = upstreamHandlers.get(req.url!);
  if (handler) return handler(req, res);
  if (sourceDown) {
    res.writeHead(503);
    res.end();
    return;
  }
  if (req.url === '/-/ping') {
    res.end('{}');
    return;
  }
  if (req.url === '/-/npm/v1/security/advisories/bulk') {
    req.resume();
    res.end('{"example":[]}');
    return;
  }
  const file = tarballs.get(req.url!);
  if (file) {
    res.end(file);
    return;
  }
  const doc = docs.get(decodeURIComponent(req.url!.slice(1)));
  if (!doc) {
    res.writeHead(404);
    res.end('{}');
    return;
  }
  const etag = '"' + createHash('sha256').update(JSON.stringify(doc)).digest('hex') + '"';
  if (req.headers['if-none-match'] === etag) {
    revalidations++;
    res.writeHead(304);
    res.end();
    return;
  }
  res.setHeader('ETag', etag);
  res.end(JSON.stringify(doc));
});
const server = createServer(async (req, res) => {
  if (await registry.handle(req, res)) return;
  try {
    if (await packagesApi(req, res, 'alice', registry.copy)) return;
  } catch (error: any) {
    res.writeHead(error.status || 500);
    res.end(JSON.stringify({ error: error.message }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, '127.0.0.1');
upstream.listen(upstreamPort, '127.0.0.1');
await Promise.all([once(server, 'listening'), once(upstream, 'listening')]);
after(async () => {
  registry.copy.close();
  server.closeAllConnections();
  upstream.closeAllConnections();
  await Promise.all([
    new Promise<void>((r) => server.close(() => r())),
    new Promise<void>((r) => upstream.close(() => r())),
  ]);
  _resetDb();
  workspaceDb.close();
  await rm(root, { recursive: true, force: true });
});
const auth = (key = aliceKey.key) => ({ Authorization: 'Bearer ' + key });
async function call(path: string, options: RequestInit = {}) {
  const response = await fetch(origin + '/npm/' + path, {
    ...options,
    headers: { ...auth(), ...options.headers },
  });
  const body = await response.json();
  return { response, body };
}
function publishDoc(name: string, version = '1.0.0', bytes = Buffer.from('test tarball')) {
  return {
    name,
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        name,
        version,
        dist: { integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') },
      },
    },
    _attachments: {
      [name.split('/').pop() + '-' + version + '.tgz']: {
        data: bytes.toString('base64'),
        length: bytes.length,
      },
    },
  };
}
const publish = (name: string, doc = publishDoc(name), headers: Record<string, string> = auth()) =>
  call(encodeURIComponent(name), { method: 'PUT', headers, body: JSON.stringify(doc) });
function upstreamPackage(
  name: string,
  versions = ['1.0.0'],
  bytes = Buffer.from('upstream bytes'),
) {
  const doc: any = { name, 'dist-tags': { latest: versions.at(-1) }, versions: {} };
  for (const version of versions) {
    const path = '/' + name + '/-/' + name.split('/').pop() + '-' + version + '.tgz';
    tarballs.set(path, bytes);
    doc.versions[version] = {
      name,
      version,
      dist: {
        tarball: upstreamOrigin + path,
        integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
      },
    };
  }
  docs.set(name, doc);
  return doc;
}

test('npm protocol, auth, isolation, cache and responsiveness', async (t) => {
  await t.test(
    'every credential: read and publish permissions; revoked keys and agents',
    async () => {
      assert.equal((await publish('auth-matrix')).response.status, 201);
      const basic = 'Basic ' + Buffer.from(`alice:${alice.token}`).toString('base64');
      const computer =
        'Basic ' +
        Buffer.from(`workspace-worker.${worker.workerId}:${worker.workerToken}`).toString('base64');
      const matrix: { headers: Record<string, string>; read: number; publish: number }[] = [
        { headers: { Authorization: '' }, read: 401, publish: 401 },
        { headers: auth(), read: 200, publish: 201 },
        { headers: auth(installKey.key), read: 200, publish: 403 },
        { headers: { Authorization: basic }, read: 200, publish: 201 },
        { headers: auth(computerPackageKey('alice', worker.workerId)), read: 200, publish: 403 },
        { headers: { Authorization: computer }, read: 401, publish: 401 },
        {
          headers: {
            Authorization: '',
            'x-deploy-worker-id': worker.workerId,
            'x-deploy-worker-token': worker.workerToken,
          },
          read: 401,
          publish: 401,
        },
        { headers: { ...auth(), 'x-deploy-agent-token': 'agent-token' }, read: 401, publish: 401 },
      ];
      for (const [index, row] of matrix.entries()) {
        for (const path of ['-/ping', '-/whoami', 'auth-matrix', '-/v1/search'])
          assert.equal(
            (await call(path, { headers: row.headers })).response.status,
            row.read,
            path,
          );
        const tarball = await fetch(origin + '/npm/auth-matrix/-/auth-matrix-1.0.0.tgz', {
          headers: row.headers,
        });
        assert.equal(tarball.status, row.read);
        await tarball.arrayBuffer();
        const mutationStatus = row.publish === 201 ? 200 : row.publish;
        assert.equal(
          (
            await call('-/package/auth-matrix/dist-tags/check', {
              method: 'PUT',
              headers: row.headers,
              body: '"1.0.0"',
            })
          ).response.status,
          mutationStatus,
        );
        assert.equal(
          (
            await call('-/package/auth-matrix/dist-tags/check', {
              method: 'DELETE',
              headers: row.headers,
            })
          ).response.status,
          mutationStatus,
        );
        const deprecation = (await call('auth-matrix')).body;
        deprecation.versions['1.0.0'].deprecated = 'Test matrix';
        assert.equal(
          (
            await call('auth-matrix', {
              method: 'PUT',
              headers: row.headers,
              body: JSON.stringify(deprecation),
            })
          ).response.status,
          mutationStatus,
        );
        const result = await publish('auth-' + index, undefined, row.headers);
        assert.equal(result.response.status, row.publish, JSON.stringify(result.body));
        if (index === 4)
          assert.equal(
            result.body.reason,
            "Tasks can't publish. Set the version in the pull request; the pipeline publishes it when it merges.",
          );
      }
      const revoked = createKey('alice', 'remove me', 'publish');
      await fetch(origin + '/api/v2/package-keys', {
        method: 'DELETE',
        body: JSON.stringify({ id: revoked.id }),
      });
      assert.equal((await call('-/whoami', { headers: auth(revoked.key) })).response.status, 401);
      assert.ok(listKeys('alice').every((key: any) => !('hash' in key) && !('key' in key)));
      assert.equal(
        (await call('-/ping', { headers: { Authorization: aliceKey.key } })).response.status,
        200,
      );
      const logs = workspaceDb
        .prepare("SELECT payload FROM events WHERE type LIKE 'package.%'")
        .all();
      assert.ok(!JSON.stringify(logs).includes(aliceKey.key));
      assert.ok(
        !JSON.stringify(getSqlite()!.prepare('SELECT * FROM package_keys').all()).includes(
          aliceKey.key,
        ),
      );
    },
  );
  await t.test(
    'scopes, immutable versions, ownership, dist-tags, deprecation and refusals',
    async () => {
      assert.equal((await publish('@deploy.local/test')).response.status, 201);
      assert.equal((await publish('@deploy.local/test')).response.status, 409);
      assert.equal(
        (
          await publish(
            '@deploy.local/test',
            publishDoc('@deploy.local/test', '1.0.1'),
            auth(bobKey.key),
          )
        ).response.status,
        403,
      );
      const full = (await call('@deploy.local%2ftest')).body;
      assert.ok(full.versions['1.0.0'].dist.tarball.startsWith(origin));
      full.versions['1.0.0'].deprecated = 'Use 2.0.0';
      assert.equal(
        (await call('@deploy.local%2ftest', { method: 'PUT', body: JSON.stringify(full) })).response
          .status,
        200,
      );
      assert.equal(
        (
          await call('@deploy.local%2ftest', {
            headers: { Accept: 'application/vnd.npm.install-v1+json' },
          })
        ).body.versions['1.0.0'].deprecated,
        'Use 2.0.0',
      );
      assert.equal(
        (
          await call('-/package/@deploy.local%2ftest/dist-tags/next', {
            method: 'PUT',
            body: '"1.0.0"',
          })
        ).response.status,
        200,
      );
      assert.equal(
        (await call('-/package/@deploy.local%2ftest/dist-tags/next', { method: 'DELETE' })).response
          .status,
        200,
      );
      assert.match(
        (await call('@deploy.local%2ftest', { method: 'DELETE' })).body.reason,
        /Versions are never removed/,
      );
      assert.equal(
        (await call('-/user/org.couchdb.user:a', { method: 'PUT', body: '{}' })).body.error,
        'Run deploy packages login.',
      );
      assert.ok(
        (await call('-/v1/search?text=test')).body.objects.some(
          (p: any) => p.package.name === '@deploy.local/test',
        ),
      );
    },
  );
  await t.test(
    'names and filenames cannot escape; bad integrity leaves no stored file',
    async () => {
      for (const name of ['../x', '.', '..', '@scope/../x', '@scope/a/b', '@scope%2fa', 'a\\b'])
        assert.throws(() => nameOf(name));
      for (const name of ['../a.tgz', 'a/../b.tgz', '..tgz', 'a%2fb.tgz'])
        assert.throws(() => fileOf(name));
      for (const path of ['@scope%252fx', '@scope%2f..%2fx', 'test%2f..%2fx', 'test/-/..%2fa.tgz'])
        assert.equal((await call(path)).response.status, 400);
      const bytes = Buffer.from('must never be stored');
      await assert.rejects(
        storeFile(Readable.from([bytes]), 'cache', 'sha512-' + Buffer.alloc(64).toString('base64')),
        /integrity/,
      );
      await assert.rejects(
        readFile(objectPath('cache', createHash('sha256').update(bytes).digest('hex'))),
      );
      const doc = publishDoc('bad-integrity');
      doc.versions['1.0.0'].dist.integrity = 'sha512-' + Buffer.alloc(64).toString('base64');
      assert.equal((await publish('bad-integrity', doc)).response.status, 422);
      assert.equal(
        (
          getSqlite()!
            .prepare("SELECT count(*) AS n FROM packages WHERE name='bad-integrity'")
            .get() as { n: number }
        ).n,
        0,
      );
      assert.equal((await readdir(join(root, 'packages/tmp'))).length, 0);
    },
  );
  await t.test('claims require admins; bring-over versions never mix or fall through', async () => {
    upstreamPackage('public-name', ['0.1.0']);
    assert.equal((await publish('public-name')).response.status, 409);
    assert.equal(
      (
        await publish('public-name', undefined, {
          ...auth(bobKey.key),
          'x-deploy-package-claim': 'true',
        })
      ).response.status,
      403,
    );
    const claimed = await publish('public-name', undefined, {
      ...auth(),
      'x-deploy-package-claim': 'true',
      'x-deploy-package-import': 'true',
    });
    assert.equal(claimed.response.status, 201, JSON.stringify(claimed.body));
    assert.deepEqual(Object.keys((await call('public-name')).body.versions).sort(), [
      '0.1.0',
      '1.0.0',
    ]);
    assert.equal(
      (
        getSqlite()!
          .prepare("SELECT count(*) AS n FROM package_versions WHERE published_via='import'")
          .get() as { n: number }
      ).n,
      1,
    );
    const stored = new Map(
      (
        getSqlite()!
          .prepare(
            "SELECT v.version,v.created_at FROM package_versions v JOIN packages p ON p.id=v.package_id WHERE p.name='public-name'",
          )
          .all() as { version: string; created_at: string }[]
      ).map((row) => [row.version, row.created_at]),
    );
    const reported = (await call('public-name')).body.time;
    assert.equal(reported['0.1.0'], stored.get('0.1.0'));
    // Just past pnpm's one-day default for a version published now, with the database unchanged.
    assert.equal(
      Date.parse(stored.get('1.0.0')!) - Date.parse(reported['1.0.0']),
      25 * 60 * 60 * 1000,
    );
    upstreamPackage('public-name', ['9.0.0']);
    const hits = upstreamHits;
    assert.equal(
      (await fetch(origin + '/npm/public-name/-/public-name-9.0.0.tgz', { headers: auth() }))
        .status,
      404,
    );
    assert.equal(upstreamHits, hits);
  });
  await t.test(
    'ETags, stale offline installs, removed versions, corruption and audit',
    async () => {
      upstreamPackage('copied', ['1.0.0', '2.0.0']);
      const first = await call('copied');
      const hits = upstreamHits;
      await call('copied');
      assert.equal(upstreamHits, hits);
      const url = first.body.versions['1.0.0'].dist.tarball;
      assert.equal((await fetch(url, { headers: auth() })).status, 200);
      await registry.copy.document('copied', true);
      assert.ok(revalidations > 0);
      await call('previously-absent');
      sourceDown = true;
      assert.equal((await publish('previously-absent')).response.status, 503);
      getSqlite()!
        .prepare("UPDATE package_cache_entries SET fetched_at='2000-01-01' WHERE kind='doc'")
        .run();
      assert.equal((await fetch(url, { headers: auth() })).status, 200);
      assert.equal(registry.copy.reachable, false);
      assert.equal(
        (await fetch(first.body.versions['2.0.0'].dist.tarball, { headers: auth() })).status,
        503,
      );
      const audit = await call('-/npm/v1/security/advisories/bulk', { method: 'POST', body: '{}' });
      assert.deepEqual(audit.body, {});
      assert.match(audit.response.headers.get('warning')!, /unavailable/);
      sourceDown = false;
      delete docs.get('copied').versions['1.0.0'];
      await registry.copy.document('copied', true);
      const removed = await fetch(url, { headers: auth() });
      assert.equal(removed.status, 404);
      assert.match((await removed.json()).reason, /removed from npmjs.org on \d{4}-\d{2}-\d{2}/);
      upstreamPackage('corrupt');
      tarballs.set('/corrupt/-/corrupt-1.0.0.tgz', Buffer.from('wrong'));
      assert.equal(
        (await fetch(origin + '/npm/corrupt/-/corrupt-1.0.0.tgz', { headers: auth() })).status,
        422,
      );
      assert.equal(
        (
          getSqlite()!
            .prepare(
              "SELECT count(*) AS n FROM package_cache_entries WHERE kind='file' AND key='corrupt@1.0.0'",
            )
            .get() as { n: number }
        ).n,
        0,
      );
      assert.deepEqual(
        (await call('-/npm/v1/security/advisories/bulk', { method: 'POST', body: '{}' })).body,
        { example: [] },
      );
    },
  );
  await t.test('40 MB publish keeps pings responsive and enforces the body limit', async () => {
    const file = join(root, 'large.json');
    await writeFile(
      file,
      JSON.stringify(publishDoc('large-publish', '1.0.0', Buffer.alloc(40 * 1024 * 1024, 7))),
    );
    let completed = false;
    const latencies: number[] = [];
    const upload = fetch(origin + '/npm/large-publish', {
      method: 'PUT',
      headers: auth(),
      body: createReadStream(file),
      duplex: 'half',
    } as any).then(async (response) => {
      assert.equal(response.status, 201, await response.text());
      completed = true;
    });
    while (!completed) {
      const start = performance.now();
      await call('-/ping');
      latencies.push(performance.now() - start);
      await new Promise((r) => setTimeout(r, 5));
    }
    await upload;
    console.log(
      `Large publish: 40 MB tarball; ${latencies.length} concurrent pings; max ${Math.max(...latencies).toFixed(1)} ms`,
    );
    assert.ok(latencies.length > 3);
    assert.ok(Math.max(...latencies) < 250);
    const status = await new Promise<number>((resolve) => {
      const req = httpRequest(
        origin + '/npm/too-large',
        {
          method: 'PUT',
          headers: {
            ...auth(),
            'content-length': Math.ceil(MAX_FILE / 3) * 4 + 10 * 1024 * 1024 + 1,
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.end();
    });
    assert.equal(status, 413);
    const encodedLimit = Math.ceil(MAX_FILE / 3) * 4 + 10 * 1024 * 1024;
    async function* oversized() {
      const chunk = Buffer.alloc(1024 * 1024, 32);
      for (let sent = 0; sent <= encodedLimit; sent += chunk.length)
        yield chunk.subarray(0, Math.min(chunk.length, encodedLimit + 1 - sent));
    }
    const chunked = await fetch(origin + '/npm/chunked-too-large', {
      method: 'PUT',
      headers: auth(),
      body: Readable.from(oversized()),
      duplex: 'half',
    } as any);
    assert.equal(chunked.status, 413);
    assert.match((await chunked.json()).reason, /too large/);
    assert.equal((await readdir(join(root, 'packages/tmp'))).length, 0);
  });
  await t.test('lockfiles report actual versions', () => {
    assert.deepEqual(
      lockfileVersions(
        'package-lock.json',
        '{"packages":{"node_modules/@s/p":{"version":"1.0.0"}}}',
        '@s/p',
      ),
      ['1.0.0'],
    );
    assert.deepEqual(lockfileVersions('pnpm-lock.yaml', "packages:\n  '@s/p@1.2.0': {}", '@s/p'), [
      '1.2.0',
    ]);
    assert.deepEqual(lockfileVersions('yarn.lock', '"@s/p@^1.0.0":\n  version "1.0.3"', '@s/p'), [
      '1.0.3',
    ]);
    assert.deepEqual(
      lockfileVersions('yarn.lock', '"@s/p@npm:^1.0.0":\n  version: 1.0.4', '@s/p'),
      ['1.0.4'],
    );
  });
});

test('real npm, pnpm and Yarn publish, install and locked offline installs', async (t) => {
  const userRc = join(root, 'user.npmrc');
  await writeFile(
    userRc,
    `//127.0.0.1:${port}/npm/:_authToken=${aliceKey.key}\nregistry=${origin}/npm/\n//127.0.0.1:${port}/npm/:always-auth=true\n`,
  );
  const env = {
    ...process.env,
    NPM_CONFIG_USERCONFIG: userRc,
    NPM_CONFIG_CACHE: join(root, 'npm-cache'),
    YARN_CACHE_FOLDER: join(root, 'yarn-cache'),
    COREPACK_HOME: join(root, 'corepack'),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_fetch_retries: '0',
    SKIP_YARN_COREPACK_CHECK: '1',
    npm_config_manage_package_manager_versions: 'false',
    npm_config_package_manager_strict: 'false',
  };
  const available = { npm: has('npm'), pnpm: has('pnpm'), yarn: has('yarn') };
  for (const client of ['npm', 'pnpm', 'yarn'] as const) {
    await t.test(client, { skip: !available[client] }, async () => {
      const dir = join(root, client + '-publisher');
      await mkdir(dir);
      const name = '@deploy.local/' + client + '-client';
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name, version: '1.0.0', main: 'index.js', license: 'MIT' }),
      );
      await writeFile(join(dir, 'index.js'), 'module.exports = 42;\n');
      const command = client;
      const publishArgs =
        client === 'yarn'
          ? [
              'publish',
              '--non-interactive',
              '--new-version',
              '1.0.0',
              '--registry',
              origin + '/npm/',
            ]
          : [
              'publish',
              '--registry',
              origin + '/npm/',
              '--ignore-scripts',
              ...(client === 'pnpm' ? ['--no-git-checks', '--ignore-workspace'] : []),
            ];
      await exec(command, publishArgs, { cwd: dir, env, timeout: 30000, killSignal: 'SIGKILL' });
      const consumer = join(root, client + '-consumer');
      await mkdir(consumer);
      await writeFile(
        join(consumer, 'package.json'),
        JSON.stringify({
          name: 'consumer',
          version: '1.0.0',
          private: true,
          dependencies: { [name]: '1.0.0' },
        }),
      );
      const install =
        client === 'yarn'
          ? ['install', '--non-interactive', '--ignore-scripts', '--registry', origin + '/npm/']
          : [
              'install',
              '--ignore-scripts',
              ...(client === 'pnpm'
                ? [
                    '--ignore-workspace',
                    '--config.minimum-release-age=0',
                    '--store-dir',
                    join(root, 'pnpm-store'),
                  ]
                : []),
            ];
      // Only the copied packages below keep pnpm's wait turned off.
      const hostedInstall = install.filter((arg) => arg !== '--config.minimum-release-age=0');
      await exec(command, hostedInstall, {
        cwd: consumer,
        env,
        timeout: 30000,
        killSignal: 'SIGKILL',
      });
      assert.equal(
        JSON.parse(await readFile(join(consumer, 'node_modules', name, 'package.json'), 'utf8'))
          .version,
        '1.0.0',
      );
      if (client === 'pnpm') {
        // With an older version to fall back on, pnpm's default wait would pick that one.
        getSqlite()!
          .prepare(
            "UPDATE package_versions SET created_at='2020-01-01T00:00:00.000Z' WHERE version='1.0.0' AND package_id=(SELECT id FROM packages WHERE name=?)",
          )
          .run(name);
        await writeFile(
          join(dir, 'package.json'),
          JSON.stringify({ name, version: '1.1.0', main: 'index.js', license: 'MIT' }),
        );
        await exec(command, publishArgs, { cwd: dir, env, timeout: 30000, killSignal: 'SIGKILL' });
        await writeFile(
          join(consumer, 'package.json'),
          JSON.stringify({
            name: 'consumer',
            version: '1.0.0',
            private: true,
            dependencies: { [name]: '^1.0.0' },
          }),
        );
        await rm(join(consumer, 'node_modules'), { recursive: true, force: true });
        await rm(join(consumer, 'pnpm-lock.yaml'), { force: true });
        const fresh = [...hostedInstall, '--config.cache-dir=' + join(root, 'pnpm-fresh-cache')];
        for (const args of [fresh, [...fresh, '--frozen-lockfile']]) {
          await exec(command, args, { cwd: consumer, env, timeout: 30000, killSignal: 'SIGKILL' });
          assert.equal(
            JSON.parse(await readFile(join(consumer, 'node_modules', name, 'package.json'), 'utf8'))
              .version,
            '1.1.0',
          );
          await rm(join(consumer, 'node_modules'), { recursive: true, force: true });
        }
      }
      // Seed a genuine upstream tarball into the fake source, then install through the copy.
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'copy-' + client, version: '1.0.0', main: 'index.js' }),
      );
      await exec('npm', ['pack', '--ignore-scripts'], {
        cwd: dir,
        env,
        timeout: 30000,
        killSignal: 'SIGKILL',
      });
      const packed = (await readdir(dir)).find((f) => f === 'copy-' + client + '-1.0.0.tgz')!;
      const bytes = await readFile(join(dir, packed));
      upstreamPackage('copy-' + client, ['1.0.0', '2.0.0'], bytes);
      await rm(join(root, 'npm-cache'), { recursive: true, force: true });
      await writeFile(
        join(consumer, 'package.json'),
        JSON.stringify({
          name: 'consumer',
          version: '1.0.0',
          private: true,
          dependencies: { ['copy-' + client]: '1.0.0' },
        }),
      );
      await exec(command, install, { cwd: consumer, env, timeout: 30000, killSignal: 'SIGKILL' });
      assert.ok(
        getSqlite()!
          .prepare("SELECT 1 FROM package_cache_entries WHERE kind='file' AND key=?")
          .get('copy-' + client + '@1.0.0'),
      );
      upstream.closeAllConnections();
      await new Promise<void>((r) => upstream.close(() => r()));
      await rm(join(consumer, 'node_modules'), { recursive: true, force: true });
      // Empty client caches so the successful locked install must fetch from our stored copy.
      await Promise.all(
        ['npm-cache', 'pnpm-store', 'yarn-cache'].map((folder) =>
          rm(join(root, folder), { recursive: true, force: true }),
        ),
      );
      const locked =
        client === 'npm' ? ['ci', '--ignore-scripts'] : [...install, '--frozen-lockfile'];
      await exec(command, locked, { cwd: consumer, env, timeout: 30000, killSignal: 'SIGKILL' });
      assert.equal(
        (
          await fetch(origin + '/npm/copy-' + client + '/-/copy-' + client + '-2.0.0.tgz', {
            headers: auth(),
          })
        ).status,
        503,
      );
      upstream.listen(upstreamPort, '127.0.0.1');
      await once(upstream, 'listening');
    });
  }
});

test('CLI preserves user config, never writes keys to projects, uses pnpm pack and deprecates', async () => {
  const { runPackages } = await import(new URL('../../bin/packages.mjs', import.meta.url).href);
  const home = join(root, 'cli-home'),
    cwd = join(root, 'cli-project');
  await mkdir(home);
  await mkdir(cwd);
  await writeFile(join(home, '.npmrc'), '# keep this\nengine-strict=true\n');
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify({ name: '@deploy.local/cli-test', version: '1.0.0', files: ['index.js'] }),
  );
  await writeFile(join(cwd, 'index.js'), 'export default 1;');
  const messages: string[] = [];
  const api = async (path: string, options: RequestInit = {}) => {
    if (path === '/api/user') return { role: 'admin' };
    const response = await fetch(origin + path, options);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    return body;
  };
  const context = {
    serverUrl: origin,
    config: { username: 'alice', token: alice.token },
    api,
    prompt: async () => 'no',
    home,
    cwd,
    print: (text: string) => messages.push(text),
    packCommand: 'pnpm',
  };
  await runPackages(['login'], {}, context);
  assert.ok(messages.some((message) => message.includes('Trusts the coordinator’s certificate')));
  const rc = await readFile(join(home, '.npmrc'), 'utf8');
  assert.match(rc, /# keep this\nengine-strict=true/);
  assert.match(rc, /dlp_/);
  await runPackages(['use'], {}, context);
  const projectRc = await readFile(join(cwd, '.npmrc'), 'utf8');
  assert.ok(!projectRc.includes('dlp_'));
  assert.ok(!projectRc.includes(alice.token!));
  assert.ok(
    messages.some((message) =>
      message.includes('Anyone who can’t reach deploy.local can’t install this project.'),
    ),
  );
  assert.ok(!messages.join('\n').includes('dlp_'));
  await runPackages(['use'], { off: true }, context);
  await assert.rejects(readFile(join(cwd, '.npmrc')));
  await runPackages(['publish'], { 'dry-run': true }, context);
  assert.equal(
    getSqlite()!.prepare("SELECT 1 FROM packages WHERE name='@deploy.local/cli-test'").get(),
    undefined,
  );
  await runPackages(['publish'], { tag: 'next' }, context);
  assert.equal((await call('@deploy.local%2fcli-test')).body['dist-tags'].next, '1.0.0');
  assert.equal(
    (await publish('@deploy.local/cli-test', publishDoc('@deploy.local/cli-test', '2.0.0')))
      .response.status,
    201,
  );
  await runPackages(['deprecate', '@deploy.local/cli-test@1.0.0', 'Use 2.0.0'], {}, context);
  assert.equal(
    (await call('@deploy.local%2fcli-test')).body.versions['1.0.0'].deprecated,
    'Use 2.0.0',
  );
  const cargo = join(root, 'cargo-only');
  await mkdir(cargo);
  await writeFile(join(cargo, 'Cargo.toml'), '[package]\nname="later"');
  await assert.rejects(
    runPackages(['publish'], {}, { ...context, cwd: cargo }),
    /Cargo isn't available yet/,
  );
  assert.ok((await fetch(origin + '/api/v2/packages?sidebar=1').then((r) => r.json())).served);
});

test('reserved existing projects keep identity, settings and clone access', async () => {
  const { findRepository, updateProjectSettings, repositoryClonePath, repositoryWebURL } =
    await import('../workspace/repositories.ts');
  for (const name of ['npm', 'cargo', 'packages']) {
    const project = { id: 'legacy-' + name, name, owner: 'alice' };
    save('project', 'alice', project);
    assert.equal(findRepository('alice', name).id, project.id);
    assert.match(repositoryClonePath('alice', project), /api\/workspace\/git\//);
    assert.match(repositoryWebURL('alice', project), /dashboard\/repositories\//);
    updateProjectSettings('alice', project.id, { name, description: '', settingsRevision: 0 });
    assert.equal(findRepository('alice', name).name, name);
  }
});

test('scheduled rsync includes hosted packages and excludes the copy and unfinished writes', async () => {
  const { maintenance } = await import('../maintenance.ts');
  const { saveBackupSettings } = await import('../store.ts');
  const destination = root + '-backup';
  saveBackupSettings({ enabled: true, destination, cron: '0 0 * * *' });
  await writeFile(join(root, 'packages/tmp/unfinished'), 'incomplete');
  try {
    const result = await maintenance.runBackup();
    assert.equal(result.success, true, result.error || 'Backup failed');
    const version = getSqlite()!
      .prepare("SELECT sha256 FROM package_versions WHERE version='1.0.0' LIMIT 1")
      .get() as { sha256: string };
    const relative = 'packages/hosted/sha256/' + version.sha256.slice(0, 2) + '/' + version.sha256;
    assert.deepEqual(
      await readFile(join(destination, relative)),
      await readFile(join(root, relative)),
    );
    await assert.rejects(readdir(join(destination, 'packages/cache')));
    await assert.rejects(readdir(join(destination, 'packages/tmp')));
  } finally {
    saveBackupSettings({ enabled: false, destination: '', cron: '0 0 * * *' });
    await rm(destination, { recursive: true, force: true });
    await rm(join(root, 'packages/tmp/unfinished'), { force: true });
  }
});

test('review regressions: prepared copies, timeouts, cleanup and private names', async (t) => {
  await t.test(
    'upstream documents over 10 MB are prepared once and GETs keep pings responsive',
    async () => {
      const name = 'large-upstream';
      const doc = upstreamPackage(name, ['1.0.0', '2.0.0']);
      doc.time = { '1.0.0': '2020-01-01T00:00:00.000Z' };
      doc.readme = 'x'.repeat(40 * 1024 * 1024);
      const path = join(root, 'large-upstream.json');
      await writeFile(path, JSON.stringify(doc));
      let hits = 0;
      upstreamHandlers.set('/' + name, (req, res) => {
        assert.ok(!req.headers.accept?.includes('install-v1'));
        hits++;
        res.setHeader('ETag', '"large"');
        createReadStream(path).pipe(res);
      });
      const latencies: number[] = [];
      const progress = { completed: false };
      // Any large JSON.parse on this thread is a regression, independent of CPU speed.
      const parse = JSON.parse;
      const guard = t.mock.method(JSON, 'parse', (text: string, ...args: any[]) => {
        assert.ok(text.length < 1024 * 1024, 'large JSON must stay in the worker');
        return parse(text, ...args);
      });
      const downloads = (async () => {
        for (let batch = 0; batch < 3; batch++)
          await Promise.all(
            Array.from({ length: 4 }, async () => {
              const response = await fetch(origin + '/npm/' + name, { headers: auth() });
              assert.equal(response.status, 200);
              let size = 0;
              for await (const chunk of response.body!) size += chunk.length;
              assert.ok(size > 40 * 1024 * 1024);
            }),
          );
      })().finally(() => {
        progress.completed = true;
      });
      try {
        while (!progress.completed) {
          const start = performance.now();
          await call('-/ping');
          latencies.push(performance.now() - start);
          await new Promise((done) => setTimeout(done, 5));
        }
        await downloads;
      } finally {
        guard.mock.restore();
      }
      console.log(
        `Large copy: 40 MB document, 12 GETs; ${latencies.length} concurrent pings; max ${Math.max(...latencies).toFixed(1)} ms`,
      );
      assert.ok(latencies.length > 3);
      assert.ok(Math.max(...latencies) < 250);
      assert.equal(hits, 1);
      const full = await call(name);
      assert.deepEqual(full.body.time, doc.time);
      assert.ok(full.body.versions['1.0.0'].dist.tarball.startsWith(origin));
      const abbreviated = await call(name, {
        headers: { Accept: 'application/vnd.npm.install-v1+json' },
      });
      assert.equal(abbreviated.body.readme, undefined);
      assert.equal(
        abbreviated.body.versions['1.0.0'].dist.tarball,
        full.body.versions['1.0.0'].dist.tarball,
      );
      const row = await registry.copy.document(name);
      assert.ok(row && row.index_size < 2000);
      assert.ok((await registry.copy.index(row))['1.0.0'].tarball.startsWith(upstreamOrigin));
      const unchanged = await stat(objectPath('docs', row.sha256));
      upstreamHandlers.set('/' + name, (req, res) => {
        assert.equal(req.headers['if-none-match'], '"large"');
        res.writeHead(304).end();
      });
      await registry.copy.document(name, true);
      assert.equal((await stat(objectPath('docs', row.sha256))).mtimeMs, unchanged.mtimeMs);
      const hosted = publishDoc('@deploy.local/oversized-document');
      Object.assign(hosted, { readme: 'x'.repeat(11 * 1024 * 1024) });
      assert.equal((await publish(hosted.name, hosted)).response.status, 422);
    },
  );

  await t.test(
    '429 serves an existing copy or 503; a package 404 does not mark the source unreachable',
    async () => {
      upstreamPackage('throttled-copy');
      const before = (await call('throttled-copy')).body;
      for (const name of ['throttled-copy', 'throttled-miss'])
        upstreamHandlers.set('/' + name, (_req, res) => res.writeHead(429).end());
      getSqlite()!
        .prepare(
          "UPDATE package_cache_entries SET fetched_at='2000-01-01' WHERE key='throttled-copy'",
        )
        .run();
      assert.deepEqual((await call('throttled-copy')).body, before);
      assert.equal((await call('throttled-miss')).response.status, 503);
      assert.equal(registry.copy.reachable, false);
      assert.equal((await call('missing-health')).response.status, 404);
      assert.equal(registry.copy.reachable, true);
      await registry.copy.fetch('-/ping').then((r) => r.body?.cancel());
      assert.equal((await call('missing-health-again')).response.status, 404);
      assert.equal(registry.copy.reachable, true);
    },
  );

  await t.test(
    'slow shared bodies outlive header timeouts, but idle and total deadlines fail cleanly',
    async () => {
      Object.assign(registry.copy.settings, {
        headerTimeoutMs: 100,
        bodyIdleTimeoutMs: 150,
        bodyTotalTimeoutMs: 1500,
      });
      try {
        const bytes = Buffer.from('abcdef');
        upstreamPackage('slow-body', ['1.0.0'], bytes);
        let hits = 0;
        upstreamHandlers.set('/slow-body/-/slow-body-1.0.0.tgz', (_req, res) => {
          hits++;
          res.flushHeaders();
          let index = 0;
          const timer = setInterval(() => {
            res.write(bytes.subarray(index, ++index));
            if (index === bytes.length) {
              clearInterval(timer);
              res.end();
            }
          }, 50);
          res.once('close', () => clearInterval(timer));
        });
        const url = origin + '/npm/slow-body/-/slow-body-1.0.0.tgz';
        const disconnected = httpRequest(url, { headers: auth() });
        disconnected.on('error', () => {});
        disconnected.end();
        const download = fetch(url, { headers: auth() });
        setTimeout(() => disconnected.destroy(), 160);
        const response = await download;
        assert.equal(response.status, 200);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
        assert.equal(hits, 1);
        for (const mode of ['idle', 'total', 'broken', 'headers']) {
          const name = 'failed-' + mode;
          upstreamPackage(name, ['1.0.0'], Buffer.alloc(20, 97));
          await registry.copy.document(name);
          registry.copy.settings.bodyIdleTimeoutMs = 80;
          registry.copy.settings.bodyTotalTimeoutMs = 180;
          upstreamHandlers.set('/' + name + '/-/' + name + '-1.0.0.tgz', (_req, res) => {
            if (mode === 'headers') return;
            res.write('a');
            if (mode === 'idle') return;
            if (mode === 'broken') {
              setTimeout(() => res.destroy(), 10);
              return;
            }
            const timer = setInterval(() => res.write('a'), 20);
            res.once('close', () => clearInterval(timer));
          });
          const result = await fetch(origin + '/npm/' + name + '/-/' + name + '-1.0.0.tgz', {
            headers: auth(),
          });
          assert.equal(result.status, 503, mode + ': ' + (await result.text()));
          assert.equal(
            getSqlite()!
              .prepare("SELECT 1 FROM package_cache_entries WHERE kind='file' AND key=?")
              .get(name + '@1.0.0'),
            undefined,
          );
          const hash = createHash('sha256').update(Buffer.alloc(20, 97)).digest('hex');
          await assert.rejects(stat(objectPath('cache', hash)));
          assert.deepEqual(await readdir(join(root, 'packages/tmp')), []);
        }
        upstreamHandlers.set('/stalled-document', (_req, res) => {
          res.write('{');
        });
        assert.equal((await call('stalled-document')).response.status, 503);
        assert.equal(
          getSqlite()!
            .prepare("SELECT 1 FROM package_cache_entries WHERE key='stalled-document'")
            .get(),
          undefined,
        );
        assert.deepEqual(await readdir(join(root, 'packages/tmp')), []);
      } finally {
        delete registry.copy.settings.headerTimeoutMs;
        delete registry.copy.settings.bodyIdleTimeoutMs;
        delete registry.copy.settings.bodyTotalTimeoutMs;
      }
    },
  );

  await t.test(
    'unexpected failures return generic 500 and log locations without credentials',
    async () => {
      const errors: unknown[][] = [];
      const logging = t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args));
      const fault = t.mock.method(registry.copy, 'document', async () => {
        throw new Error('Bearer ' + aliceKey.key + ' https://alice:secret@example.com');
      });
      try {
        const result = await call('unexpected-fault');
        assert.equal(result.response.status, 500);
        assert.equal(result.body.reason, 'Internal package registry error');
        assert.equal(errors.length, 1);
        assert.match(JSON.stringify(errors), /Unexpected package registry error/);
        assert.ok(!JSON.stringify(errors).includes(aliceKey.key));
        assert.ok(!JSON.stringify(errors).includes('secret@example'));
      } finally {
        fault.mock.restore();
        logging.mock.restore();
      }
      upstreamHandlers.set('/invalid-document', (_req, res) => res.end('{broken'));
      const before = await readdir(join(root, 'packages/cache/docs'), { recursive: true });
      assert.equal((await call('invalid-document')).response.status, 502);
      assert.deepEqual(
        await readdir(join(root, 'packages/cache/docs'), { recursive: true }),
        before,
      );
      assert.deepEqual(await readdir(join(root, 'packages/tmp')), []);
    },
  );

  await t.test(
    'last use writes are throttled per key and entry, and served writes only once',
    async () => {
      const sqlite = getSqlite()!;
      upstreamPackage('write-count');
      await call('write-count');
      await fetch(origin + '/npm/write-count/-/write-count-1.0.0.tgz', { headers: auth() }).then(
        (r) => r.arrayBuffer(),
      );
      sqlite.exec(`CREATE TEMP TABLE package_write_counts(kind TEXT);
      CREATE TEMP TRIGGER count_key_use AFTER UPDATE OF last_used_at ON package_keys BEGIN INSERT INTO package_write_counts VALUES('key'); END;
      CREATE TEMP TRIGGER count_copy_use AFTER UPDATE OF last_used_at ON package_cache_entries BEGIN INSERT INTO package_write_counts VALUES('copy'); END;
      CREATE TEMP TRIGGER count_served BEFORE INSERT ON system_settings WHEN NEW.key='packages.served' BEGIN INSERT INTO package_write_counts VALUES('served'); END;`);
      try {
        for (let i = 0; i < 5; i++) {
          await call('write-count');
          await fetch(origin + '/npm/write-count/-/write-count-1.0.0.tgz', {
            headers: auth(),
          }).then((r) => r.arrayBuffer());
        }
        assert.deepEqual(sqlite.prepare('SELECT * FROM package_write_counts').all(), []);
        sqlite
          .prepare("UPDATE package_keys SET last_used_at='2000-01-01' WHERE id=?")
          .run(aliceKey.id);
        sqlite
          .prepare(
            "UPDATE package_cache_entries SET last_used_at='2000-01-01' WHERE key IN ('write-count','write-count@1.0.0')",
          )
          .run();
        sqlite.exec('DELETE FROM package_write_counts');
        await Promise.all(
          Array.from({ length: 5 }, () =>
            fetch(origin + '/npm/write-count/-/write-count-1.0.0.tgz', { headers: auth() }).then(
              (r) => r.arrayBuffer(),
            ),
          ),
        );
        assert.deepEqual(
          sqlite
            .prepare(
              'SELECT kind,count(*) AS count FROM package_write_counts GROUP BY kind ORDER BY kind',
            )
            .all(),
          [
            { kind: 'copy', count: 2 },
            { kind: 'key', count: 1 },
          ],
        );
      } finally {
        sqlite.exec(
          'DROP TRIGGER count_key_use; DROP TRIGGER count_copy_use; DROP TRIGGER count_served; DROP TABLE package_write_counts;',
        );
      }
    },
  );

  await t.test('removed packages retain an offline tombstone and can later reappear', async () => {
    const name = 'removed-package';
    upstreamPackage(name);
    await registry.copy.tarball(name, name + '-1.0.0.tgz');
    const before = (await registry.copy.document(name))!;
    docs.delete(name);
    assert.equal(await registry.copy.document(name, true), null);
    for (const hash of [before.sha256, before.abbreviated_sha256, before.index_sha256])
      await assert.rejects(stat(objectPath('docs', hash)));
    sourceDown = true;
    try {
      assert.equal((await call(name)).response.status, 404);
      assert.equal((await call(name + '/-/' + name + '-1.0.0.tgz')).response.status, 404);
      getSqlite()!
        .prepare(
          "UPDATE package_cache_entries SET fetched_at='2000-01-01' WHERE kind='doc' AND key=?",
        )
        .run(name);
      assert.equal((await call(name)).response.status, 404);
    } finally {
      sourceDown = false;
    }
    upstreamPackage(name, ['2.0.0']);
    assert.ok(await registry.copy.document(name, true));
    assert.ok((await call(name)).body.versions['2.0.0']);
  });

  await t.test(
    'GET survives replacement between looking up a document and opening it',
    async () => {
      const name = 'replace-during-get';
      upstreamPackage(name);
      await registry.copy.document(name);
      const original = registry.copy.document.bind(registry.copy);
      const replacement = t.mock.method(
        registry.copy,
        'document',
        async (...args: Parameters<typeof original>) => {
          const stale = await original(...args);
          upstreamPackage(name, ['2.0.0']);
          await original(name, true);
          return stale;
        },
      );
      try {
        const response = await call(name);
        assert.equal(response.response.status, 200);
        assert.deepEqual(Object.keys(response.body.versions), ['2.0.0']);
      } finally {
        replacement.mock.restore();
      }
      const opened = await registry.copy.openDocument(name);
      try {
        upstreamPackage(name, ['3.0.0']);
        await registry.copy.document(name, true);
        await assert.rejects(stat(objectPath('docs', opened.sha256)));
        assert.deepEqual(Object.keys(JSON.parse(await opened.handle.readFile('utf8')).versions), [
          '2.0.0',
        ]);
      } finally {
        await opened.handle.close();
      }
    },
  );

  await t.test(
    'replacement removes old prepared files but preserves shared references',
    async () => {
      upstreamPackage('replace-doc');
      const first = (await registry.copy.document('replace-doc'))!;
      const files = [first.sha256, first.abbreviated_sha256, first.index_sha256];
      // A second row may legitimately share content-addressed outputs.
      getSqlite()!
        .prepare(
          "INSERT INTO package_cache_entries SELECT ecosystem,kind,'shared-doc',sha256,size,abbreviated_sha256,abbreviated_size,index_sha256,index_size,etag,fetched_at,last_used_at,removed_at,format FROM package_cache_entries WHERE kind='doc' AND key='replace-doc'",
        )
        .run();
      upstreamPackage('replace-doc', ['2.0.0']);
      const second = (await registry.copy.document('replace-doc', true))!;
      for (const hash of files) assert.ok((await stat(objectPath('docs', hash))).isFile());
      // Removing the last referencing row collects all three originals.
      assert.equal(await registry.copy.document('shared-doc', true), null);
      for (const hash of files) await assert.rejects(stat(objectPath('docs', hash)));
      for (const hash of [second.sha256, second.abbreviated_sha256, second.index_sha256])
        assert.ok((await stat(objectPath('docs', hash))).isFile());
      upstreamPackage('replace-doc', ['3.0.0']);
      await registry.copy.document('replace-doc', true);
      for (const hash of [second.sha256, second.abbreviated_sha256, second.index_sha256])
        await assert.rejects(stat(objectPath('docs', hash)));
    },
  );

  await t.test('startup removes only temporary entries older than one hour', async () => {
    const folder = join(root, 'packages/tmp');
    const old = join(folder, 'old'),
      fresh = join(folder, 'fresh'),
      directory = join(folder, 'old-worker');
    await writeFile(old, 'partial');
    await writeFile(fresh, 'active');
    await mkdir(directory);
    await writeFile(join(directory, 'partial'), 'partial');
    const earlier = new Date(Date.now() - 61 * 60 * 1000);
    await utimes(old, earlier, earlier);
    await utimes(directory, earlier, earlier);
    const startup = createNpmRegistry({
      upstreamBase: upstreamOrigin,
      publicBase: origin + '/npm/',
    });
    await startup.copy.startupCleanup;
    startup.copy.close();
    assert.deepEqual(await readdir(folder), ['fresh']);
    await rm(fresh);
  });

  await t.test(
    'private names never go upstream for documents, tarballs or publish checks',
    async () => {
      const hits = upstreamHits;
      assert.equal(
        (await call(encodeURIComponent('@deploy.local/not-hosted'))).response.status,
        404,
      );
      assert.equal(
        (await call(encodeURIComponent('@deploy.local/not-hosted') + '/-/not-hosted-1.0.0.tgz'))
          .response.status,
        404,
      );
      // Local publishing also succeeds when upstream health is known to be down.
      sourceDown = true;
      await registry.copy.fetch('-/ping').catch(() => {});
      const privateHits = upstreamHits;
      try {
        assert.equal((await publish('@deploy.local/private-new')).response.status, 201);
        assert.equal(upstreamHits, privateHits);
        assert.equal(privateHits, hits + 1);
      } finally {
        sourceDown = false;
      }
    },
  );
});

test('usage indexes parse lockfiles once per repository commit, single-flight and bounded', async () => {
  const { LockfileCache, readLockfile, usedBy } = await import('./projects.ts');
  const { repositoryGit } = await import('../workspace/repository-git.ts');
  const repository = join(root, 'usage-repository');
  await mkdir(repository);
  const git = (args: string[]) => repositoryGit(repository, args, { identity: 'test' });
  await git(['init', '-b', 'main']);
  const lock = (version: string) =>
    JSON.stringify({
      packages: {
        'node_modules/@s/a': { version },
        'node_modules/b': { version: '2.0.0' },
        'node_modules/local': { link: true, resolved: 'local' },
      },
    });
  await writeFile(join(repository, 'package-lock.json'), lock('1.0.0'));
  await mkdir(join(repository, 'local'));
  await writeFile(
    join(repository, 'local/package.json'),
    JSON.stringify({ name: 'local', version: '3.0.0' }),
  );
  await git(['add', '.']);
  await git(['commit', '-m', 'fixture']);
  save('project', 'alice', {
    id: 'usage-fixture',
    owner: 'alice',
    name: 'usage-fixture',
    repositoryPath: repository,
  });
  let reads = 0,
    parses = 0;
  const cache = new LockfileCache(
    async (...args) => {
      reads++;
      return repositoryGit(...args);
    },
    async (...args) => {
      parses++;
      return readLockfile(...args);
    },
  );
  const first = await usedBy('alice', '@s/a', cache);
  assert.equal(first[0].id, 'usage-fixture');
  assert.deepEqual(first[0].versions, ['1.0.0']);
  assert.equal(parses, 1);
  assert.equal(reads, 4);
  assert.deepEqual((await usedBy('alice', 'b', cache))[0].versions, ['2.0.0']);
  assert.equal((await usedBy('alice', 'local', cache))[0].sameRepository, true);
  assert.deepEqual((await usedBy('alice', 'local', cache))[0].versions, ['3.0.0']);
  assert.equal(parses, 1);
  assert.equal(reads, 4);
  assert.deepEqual(await usedBy('alice', 'constructor', cache), []);
  await writeFile(join(repository, 'package-lock.json'), lock('1.1.0'));
  await git(['add', '.']);
  await git(['commit', '-m', 'new fixture commit']);
  const second = await Promise.all(
    Array.from({ length: 10 }, () => usedBy('alice', '@s/a', cache)),
  );
  assert.ok(second.every((rows) => rows[0].versions[0] === '1.1.0'));
  assert.equal(parses, 2);
  assert.equal(reads, 8);
  const pnpm = await readLockfile(
    'pnpm-lock.yaml',
    `packages:
  '@s/a@1.2.3': {}
  'b@2.0.0(peer@1.0.0)': {}
importers:
  app:
    dependencies:
      local:
        version: link:../local
`,
  );
  assert.deepEqual(pnpm['@s/a'].versions, ['1.2.3']);
  assert.deepEqual(pnpm.b.versions, ['2.0.0']);
  assert.deepEqual(pnpm.local.links, ['app/../local']);
  const yarn = await readLockfile(
    'yarn.lock',
    '"@s/a@^1.0.0", "@s/a@~1.2.0":\n  version "1.2.3"\n"b@npm:^2.0.0":\n  version: 2.0.1\n',
  );
  assert.deepEqual(yarn['@s/a'].versions, ['1.2.3']);
  assert.deepEqual(yarn.b.versions, ['2.0.1']);
  const bun = await readLockfile(
    'bun.lock',
    '{"packages":{"@s/a":["@s/a@1.2.3"],"b":["b@2.0.1"],},}',
  );
  assert.deepEqual(bun['@s/a'].versions, ['1.2.3']);
  assert.deepEqual(bun.b.versions, ['2.0.1']);
  let evictions = 0;
  const bounded = new LockfileCache(
    async () => Buffer.from('{}'),
    async () => {
      evictions++;
      return {};
    },
    2,
  );
  for (const revision of ['one', 'two', 'one', 'three', 'one', 'two'])
    await bounded.read(repository, revision, 'bun.lock');
  assert.equal(evictions, 4);
});

test('once the source is known to be down, kept documents answer without waiting on it', async () => {
  upstreamPackage('kept-through-outage', ['1.0.0']);
  const headers = auth();
  const url = origin + '/npm/kept-through-outage';
  assert.equal((await fetch(url, { headers })).status, 200);
  const old = () =>
    getSqlite()!
      .prepare(
        "UPDATE package_cache_entries SET fetched_at='2000-01-01' WHERE kind='doc' AND key='kept-through-outage'",
      )
      .run();
  old();
  sourceDown = true;
  try {
    await registry.copy.fetch('-/ping').catch(() => {});
    await registry.copy.fetch('-/ping').catch(() => {});
    assert.equal(registry.copy.reachable, false);
    const hits = upstreamHits;
    assert.equal((await fetch(url, { headers })).status, 200);
    const attestation = origin + '/npm/-/npm/v1/attestations/kept-through-outage@1.0.0';
    assert.equal((await fetch(attestation, { headers })).status, 404);
    assert.equal(upstreamHits, hits, 'nothing waited on the source');
    // A name it has never kept still gets its chance, so a brief failure can't refuse it.
    assert.equal((await fetch(origin + '/npm/never-kept-outage', { headers })).status, 503);
    assert.equal(upstreamHits, hits + 1);
  } finally {
    sourceDown = false;
    await registry.copy.fetch('-/ping').catch(() => {});
  }
  assert.equal(registry.copy.reachable, true);
  old();
  const hits = upstreamHits;
  assert.equal((await fetch(url, { headers })).status, 200);
  assert.equal(upstreamHits, hits + 1, 'it asks the source again once it is back');
});
test('attestations pass through from the source, and private names have none', async () => {
  const before = upstreamHits;
  upstreamHandlers.set('/-/npm/v1/attestations/left-pad@1.3.0', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end('{"attestations":[]}');
  });
  const headers = { authorization: 'Bearer ' + aliceKey.key };
  const found = await fetch(origin + '/npm/-/npm/v1/attestations/left-pad@1.3.0', { headers });
  assert.equal(found.status, 200);
  assert.deepEqual(await found.json(), { attestations: [] });
  assert.equal(upstreamHits, before + 1);
  const hits = upstreamHits;
  const hidden = await fetch(origin + '/npm/-/npm/v1/attestations/@deploy.local/none@1.0.0', {
    headers,
  });
  assert.equal(hidden.status, 404);
  assert.equal(upstreamHits, hits);
  const anonymous = await fetch(origin + '/npm/-/npm/v1/attestations/left-pad@1.3.0');
  assert.equal(anonymous.status, 401);
  upstreamHandlers.delete('/-/npm/v1/attestations/left-pad@1.3.0');
  sourceDown = true;
  const down = await fetch(origin + '/npm/-/npm/v1/attestations/left-pad@1.3.0', { headers });
  sourceDown = false;
  assert.equal(down.status, 404);
  await registry.copy.fetch('-/ping').then((response) => response.body?.cancel());
});

test('Copies API and CLI expose only the signed-in owner’s projects and warming requests', async () => {
  save('project', 'alice', { id: 'alice-cache', name: 'Alice cache' });
  save('project', 'bob', { id: 'bob-cache', name: 'Bob secret cache' });
  const response = await fetch(origin + '/api/v2/packages/cache');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.projects.some((p: any) => p.id === 'alice-cache'));
  assert.ok(!JSON.stringify(result).includes('Bob secret cache'));
  assert.equal(result.storage.limit, 20 * 1024 ** 3);
  assert.equal(result.storage.days, 90);
  const forbidden = await fetch(origin + '/api/v2/packages/cache/warm', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'bob-cache' }),
  });
  assert.equal(forbidden.status, 404);
  const accepted = await fetch(origin + '/api/v2/packages/cache/warm', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'alice-cache' }),
  });
  assert.equal(accepted.status, 202);
  assert.ok(
    workspaceDb
      .prepare(
        "SELECT 1 FROM records WHERE kind='package-warm' AND owner='alice' AND id='alice-cache'",
      )
      .get(),
  );
  assert.ok(
    !workspaceDb
      .prepare("SELECT 1 FROM records WHERE kind='package-warm' AND owner='bob' AND id='bob-cache'")
      .get(),
  );
  const { runPackages } = await import(new URL('../../bin/packages.mjs', import.meta.url).href);
  const output: string[] = [];
  const api = async (path: string, options: any) => (await fetch(origin + path, options)).json();
  const context = {
    serverUrl: origin,
    config: {},
    api,
    print: (line: string) => output.push(line),
  };
  await runPackages(['copies'], { json: true }, context);
  assert.ok(!output.join('').includes('Bob secret cache'));
  await runPackages(['copies', 'fetch'], { project: 'alice-cache' }, context);
  assert.match(output.at(-1)!, /Queued 1 projects/);
});

test('login reports the certificate location when it is not in the keychain', async (t) => {
  const { runPackages } = await import(new URL('../../bin/packages.mjs', import.meta.url).href);
  const home = join(root, 'https-cli-home');
  await mkdir(home);
  const certificate =
    '-----BEGIN CERTIFICATE-----\nfixture-certificate\n-----END CERTIFICATE-----\n';
  t.mock.method(globalThis, 'fetch', async () => new Response(certificate));
  const output: string[] = [];
  await runPackages(
    ['login'],
    {},
    {
      serverUrl: 'https://deploy.local',
      home,
      cwd: home,
      config: { username: 'alice', token: 'fixture-session' },
      api: async () => ({ key: installKey.key, label: 'Fixture' }),
      print: (line: string) => output.push(line),
    },
  );
  const ca = join(home, '.deploy', 'packages', 'ca.crt');
  assert.equal(await readFile(ca, 'utf8'), certificate);
  assert.ok(
    output.some(
      (line) => line.includes('Trusts the coordinator’s certificate') && line.includes(ca),
    ),
  );
  assert.ok(!output.join('').includes(installKey.key));
});

test('scoped tarball URLs are standard, and older documents are prepared again', async () => {
  const name = '@standard/url-check';
  upstreamPackage(name);
  const headers = { authorization: 'Bearer ' + aliceKey.key };
  const read = async () =>
    (await (await fetch(origin + '/npm/' + encodeURIComponent(name), { headers })).json()) as any;
  const tarball = origin + '/npm/@standard/url-check/-/url-check-1.0.0.tgz';
  assert.equal((await read()).versions['1.0.0'].dist.tarball, tarball);
  assert.equal((await fetch(tarball, { headers })).status, 200);

  // A document stored before this format stays usable while the source is down...
  const entries = getSqlite()!.prepare(
    "UPDATE package_cache_entries SET format=1 WHERE ecosystem='npm' AND kind='doc' AND key=?",
  );
  entries.run(name);
  sourceDown = true;
  assert.equal((await read()).name, name);
  sourceDown = false;
  await registry.copy.fetch('-/ping').then((response) => response.body?.cancel());

  // ...and is prepared again once it answers, even when upstream would say nothing changed.
  const before = revalidations;
  assert.equal((await read()).versions['1.0.0'].dist.tarball, tarball);
  assert.equal(revalidations, before);
  const row = getSqlite()!
    .prepare("SELECT format FROM package_cache_entries WHERE kind='doc' AND key=?")
    .get(name) as { format: number };
  assert.equal(row.format, 2);
});
