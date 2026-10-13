import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const enabled = process.env.DEPLOY_WANDER_DOCKER_TESTS === '1';
const docker = (...args: string[]) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DOCKER_BUILDKIT: '0' },
  }).trim();
const image = 'node@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0';
test(
  'real Docker: cold copy, missing provider refusal, create-row crash recovery, appID/HTTP/data continuity and retired legacy protection',
  { skip: !enabled, timeout: 120000 },
  async () => {
    process.env.DOCKER_BUILDKIT = '0';
    const root = mkdtempSync(join(tmpdir(), 'wander-adoption-docker-'));
    process.env.DEPLOY_DATA_DIR = root;
    const store = await import('./store.ts');
    const { wanderAdoptionService, wanderAdoptionPreflight } =
      await import('./wander-adoption-service.ts');
    const { readWanderJournal, wanderReservation, assertWanderLegacyAllowed } =
      await import('./wander-adoption-fence.ts');
    const { DockerCliGraphAdapter, graphNetworkName } = await import('./graph-docker-adapter.ts');
    const suffix = randomUUID().slice(0, 8),
      originalName = 'wander-adoption-fixture-' + suffix;
    const source = join(root, 'uploads', '.extract-fixture');
    mkdirSync(source, { recursive: true });
    const program = `import http from 'node:http';import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync('/app/data/wander.db');db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE IF NOT EXISTS trips(label TEXT)');if(!db.prepare('SELECT * FROM trips').get())db.exec("INSERT INTO trips VALUES('preserved')");fs.writeFileSync('/app/uploads/preserved.txt','original upload');http.createServer((req,res)=>{res.end(JSON.stringify({trip:db.prepare('SELECT label FROM trips').get().label,upload:fs.readFileSync('/app/uploads/preserved.txt','utf8')}))}).listen(3000,'0.0.0.0');`;
    writeFileSync(join(source, 'app.mjs'), program);
    writeFileSync(
      join(source, 'Dockerfile'),
      `FROM ${image}\nWORKDIR /app\nCOPY app.mjs /app/app.mjs\nCMD ["node","/app/app.mjs"]\n`,
    );
    writeFileSync(
      join(source, 'deploy.yaml'),
      readFileSync(new URL('./fixtures/wander-adoption/deploy.yaml', import.meta.url)),
    );
    const oldRoot = join(root, 'volumes', 'wander');
    for (const n of ['data', 'uploads']) mkdirSync(join(oldRoot, n), { recursive: true });
    const tag = 'wander-adoption-fixture:' + suffix;
    let original = '';
    let appId = '';
    let journalId = '';
    const create = DockerCliGraphAdapter.prototype.createContainer,
      network = DockerCliGraphAdapter.prototype.ensureNetwork;
    try {
      docker('image', 'inspect', image);
      docker('build', '--network', 'none', '-t', tag, source);
      original = docker(
        'run',
        '-d',
        '--name',
        originalName,
        '-p',
        '127.0.0.1::3000',
        '--mount',
        'type=bind,src=' + join(oldRoot, 'data') + ',dst=/app/data',
        '--mount',
        'type=bind,src=' + join(oldRoot, 'uploads') + ',dst=/app/uploads',
        tag,
      );
      const inspect = () => JSON.parse(docker('inspect', original))[0];
      const port = inspect().NetworkSettings.Ports['3000/tcp'][0].HostPort;
      for (let i = 0; i < 40; i++) {
        try {
          if ((await fetch('http://127.0.0.1:' + port + '/api/health')).ok) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      store.registerUser('fixture-owner', 'synthetic-only-password');
      store.registerUser('fixture-member', 'synthetic-only-password');
      store.ensureCoordinatorNode();
      store.setDefaultNode('coordinator');
      store.saveDeployment({
        name: 'wander',
        username: 'fixture-owner',
        type: 'application-graph',
        port: Number(port),
        containerId: original,
        containerName: 'deploy-sh-wander',
        directory: source,
        activeNodeId: 'coordinator',
        desiredNodeId: 'coordinator',
      });
      const { compileDeployYaml } = await import('./application-spec.ts');
      const legacy = compileDeployYaml(
        readFileSync(
          new URL('./fixtures/wander-adoption/deploy.yaml', import.meta.url),
          'utf8',
        ).replace('category: travel', 'category: legacy-fixture'),
      );
      store.saveDesiredApplicationSpec({
        deploymentName: 'wander',
        digest: legacy.digest,
        apiVersion: 'deploy.local/v1',
        source: 'repository',
        manifestFormat: 'deploy.yaml',
        normalizedSpec: legacy.canonicalJson,
        originalSource: 'fixture legacy',
        createdBy: 'fixture-owner',
      });
      store.updateDeploymentArtifactDigests('wander', {
        sourceArtifactDigest: 'sha256:' + 'b'.repeat(64),
      });
      store.updateDeploymentStatus('wander', 'running');
      appId = (await import('./multisite.ts')).registerApplicationIdentity('wander');
      assert.throws(() => wanderAdoptionService('fixture-member'), { status: 404 });
      const preflight = await wanderAdoptionPreflight('fixture-owner');
      const service = wanderAdoptionService('fixture-owner');
      DockerCliGraphAdapter.prototype.ensureNetwork = async () => {
        throw Error('injected before candidate create');
      };
      await assert.rejects(
        () =>
          service.adopt({
            ...preflight,
            sourceDirectory: source,
            sourceCommit: 'c'.repeat(40),
            sourceDigest: 'sha256:' + 'd'.repeat(64),
            sourceArchiveDigest: 'sha256:' + 'e'.repeat(64),
            requestKey: 'fixture',
          }),
        /injected before candidate/,
      );
      DockerCliGraphAdapter.prototype.ensureNetwork = network;
      let j = readWanderJournal()!;
      journalId = j.id;
      assert.equal(j.phase, 'starting');
      assert.equal(inspect().State.Running, false);
      assert.equal(j.snapshot !== null, true);
      assert.equal(wanderReservation('wander'), j.id);
      const { startAllContainers } = await import('./lifecycle.ts');
      await startAllContainers();
      assert.equal(inspect().State.Running, false);
      const provider = j.providers.uploads.name;
      docker('volume', 'rm', provider);
      await assert.rejects(() => service.recover(j.id), /disappeared|missing/);
      assert.throws(() => docker('volume', 'inspect', provider));
      assert.equal(inspect().State.Running, false);
      // Only disposable fixture resources: restore the intentionally removed provider
      // from this test's verified backup to exercise subsequent interruption cases.
      docker(
        'volume',
        'create',
        '--label',
        'deploy-sh.app-id=' + appId,
        '--label',
        'deploy-sh.resource=uploads',
        '--label',
        'deploy-sh.wander-adoption=' + j.id,
        provider,
      );
      docker(
        'run',
        '--rm',
        '--network',
        'none',
        '--mount',
        'type=volume,src=' + provider + ',dst=/destination',
        '--mount',
        'type=bind,src=' + j.snapshot!.directory + ',dst=/backup,readonly',
        '--entrypoint',
        'tar',
        image,
        '--numeric-owner',
        '-xzpf',
        '/backup/uploads.tar.gz',
        '-C',
        '/destination',
      );
      DockerCliGraphAdapter.prototype.createContainer = async function (request) {
        await create.call(this, request);
        throw Error('injected after Docker create before graph row');
      };
      await assert.rejects(() => service.recover(j.id), /injected after Docker create/);
      DockerCliGraphAdapter.prototype.createContainer = create;
      j = readWanderJournal()!;
      assert.equal(j.candidateContainer, null);
      assert.ok(j.candidateName);
      assert.equal(
        store.getApplicationGraphState('wander', appId, 'coordinator').instances.length,
        0,
      );
      const result = await service.recover(j.id);
      assert.equal(result.status, 'committed');
      assert.equal(inspect().State.Running, false);
      assert.equal(store.getDeployment('wander')!.appId, appId);
      assert.throws(() => assertWanderLegacyAllowed('wander'), { status: 409 });
      const candidate = JSON.parse(docker('inspect', result.containerId!))[0];
      const newPort = candidate.NetworkSettings.Ports['3000/tcp'][0].HostPort;
      assert.deepEqual(await (await fetch('http://127.0.0.1:' + newPort + '/api/health')).json(), {
        trip: 'preserved',
        upload: 'original upload',
      });
      assert.equal(candidate.Mounts.length, 2);
      assert.ok(candidate.Mounts.every((m: { Type: string }) => m.Type === 'volume'));
      assert.equal(readWanderJournal()!.activePid, null);
      // A committed adoption must remain eligible for normal app-scoped CI.
      (await import('./certs.ts')).ensureCerts(['wander']); // private fixture certificates, no trust installation
      const { apiMiddleware } = await import('./api.ts');
      const ci = await import('./ci-releases.ts');
      const handler = apiMiddleware();
      const server = createServer((req, res) =>
        handler(req, res, () => {
          res.writeHead(404);
          res.end();
        }),
      );
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('No synthetic API port');
      try {
        const auth = ci.issueCiCredential('fixture-owner', 'wander', 60);
        const credential = ci.authenticateCi(auth.token);
        const head = ci.ciHead(credential);
        writeFileSync(join(j.sourceDirectory, 'app.mjs'), program + '\n// tested next release\n');
        const tar = join(root, 'ci-source.tar');
        docker('image', 'inspect', j.image!);
        execFileSync('tar', ['-cf', tar, '-C', j.sourceDirectory, '.']);
        const expanded = readFileSync(tar);
        execFileSync('gzip', ['-n', tar]);
        const compressed = readFileSync(tar + '.gz');
        const headers = { 'x-deploy-ci-token': auth.token };
        const url = 'http://127.0.0.1:' + address.port;
        const admitted = await fetch(url + '/api/ci/releases', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            application: 'wander',
            sourceCommit: 'f'.repeat(40),
            sourceDigest: 'sha256:' + createHash('sha256').update(compressed).digest('hex'),
            sourceArchiveDigest: 'sha256:' + createHash('sha256').update(expanded).digest('hex'),
            expectedRelease: head.releaseId,
            idempotencyKey: 'after-adoption',
          }),
        });
        const receipt = await admitted.json();
        assert.equal(admitted.status, 202, JSON.stringify(receipt));
        const form = new FormData();
        form.set('name', 'wander');
        form.set('detached', '1');
        form.set('file', new Blob([compressed]), 'source.tar.gz');
        const uploaded = await fetch(url + '/api/ci/releases/' + receipt.releaseId + '/upload', {
          method: 'POST',
          headers,
          body: form,
        });
        assert.equal(uploaded.status, 202, await uploaded.text());
        let final;
        for (let n = 0; n < 600; n++) {
          final = await (
            await fetch(url + '/api/ci/releases/' + receipt.releaseId, { headers })
          ).json();
          if (['healthy', 'failed'].includes(final.status)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.equal(
          final.status,
          'healthy',
          JSON.stringify({ receipt: final, log: store.getLatestBuildLog('wander') }),
        );
        assert.equal(store.getDeployment('wander')!.appId, appId);
        assert.equal(inspect().State.Running, false);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      }
    } finally {
      DockerCliGraphAdapter.prototype.createContainer = create;
      DockerCliGraphAdapter.prototype.ensureNetwork = network;
      for (const filter of [
        appId ? 'label=deploy-sh.app-id=' + appId : 'label=fixture-unused',
        journalId ? 'label=deploy-sh.wander-adoption=' + journalId : 'label=fixture-unused',
      ])
        for (const id of docker('ps', '-aq', '--filter', filter).split('\n').filter(Boolean))
          docker('rm', '-f', id);
      if (original) docker('rm', '-f', original);
      if (appId) {
        for (const v of docker('volume', 'ls', '-q', '--filter', 'label=deploy-sh.app-id=' + appId)
          .split('\n')
          .filter(Boolean))
          docker('volume', 'rm', v);
        try {
          docker('network', 'rm', graphNetworkName(appId));
        } catch {}
        for (const t of docker('images', '--format', '{{.Repository}}:{{.Tag}}')
          .split('\n')
          .filter((t) => t.includes(appId.replace(/[^a-zA-Z0-9_.-]/g, '-'))))
          try {
            docker('image', 'rm', t);
          } catch {}
      }
      // Remove root-owned disposable SQLite WAL files with a helper confined to this fixture.
      docker(
        'run',
        '--rm',
        '--network',
        'none',
        '--mount',
        'type=bind,src=' + root + ',dst=/fixture',
        '--entrypoint',
        'sh',
        image,
        '-c',
        'rm -rf /fixture/*',
      );
      try {
        docker('image', 'rm', tag);
      } catch {}
      store._resetDb();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
