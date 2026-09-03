import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';

const dataDirectory = mkdtempSync(join(tmpdir(), 'deploy-catalog-api-'));
const fakeBinDirectory = join(dataDirectory, 'fake-bin');
let server: ChildProcess | undefined;
let port = 0;
let adminToken = '';
let memberToken = '';

before(async () => {
  mkdirSync(fakeBinDirectory, { recursive: true });
  writeFileSync(
    join(fakeBinDirectory, 'docker'),
    '#!/bin/sh\nif [ "$1" = "version" ]; then printf "28.0.0\\n"; exit 0; fi\nif [ "$1" = "image" ]; then exit 0; fi\nexit 1\n',
    { mode: 0o755 },
  );
  port = await getPort();
  server = await startServer(port);
  adminToken = await register('admin');
  memberToken = await register('member');
});

after(async () => {
  if (server && server.exitCode === null) {
    await new Promise<void>((resolve) => {
      server!.once('exit', () => resolve());
      server!.kill();
    });
  }
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe('catalog API integration', () => {
  it('uses real session and administrator authorization', async () => {
    assert.equal((await request('/api/catalog')).status, 401);
    assert.equal(
      (await request('/api/catalog', { headers: authHeaders('member', memberToken) })).status,
      403,
    );
    const response = await request('/api/catalog', {
      headers: authHeaders('admin', adminToken),
    });
    assert.equal(response.status, 200);
    const releases = (
      response.body as {
        releases: Array<{ id: string; release: string; upgradeFrom: string[] }>;
      }
    ).releases;
    assert.equal(releases.length, 5);
    assert.deepEqual(
      releases.find(
        (release) =>
          release.id === 'volume-app-fixture' && release.release === '1.1.0-validation.1',
      )?.upgradeFrom,
      ['1.0.0-validation.1'],
    );
  });

  it('admits an installable fixture and writes an ordinary executor revision and placement', async () => {
    const response = await request('/api/catalog/volume-app-fixture/1.0.0-validation.1/install', {
      method: 'POST',
      headers: { ...authHeaders('admin', adminToken), 'content-type': 'application/json' },
      body: JSON.stringify({ applicationName: 'catalog-api-fixture', targetSiteId: 'coordinator' }),
    });
    assert.equal(response.status, 202, JSON.stringify(response.body));
    const result = response.body as {
      installation: { id: string; status: string };
      operation: { status: string };
    };
    assert.equal(result.installation.status, 'installing');
    assert.equal(result.operation.status, 'running');

    const detail = await request(`/api/catalog/installations/${result.installation.id}`, {
      headers: authHeaders('admin', adminToken),
    });
    assert.equal(detail.status, 200);
    assert.equal(
      (detail.body as { installation: { status: string } }).installation.status,
      'installing',
    );

    const sqlite = new Database(join(dataDirectory, 'deploy.db'), { readonly: true });
    const deployment = sqlite
      .prepare('SELECT spec_source, desired_spec_digest, status FROM deployments WHERE name = ?')
      .get('catalog-api-fixture') as
      | { spec_source: string; desired_spec_digest: string; status: string }
      | undefined;
    const placement = sqlite
      .prepare(
        'SELECT desired_instances, state FROM component_placements WHERE deployment_name = ?',
      )
      .get('catalog-api-fixture') as { desired_instances: number; state: string } | undefined;
    sqlite.close();
    assert.equal(deployment?.spec_source, 'catalog');
    assert.match(deployment?.desired_spec_digest ?? '', /^sha256:/);
    assert.equal(deployment?.status, 'starting');
    assert.deepEqual(placement, { desired_instances: 1, state: 'pending' });
  });

  it('derives Home Assistant target grants server-side and rejects forged capability documents', async () => {
    const endpoint = '/api/catalog/home-assistant-container/2026.8.0-validation.1/preflight';
    const blocked = await request(endpoint, {
      method: 'POST',
      headers: { ...authHeaders('admin', adminToken), 'content-type': 'application/json' },
      body: JSON.stringify({ applicationName: 'home-assistant', targetSiteId: 'coordinator' }),
    });
    assert.equal(blocked.status, 200);
    assert.equal((blocked.body as { ready: boolean }).ready, false);

    const forged = await request(endpoint, {
      method: 'POST',
      headers: { ...authHeaders('admin', adminToken), 'content-type': 'application/json' },
      body: JSON.stringify({
        applicationName: 'home-assistant',
        target: {
          ...target,
          capabilities: {
            ...target.capabilities,
            privilegedContainers: true,
            hostNetwork: true,
            lanDiscovery: true,
          },
        },
      }),
    });
    assert.equal(forged.status, 400);
    assert.match((forged.body as { error: string }).error, /derived by the server/);
  });

  it('stages the PostgreSQL graph when capacity is available and otherwise preserves the capacity gate', async () => {
    const secret = 'catalog-worker-secret';
    const installBody = {
      applicationName: 'catalog-postgres-fixture',
      targetSiteId: 'coordinator',
      answers: { 'worker-token': secret },
    };
    const response = await request(
      '/api/catalog/postgres-service-graph-fixture/1.0.0-validation.1/install',
      {
        method: 'POST',
        headers: { ...authHeaders('admin', adminToken), 'content-type': 'application/json' },
        body: JSON.stringify(installBody),
      },
    );
    const storage = statfsSync(dataDirectory);
    const availableStorageMiB = Math.floor(
      (Number(storage.bavail) * Number(storage.bsize)) / 1024 ** 2,
    );
    if (availableStorageMiB < 16_384) {
      assert.equal(response.status, 400);
      const plan = await request(
        '/api/catalog/postgres-service-graph-fixture/1.0.0-validation.1/install-plan',
        {
          method: 'POST',
          headers: { ...authHeaders('admin', adminToken), 'content-type': 'application/json' },
          body: JSON.stringify(installBody),
        },
      );
      assert.equal(plan.status, 200);
      assert.equal((plan.body as { ready: boolean }).ready, false);
      assert.ok(
        (plan.body as { blockers: Array<{ id: string }> }).blockers.some(
          (blocker) => blocker.id === 'capacity-storage',
        ),
      );
      return;
    }
    assert.equal(response.status, 202, JSON.stringify(response.body));
    assert.doesNotMatch(JSON.stringify(response.body), new RegExp(secret));

    const sqlite = new Database(join(dataDirectory, 'deploy.db'), { readonly: true });
    const placements = sqlite
      .prepare(
        'SELECT component_key, desired_instances FROM component_placements WHERE deployment_name = ? ORDER BY component_key',
      )
      .all('catalog-postgres-fixture') as Array<{
      component_key: string;
      desired_instances: number;
    }>;
    const configuration = sqlite
      .prepare(
        'SELECT value, value_type FROM application_configuration_values WHERE deployment_name = ?',
      )
      .get('catalog-postgres-fixture') as { value: string; value_type: string } | undefined;
    sqlite.close();
    assert.deepEqual(placements, [
      { component_key: 'nginx', desired_instances: 1 },
      { component_key: 'postgres', desired_instances: 1 },
      { component_key: 'web', desired_instances: 2 },
      { component_key: 'worker', desired_instances: 1 },
    ]);
    assert.equal(configuration?.value_type, 'secret');
    assert.doesNotMatch(configuration?.value ?? '', new RegExp(secret));
  });
});

const target = {
  siteId: 'coordinator',
  deployLocalVersion: '1.0.0',
  operatingSystem: 'linux',
  architecture: 'amd64',
  engine: 'docker-engine',
  engineVersion: '28.0.0',
  memoryMiB: 8192,
  storageMiB: 65536,
  cpuCores: 8,
  online: true,
  cachedArtifactDigests: [],
  capabilities: {
    privilegedContainers: false,
    hostNetwork: false,
    lanDiscovery: false,
    hostPaths: [],
    devices: [],
    dockerSocket: false,
  },
};

async function register(username: string): Promise<string> {
  const response = await request('/api/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'test-password' }),
  });
  assert.equal(response.status, 201);
  return (response.body as { token: string }).token;
}

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  return { status: response.status, body: (await response.json()) as unknown };
}

function authHeaders(username: string, token: string) {
  return { 'x-deploy-username': username, 'x-deploy-token': token };
}

async function getPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address() as AddressInfo;
      probe.close(() => resolve(address.port));
    });
    probe.on('error', reject);
  });
}

async function startServer(httpPort: number): Promise<ChildProcess> {
  const httpsPort = await getPort();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'server.ts')], {
      env: {
        ...process.env,
        PORT: String(httpPort),
        HTTPS_PORT: String(httpsPort),
        DEPLOY_DATA_DIR: dataDirectory,
        DEPLOY_CATALOG_STAGE_ONLY: '1',
        PATH: `${fakeBinDirectory}:${process.env.PATH ?? ''}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Catalog API server did not start: ${stderr}`));
    }, 60_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      if (!chunk.toString().includes('running on')) return;
      clearTimeout(timeout);
      resolve(child);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Catalog API server exited with code ${code}: ${stderr}`));
    });
  });
}
