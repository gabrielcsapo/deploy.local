import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WanderIntent } from './wander-adoption.ts';
import { fileURLToPath } from 'node:url';
if (process.env.DEPLOY_WANDER_API_CHILD !== '1') {
  test('isolated owner API integration', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, DEPLOY_WANDER_API_CHILD: '1' };
    delete env.NODE_TEST_CONTEXT;
    const output = execFileSync(
      process.execPath,
      ['--test', '--test-force-exit', fileURLToPath(import.meta.url)],
      { env, stdio: 'pipe', encoding: 'utf8' },
    );
    assert.match(output, /tests 2/);
    assert.match(output, /fail 0/);
  });
} else {
  const root = mkdtempSync(join(tmpdir(), 'wander-api-'));
  process.env.DEPLOY_DATA_DIR = root;
  const store = await import('./store.ts');
  const { apiMiddleware } = await import('./api.ts');
  const { getArtifact } = await import('./content-store.ts');
  const { wanderAdoptionService } = await import('./wander-adoption-service.ts');
  const { newWanderJournal } = await import('./wander-adoption.ts');
  const { writeWanderJournal, _resetWanderJournal, WANDER_MANAGED_DIGEST } =
    await import('./wander-adoption-fence.ts');
  const owner = store.registerUser('fixture-owner', 'synthetic-only-password'),
    member = store.registerUser('fixture-member', 'synthetic-only-password');
  store.ensureCoordinatorNode();
  store.setDefaultNode('coordinator');
  store.saveDeployment({
    name: 'wander',
    username: 'fixture-owner',
    type: 'application-graph',
    containerName: 'deploy-sh-wander',
    containerId: 'old-fixture',
    port: 39999,
  });
  (await import('./multisite.ts')).registerApplicationIdentity('wander');
  const baseline = {
    application: 'wander',
    applicationId: store.getDeployment('wander')!.appId!,
    expectedContainer: 'old-fixture',
    expectedImage: 'sha256:' + 'a'.repeat(64),
    expectedRuntimeSettings: 'b'.repeat(64),
    expectedSource: 'sha256:' + 'c'.repeat(64),
    expectedParent: 'sha256:' + 'd'.repeat(64),
    specDigest: WANDER_MANAGED_DIGEST,
  };
  let adopted: WanderIntent | null = null;
  let recovered = 0;
  const handler = apiMiddleware({
    wanderAdoptionService: (username) => {
      const service = wanderAdoptionService(username);
      service.adopt = async (i) => {
        adopted = i;
        return {
          operationId: 'fixture',
          application: 'wander',
          applicationId: i.applicationId,
          sourceCommit: i.sourceCommit,
          sourceDigest: i.sourceDigest,
          sourceArchiveDigest: i.sourceArchiveDigest,
          specDigest: i.specDigest,
          status: 'committed',
          imageDigest: null,
          containerId: null,
          backupVerified: true,
          requiresOwnerRecovery: false,
          failure: null,
        };
      };
      service.recover = async () => {
        recovered++;
        return { ...service.status(), status: 'fixture-recovered' } as unknown as Awaited<
          ReturnType<typeof service.recover>
        >;
      };
      return service;
    },
    wanderAdoptionPreflight: async (username) => {
      wanderAdoptionService(username);
      return baseline;
    },
  });
  const server = createServer((req, res) => {
    handler(req, res, () => {
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('fixture port unavailable');
  const origin = 'http://127.0.0.1:' + address.port,
    cap = '/api/deployments/wander/managed-adoption';
  const auth = (other = false) => ({
    'x-deploy-username': other ? 'fixture-member' : 'fixture-owner',
    'x-deploy-token': other ? member.token! : owner.token!,
  });
  const request = (path: string, options: RequestInit = {}) => fetch(origin + path, options);
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    store._resetDb();
    rmSync(root, { recursive: true, force: true });
  });
  test('owner administrator authentication, exact acknowledgement and pending mutation fence', async () => {
    assert.equal((await request(cap)).status, 401);
    assert.equal((await request(cap, { headers: auth(true) })).status, 404);
    assert.equal((await request(cap, { headers: auth() })).status, 200);
    assert.equal(
      (await request(cap + '/recover', { method: 'POST', headers: auth(), body: '{}' })).status,
      400,
    );
    assert.equal(recovered, 0);
    assert.equal(
      (
        await request(cap + '/recover', {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({ operationId: 'fixture', confirmDowntime: true }),
        })
      ).status,
      200,
    );
    assert.equal(recovered, 1);
    const j = newWanderJournal(
      {
        ...baseline,
        sourceCommit: 'e'.repeat(40),
        sourceDigest: 'sha256:' + 'f'.repeat(64),
        sourceArchiveDigest: 'sha256:' + '1'.repeat(64),
        requestKey: 'fixture',
        sourceDirectory: '/tmp/fixture',
      },
      'fixture-owner',
      {},
      'baseline',
      'root',
    );
    writeWanderJournal(j, true);
    assert.equal(
      (
        await request('/api/deployments/wander/restart', {
          method: 'POST',
          headers: auth(),
          body: '{}',
        })
      ).status,
      409,
    );
    assert.equal(
      (await request('/api/deployments/wander', { method: 'DELETE', headers: auth() })).status,
      409,
    );
    j.phase = 'committed';
    writeWanderJournal(j);
    assert.equal(
      (await request('/api/deployments/wander', { method: 'DELETE', headers: auth() })).status,
      409,
    );
    _resetWanderJournal();
    // The exact same owner lacks admin capability after reassignment; no host operations allowed.
    store.saveDeployment({ name: 'wander', username: 'fixture-member' });
    assert.equal((await request(cap, { headers: auth(true) })).status, 403);
    store.saveDeployment({ name: 'wander', username: 'fixture-owner' });
  });
  test('bounded upload validates both source byte digests and exact fields before adopting', async () => {
    const dir = join(root, 'bundle');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'deploy.yaml'),
      readFileSync(new URL('./fixtures/wander-adoption/deploy.yaml', import.meta.url)),
    );
    writeFileSync(join(dir, 'Dockerfile'), 'FROM fixture-only\n');
    const tar = join(root, 'source.tar');
    execFileSync('tar', ['-cf', tar, '-C', dir, '.']);
    const expanded = readFileSync(tar);
    execFileSync('gzip', ['-n', tar]);
    const compressed = readFileSync(tar + '.gz');
    const fields: Record<string, string> = {
      ...baseline,
      name: 'wander',
      confirmDowntime: '1',
      sourceCommit: 'e'.repeat(40),
      requestKey: 'fixture',
      sourceDigest: 'sha256:' + createHash('sha256').update(compressed).digest('hex'),
      sourceArchiveDigest: 'sha256:' + createHash('sha256').update(expanded).digest('hex'),
    };
    delete fields.application;
    const upload = (overrides: Record<string, string> = {}) => {
      const form = new FormData();
      for (const [k, v] of Object.entries({ ...fields, ...overrides })) form.set(k, v);
      form.set('file', new Blob([compressed]), 'source.tar.gz');
      return request(cap + '/upload', { method: 'POST', headers: auth(), body: form });
    };
    assert.equal((await upload({ sourceDigest: 'sha256:' + '0'.repeat(64) })).status, 400);
    assert.equal(adopted, null);
    assert.equal((await upload({ sourceArchiveDigest: 'sha256:' + '0'.repeat(64) })).status, 400);
    assert.equal(adopted, null);
    assert.equal((await upload({ extraCapability: 'host' })).status, 400);
    assert.equal((await upload()).status, 200);
    assert.ok(adopted);
    assert.deepEqual(readFileSync(getArtifact(fields.sourceDigest)!.localPath), compressed);
    assert.equal((adopted as WanderIntent).specDigest, WANDER_MANAGED_DIGEST);
  });
}
