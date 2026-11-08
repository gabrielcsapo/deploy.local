import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import tar from 'tar-stream';
import { preparePackageInstall } from '../../shared/package-install.mjs';
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'dockerfile-install-'));
process.env.DEPLOY_MDNS_ADDRESS = '127.0.0.1';
after(() => rm(root, { recursive: true, force: true }));

test('documented Dockerfile shell installs with real npm and pnpm using the generated secret paths, mode and CA; missing secrets use npmjs', async () => {
  const documentation = await readFile(new URL('../../docs/packages.md', import.meta.url), 'utf8');
  const line = documentation.split('\n').find((entry) => entry.startsWith('RUN '))!;
  assert.ok(line);
  assert.match(line, /id=npmrc,required=false,target=\/run\/deploy-packages\/npmrc,mode=0600/);
  assert.match(line, /id=ca,required=false,target=\/run\/deploy-packages\/ca.crt,mode=0600/);
  const shell = line.replace(/^RUN /, '').replace(/--mount=\S+\s*/g, '');
  await exec('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-keyout',
    join(root, 'key.pem'),
    '-out',
    join(root, 'ca.pem'),
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  ]);
  const ca = await readFile(join(root, 'ca.pem'), 'utf8');
  const pack = tar.pack();
  pack.entry(
    { name: 'package/package.json' },
    JSON.stringify({ name: 'build-install-fixture', version: '1.0.0', main: 'index.js' }),
  );
  pack.entry({ name: 'package/index.js' }, 'module.exports = 42;');
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(chunk);
  const bytes = gzipSync(Buffer.concat(chunks));
  const key = 'dlp_fixture_install_key';
  let requests = 0;
  const registry = 'https://127.0.0.1:5302/';
  const server = createServer(
    { key: await readFile(join(root, 'key.pem')), cert: ca },
    (req, res) => {
      requests++;
      if (req.headers.authorization !== 'Bearer ' + key) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.url?.endsWith('.tgz')) {
        res.end(bytes);
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          name: 'build-install-fixture',
          'dist-tags': { latest: '1.0.0' },
          time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
          versions: {
            '1.0.0': {
              name: 'build-install-fixture',
              version: '1.0.0',
              dist: {
                tarball: registry + 'build-install-fixture/-/fixture.tgz',
                integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
              },
            },
          },
        }),
      );
    },
  );
  await new Promise<void>((done) => server.listen(5302, '127.0.0.1', done));
  try {
    for (const client of ['npm', 'pnpm']) {
      for (const secrets of [true, false]) {
        const cwd = join(root, `${client}-${secrets}`);
        await mkdir(cwd);
        await writeFile(
          join(cwd, 'package.json'),
          JSON.stringify({
            name: 'fixture-app',
            version: '1.0.0',
            ...(secrets ? { dependencies: { 'build-install-fixture': '1.0.0' } } : {}),
          }),
        );
        const install = await preparePackageInstall(
          { registry, key, ca, address: '127.0.0.1' },
          { cwd, root, container: true, ping: async () => true },
        );
        try {
          // Simulate BuildKit's two mounts under a test-only root; preserve their generated contents.
          const mounted = secrets ? install.directory! : join(cwd, 'missing');
          await writeFile(
            install.npmrc!,
            (await readFile(install.npmrc!, 'utf8')).replaceAll(
              '/run/deploy-packages',
              install.directory!,
            ),
          );
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: cwd,
            NPM_CONFIG_USERCONFIG: secrets ? install.npmrc! : join(cwd, 'empty-npmrc'),
            NODE_EXTRA_CA_CERTS: ca ? install.ca : undefined,
            npm_config_cache: join(cwd, 'cache'),
            npm_config_audit: 'false',
            npm_config_fund: 'false',
            npm_config_loglevel: 'verbose',
            CI: 'true',
          };
          delete env.NPM_CONFIG_REGISTRY;
          delete env.npm_config_registry;
          await exec(
            client,
            [
              'install',
              ...(client === 'npm' ? ['--package-lock-only'] : []),
              ...(client === 'pnpm'
                ? ['--lockfile-only', '--store-dir', join(cwd, 'store')]
                : ['--ignore-scripts', '--audit=false', '--fund=false']),
            ],
            { cwd, env, timeout: 60000 },
          );
          const before = requests;
          const action = client === 'pnpm' ? 'pnpm install --frozen-lockfile' : 'npm ci';
          const run = shell
            .replace('pnpm install --frozen-lockfile', action)
            .replaceAll('/run/deploy-packages', mounted);
          // Without mounts no environment points at the registry, matching an ordinary external build.
          const clean = {
            ...env,
            NPM_CONFIG_USERCONFIG: join(cwd, 'empty-npmrc'),
            NODE_EXTRA_CA_CERTS: undefined,
          };
          const result = await exec('sh', ['-c', run], { cwd, env: clean, timeout: 60000 }).catch(
            async (error) => {
              const { readdir } = await import('node:fs/promises');
              const logRoot = join(cwd, 'cache', '_logs');
              for (const name of await readdir(logRoot).catch(() => []))
                error.message += (await readFile(join(logRoot, name), 'utf8')).replaceAll(
                  key,
                  '[redacted]',
                );
              throw error;
            },
          );
          assert.doesNotMatch(result.stdout + result.stderr, new RegExp(key));
          if (secrets) {
            assert.ok(
              requests > before,
              `${client} downloaded through the authenticated TLS fixture`,
            );
            assert.equal(
              (
                await readFile(join(cwd, 'node_modules/build-install-fixture/index.js'), 'utf8')
              ).trim(),
              'module.exports = 42;',
            );
          } else {
            assert.equal(requests, before);
            const result = await exec(
              'sh',
              ['-c', run.replace(action, `${client} config get registry`)],
              { cwd, env: clean, timeout: 30000 },
            );
            assert.equal(result.stdout.trim(), 'https://registry.npmjs.org/');
          }
        } finally {
          await install.cleanup();
        }
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
