import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
await mkdir('output/packages-npm', { recursive: true });
const root = await mkdtemp(resolve('output/packages-npm/test-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_MDNS_ADDRESS = '127.0.0.1';
process.env.NPM_CONFIG_CACHE = join(root, 'cli-npm-cache');
const { registerUser, getSqlite, _resetDb } = await import('../store.ts');
const { db: workspaceDb, save } = await import('../workspace/store.ts');
const { createNpmRegistry } = await import('./npm.ts');
const { packagesApi } = await import('./api.ts');
const { createKey, listKeys } = await import('./keys.ts');
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
const origin = 'http://127.0.0.1:5182';
const upstreamOrigin = 'http://127.0.0.1:5183';
const registry = createNpmRegistry({ upstreamBase: upstreamOrigin, publicBase: origin + '/npm/' });
const docs = new Map<string, any>(),
  tarballs = new Map<string, Buffer>();
let upstreamHits = 0,
  revalidations = 0,
  sourceDown = false;
const upstream = createServer((req, res) => {
  upstreamHits++;
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
    if (await packagesApi(req, res, 'alice')) return;
  } catch (error: any) {
    res.writeHead(error.status || 500);
    res.end(JSON.stringify({ error: error.message }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(5182, '127.0.0.1');
upstream.listen(5183, '127.0.0.1');
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
        { headers: { Authorization: computer }, read: 200, publish: 403 },
        {
          headers: {
            Authorization: '',
            'x-deploy-worker-id': worker.workerId,
            'x-deploy-worker-token': worker.workerToken,
          },
          read: 200,
          publish: 403,
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
    `//127.0.0.1:5182/npm/:_authToken=${aliceKey.key}\nregistry=${origin}/npm/\n//127.0.0.1:5182/npm/:always-auth=true\n`,
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
  const yarn = resolve('output/packages-npm/tools/node_modules/yarn/bin/yarn.js');
  for (const client of ['npm', 'pnpm', 'yarn']) {
    await t.test(client, async () => {
      const dir = join(root, client + '-publisher');
      await mkdir(dir);
      const name = '@deploy.local/' + client + '-client';
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name, version: '1.0.0', main: 'index.js', license: 'MIT' }),
      );
      await writeFile(join(dir, 'index.js'), 'module.exports = 42;\n');
      const pnpm = resolve('output/packages-npm/tools/node_modules/pnpm/bin/pnpm.cjs');
      const command = client === 'npm' ? 'npm' : process.execPath;
      const publishArgs =
        client === 'yarn'
          ? [
              yarn,
              'publish',
              '--non-interactive',
              '--new-version',
              '1.0.0',
              '--registry',
              origin + '/npm/',
            ]
          : [
              ...(client === 'pnpm' ? [pnpm] : []),
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
          ? [
              yarn,
              'install',
              '--non-interactive',
              '--ignore-scripts',
              '--registry',
              origin + '/npm/',
            ]
          : [
              ...(client === 'pnpm' ? [pnpm] : []),
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
      await exec(command, install, { cwd: consumer, env, timeout: 30000, killSignal: 'SIGKILL' });
      assert.equal(
        JSON.parse(await readFile(join(consumer, 'node_modules', name, 'package.json'), 'utf8'))
          .version,
        '1.0.0',
      );
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
      upstream.listen(5183, '127.0.0.1');
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
    packCommand: resolve('output/packages-npm/tools/node_modules/.bin/pnpm'),
  };
  await runPackages(['login'], {}, context);
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
  }
});
