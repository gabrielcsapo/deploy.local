import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { compileDeployYaml } from './application-spec.ts';

const cliPath = resolve(import.meta.dirname, '..', 'bin', 'deploy.js');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>, git = false) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-cli-bundle-'));
  dirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  if (git) execFileSync('git', ['init', '--quiet'], { cwd: dir });
  return dir;
}

function listFiles(dir: string) {
  return runCli(dir, 'files');
}

function runCli(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
}

function runCliAsync(dir: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolveResult, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], {
        cwd: dir,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      child.on('error', reject);
      child.on('close', (status) => resolveResult({ status, stdout, stderr }));
    },
  );
}

describe('CLI deployment manifest bundling', () => {
  it('copies the v1 YAML schema', () => {
    const dir = project({});
    const yamlSchema = runCli(dir, 'schema');
    assert.equal(yamlSchema.status, 0, yamlSchema.stderr);
    assert.match(yamlSchema.stdout, /deploy\.v1\.schema\.json/);
    assert.equal(existsSync(join(dir, 'deploy.v1.schema.json')), true);
  });

  it('includes deploy.yaml when it is gitignored', () => {
    const dir = project(
      {
        '.gitignore': 'deploy.yaml\n',
        'deploy.yaml': `apiVersion: deploy.local/v1
kind: Application
components:
  web:
    build: { context: . }
    interfaces:
      http: { port: 3000, protocol: http }
routes:
  public: { to: web.http }
`,
        'index.js': '',
      },
      true,
    );

    const result = listFiles(dir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^  deploy\.yaml$/m);
  });

  it('unions build.ignore from every local deploy.yaml component', () => {
    const dir = project(
      {
        'deploy.yaml': `apiVersion: deploy.local/v1
kind: Application
components:
  web:
    build:
      context: .
      ignore: [docs]
    interfaces:
      http: { port: 3000, protocol: http }
  worker:
    build:
      context: .
      ignore: [fixtures, docs]
routes:
  public: { to: web.http }
`,
        'src/index.js': '',
        'docs/guide.md': 'ignored\n',
        'fixtures/data.json': '{}',
      },
      true,
    );

    const result = listFiles(dir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Custom ignore: docs, fixtures/);
    assert.match(result.stdout, /^  deploy\.yaml$/m);
    assert.match(result.stdout, /^  src\/index\.js$/m);
    assert.doesNotMatch(result.stdout, /^  docs\/guide\.md$/m);
    assert.doesNotMatch(result.stdout, /^  fixtures\/data\.json$/m);
  });

  it('reports invalid deploy.yaml instead of silently changing the bundle', () => {
    const dir = project({
      'deploy.yaml': `apiVersion: deploy.local/v1
kind: Application
components:
  web:
    build: { context: . }
    surprise: ignored
`,
      'index.js': '',
    });

    const result = listFiles(dir);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /deploy\.yaml\.components\.web has unknown field "surprise"/);
    assert.doesNotMatch(result.stdout, /Bundle contents/);
  });

  it('preserves filesystem bundling for projects without a manifest', () => {
    const dir = project({ 'index.js': '', 'README.md': 'example\n' });

    const result = listFiles(dir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Strategy: filesystem/);
    assert.match(result.stdout, /^  index\.js$/m);
    assert.match(result.stdout, /^  README\.md$/m);
  });
});

describe('CLI application validation', () => {
  it('prints the digest and graph summary for deploy.yaml', () => {
    const dir = project({
      'deploy.yaml': `apiVersion: deploy.local/v1
kind: Application
configuration:
  password:
    type: secret
    required: true
  localToken:
    type: string
    required: true
    scope: site
components:
  web:
    build: { context: . }
    instances: 2
    interfaces:
      http: { port: 3000, protocol: http }
  worker:
    build: { context: . }
    role: worker
routes:
  public: { to: web.http }
`,
    });

    const result = runCli(dir, 'validate');

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /✓ deploy\.yaml is valid/);
    assert.match(result.stdout, /API: deploy\.local\/v1/);
    assert.match(result.stdout, /Digest: sha256:[a-f0-9]{64}/);
    assert.match(result.stdout, /Graph: 2 components \/ 3 instances, 1 route, 0 resources, 0 jobs/);
    assert.match(result.stdout, /Components: web x2, worker/);
    assert.match(result.stdout, /Configuration: 2 declared, 2 required, 1 secret, 1 site-scoped/);
  });

  it('requires deploy.yaml for validation', () => {
    const result = runCli(project({ 'index.js': '' }), 'validate');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /deploy\.yaml is required/);
  });

  it('exits nonzero with path-aware manifest errors', () => {
    const dir = project({
      'deploy.yaml': `apiVersion: deploy.local/v1
kind: Application
components:
  web:
    build: { context: . }
    instances: 0
`,
    });

    const result = runCli(dir, 'validate');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /deploy\.yaml\.components\.web\.instances/);
    assert.match(result.stderr, /integer between 1 and 256/);
    assert.doesNotMatch(result.stdout, /is valid/);
  });
});

describe('CLI application planning', () => {
  it('compares the local graph with the authenticated server revision without mutation', async () => {
    const currentSource = `apiVersion: deploy.local/v1
kind: Application
components:
  web:
    build: { context: . }
    interfaces:
      http: { port: 3000, protocol: http }
routes:
  public: { to: web.http }
`;
    const desiredSource = currentSource.replace(
      'build: { context: . }',
      'build: { context: . }\n    instances: 2',
    );
    const current = compileDeployYaml(currentSource);
    const projectDir = project({ 'deploy.yaml': desiredSource });
    const credentialDir = project({});
    const requests: Array<{ method: string; path: string; username?: string; token?: string }> = [];
    const server = createServer((request, response) => {
      requests.push({
        method: request.method || '',
        path: request.url || '',
        username: request.headers['x-deploy-username'] as string | undefined,
        token: request.headers['x-deploy-token'] as string | undefined,
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          desiredDigest: current.digest,
          activeDigest: current.digest,
          desired: current.spec,
          revisions: [],
        }),
      );
    });
    await new Promise<void>((resolveListen) => server.listen(0, resolveListen));
    const { port } = server.address() as AddressInfo;
    writeFileSync(
      join(credentialDir, '.deployrc'),
      JSON.stringify({ username: 'alice', token: 'test-token' }),
    );

    try {
      const result = await runCliAsync(
        projectDir,
        ['plan', '--app', 'notes', '-u', `http://127.0.0.1:${port}`],
        { HOME: credentialDir },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Plan for notes/);
      assert.match(result.stdout, /component-scale: Scale component "web" from 1 to 2/);
      assert.match(result.stdout, /Approval: not required/);
      assert.deepEqual(requests, [
        {
          method: 'GET',
          path: '/api/deployments/notes/application-spec',
          username: 'alice',
          token: 'test-token',
        },
      ]);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});

describe('CLI v1 administration', () => {
  it('requests one durable app/site manual suitcase sync with admin credentials', async () => {
    const workingDirectory = project({});
    const credentialDirectory = project({});
    let received: { method?: string; path?: string; body?: unknown } = {};
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on('end', () => {
        received = {
          method: request.method,
          path: request.url,
          body: body ? JSON.parse(body) : undefined,
        };
        response.writeHead(202, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'event_sync_request',
            appId: 'app-notes',
            siteId: 'site-trip',
            status: 'requested',
            reused: false,
          }),
        );
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, resolveListen));
    const { port } = server.address() as AddressInfo;
    writeFileSync(
      join(credentialDirectory, '.deployrc'),
      JSON.stringify({ username: 'admin', token: 'admin-token' }),
    );
    try {
      const result = await runCliAsync(
        workingDirectory,
        ['suitcase', 'sync', 'app', 'app-notes', 'site-trip', '-u', `http://127.0.0.1:${port}`],
        { HOME: credentialDirectory },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Manual sync event_sync_request requested/);
      assert.deepEqual(received, {
        method: 'POST',
        path: '/api/fleet/apps/app-notes/sync',
        body: { siteId: 'site-trip' },
      });
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('prints capacity evidence and sends the exact selected workload and target probe request', async () => {
    const workingDirectory = project({});
    const credentialDirectory = project({});
    let received: { method?: string; path?: string; body?: unknown } = {};
    const gib = 1024 ** 3;
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on('end', () => {
        received = {
          method: request.method,
          path: request.url,
          body: body ? JSON.parse(body) : undefined,
        };
        response.writeHead(201, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            selectedAppIds: ['app-notes'],
            minimumMemoryBytes: 8 * gib,
            recommendedMemoryBytes: 12 * gib,
            minimumStorageBytes: 64 * gib,
            recommendedStorageBytes: 96 * gib,
            evidenceSummary: { measured: 3, declared: 1, default: 2, unknown: 1 },
            contributors: [
              {
                category: 'memory',
                name: 'Concurrent runtime peak',
                bytes: 4 * gib,
                confidence: 'measured',
                source: '30-day retained resource metrics',
              },
              {
                category: 'storage',
                name: 'Current durable data',
                bytes: 20 * gib,
                confidence: 'measured',
                source: 'verified volume checkpoints',
              },
            ],
            unknowns: ['Build RSS has not been measured yet.'],
            targetComparison: {
              siteName: 'Travel Pi',
              status: 'minimum-only',
              memory: { availableBytes: 8 * gib, status: 'minimum-only' },
              storage: { availableBytes: 80 * gib, status: 'minimum-only' },
              blockers: [],
            },
          }),
        );
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, resolveListen));
    const { port } = server.address() as AddressInfo;
    writeFileSync(
      join(credentialDirectory, '.deployrc'),
      JSON.stringify({ username: 'admin', token: 'admin-token' }),
    );
    try {
      const result = await runCliAsync(
        workingDirectory,
        [
          'suitcase',
          'capacity',
          'app-notes',
          '--trip-days',
          '21',
          '--growth-gib',
          '0.5',
          '--backups',
          '3',
          '--offline-builds',
          '--site',
          'site-trip',
          '-u',
          `http://127.0.0.1:${port}`,
        ],
        { HOME: credentialDirectory },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Suitcase capacity for 1 application/);
      assert.match(result.stdout, /Concurrent runtime peak \[measured\]/);
      assert.match(result.stdout, /Target Travel Pi: minimum only/);
      assert.match(result.stdout, /Build RSS has not been measured yet/);
      assert.deepEqual(received, {
        method: 'POST',
        path: '/api/fleet/capacity-plans',
        body: {
          selectedAppIds: ['app-notes'],
          tripHorizonDays: 21,
          offlineBuilds: true,
          projectedDailyGrowthBytes: 512 * 1024 ** 2,
          retainedBackupCopies: 3,
          targetSiteId: 'site-trip',
        },
      });
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('passes site, component, and exact instance selectors to logs', async () => {
    const workingDirectory = project({});
    const credentialDirectory = project({});
    let requestedPath = '';
    const server = createServer((request, response) => {
      requestedPath = request.url || '';
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('selected instance log\n');
    });
    await new Promise<void>((resolveListen) => server.listen(0, resolveListen));
    const { port } = server.address() as AddressInfo;
    writeFileSync(
      join(credentialDirectory, '.deployrc'),
      JSON.stringify({ username: 'admin', token: 'admin-token' }),
    );

    try {
      const result = await runCliAsync(
        workingDirectory,
        [
          'logs',
          '--app',
          'notes',
          '--site',
          'site-away',
          '--component',
          'worker',
          '--instance',
          'instance-worker-2',
          '-u',
          `http://127.0.0.1:${port}`,
        ],
        { HOME: credentialDirectory },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'selected instance log\n');
      assert.equal(
        requestedPath,
        '/api/deployments/notes/logs?siteId=site-away&component=worker&instanceId=instance-worker-2',
      );
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('browses the catalog and evaluates recovery readiness with admin credentials', async () => {
    const workingDirectory = project({});
    const credentialDirectory = project({});
    const requests: Array<{ path: string; username?: string; token?: string }> = [];
    const server = createServer((request, response) => {
      requests.push({
        path: request.url || '',
        username: request.headers['x-deploy-username'] as string | undefined,
        token: request.headers['x-deploy-token'] as string | undefined,
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      if (request.url?.startsWith('/api/catalog')) {
        response.end(
          JSON.stringify({
            releases: [
              {
                id: 'notes',
                release: '1.0.0',
                name: 'Notes',
                trustTier: 'deploy-local',
                stage: 'supported',
              },
            ],
          }),
        );
      } else {
        response.end(
          JSON.stringify({
            ready: true,
            checks: [{ id: 'CUTOVER.CONTROL_DATABASE', status: 'pass' }],
          }),
        );
      }
    });
    await new Promise<void>((resolveListen) => server.listen(0, resolveListen));
    const { port } = server.address() as AddressInfo;
    writeFileSync(
      join(credentialDirectory, '.deployrc'),
      JSON.stringify({ username: 'admin', token: 'admin-token' }),
    );

    try {
      const environment = { HOME: credentialDirectory };
      const catalog = await runCliAsync(
        workingDirectory,
        ['catalog', 'list', '-u', `http://127.0.0.1:${port}`],
        environment,
      );
      assert.equal(catalog.status, 0, catalog.stderr);
      assert.match(catalog.stdout, /notes@1\.0\.0  Notes  \[deploy-local\/supported\]/);

      const readiness = await runCliAsync(
        workingDirectory,
        ['recovery', 'readiness', '-u', `http://127.0.0.1:${port}`],
        environment,
      );
      assert.equal(readiness.status, 0, readiness.stderr);
      assert.match(readiness.stdout, /CUTOVER\.CONTROL_DATABASE/);
      assert.deepEqual(requests, [
        {
          path: '/api/catalog?query=',
          username: 'admin',
          token: 'admin-token',
        },
        {
          path: '/api/operations/release-readiness',
          username: 'admin',
          token: 'admin-token',
        },
      ]);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('exposes the complete catalog ownership and recovery lifecycle over the CLI', async () => {
    const workingDirectory = project({});
    const credentialDirectory = project({});
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const source = Buffer.concat(chunks).toString('utf8');
        requests.push({
          method: request.method || '',
          path: request.url || '',
          body: source ? JSON.parse(source) : undefined,
        });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        if (request.method === 'GET' && request.url?.endsWith('/installation-1')) {
          response.end(
            JSON.stringify({
              installation: {
                id: 'installation-1',
                applicationName: 'notes',
                revision: 7,
                siteId: 'coordinator',
              },
              recoveryPoints: [],
            }),
          );
          return;
        }
        if (request.url?.endsWith('/recovery-points')) {
          response.end(
            JSON.stringify({
              id: 'recovery-1',
              installationId: 'installation-1',
              status: 'verified',
            }),
          );
          return;
        }
        response.end(
          JSON.stringify({
            installation: { id: 'installation-1', applicationName: 'notes', status: 'healthy' },
            operation: { status: 'succeeded' },
          }),
        );
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, resolveListen));
    const { port } = server.address() as AddressInfo;
    writeFileSync(
      join(credentialDirectory, '.deployrc'),
      JSON.stringify({ username: 'admin', token: 'admin-token' }),
    );
    const environment = { HOME: credentialDirectory };
    const url = `http://127.0.0.1:${port}`;
    const run = (args: string[]) =>
      runCliAsync(workingDirectory, [...args, '-u', url], environment);

    try {
      for (const args of [
        [
          'catalog',
          'install',
          'volume-app-fixture',
          '1.0.0-validation.1',
          '--name',
          'notes',
          '--site',
          'coordinator',
        ],
        ['catalog', 'recovery-point', 'installation-1'],
        [
          'catalog',
          'upgrade',
          'installation-1',
          '1.1.0-validation.1',
          '--recovery-point',
          'recovery-1',
        ],
        ['catalog', 'rollback', 'installation-1', 'recovery-1'],
        [
          'catalog',
          'uninstall',
          'installation-1',
          '--delete-data',
          '--recovery-point',
          'recovery-1',
        ],
        ['catalog', 'detach', 'installation-1'],
        ['catalog', 'derive', 'installation-1', 'notes.local'],
      ]) {
        const result = await run(args);
        assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
      }

      assert.deepEqual(requests, [
        {
          method: 'POST',
          path: '/api/catalog/volume-app-fixture/1.0.0-validation.1/install',
          body: {
            applicationName: 'notes',
            targetSiteId: 'coordinator',
            answers: {},
          },
        },
        {
          method: 'GET',
          path: '/api/catalog/installations/installation-1',
          body: undefined,
        },
        {
          method: 'POST',
          path: '/api/catalog/installations/installation-1/recovery-points',
          body: {},
        },
        {
          method: 'GET',
          path: '/api/catalog/installations/installation-1',
          body: undefined,
        },
        {
          method: 'POST',
          path: '/api/catalog/installations/installation-1/upgrade',
          body: {
            expectedRevision: 7,
            toRelease: '1.1.0-validation.1',
            targetSiteId: 'coordinator',
            answers: {},
            recoveryPointId: 'recovery-1',
          },
        },
        {
          method: 'GET',
          path: '/api/catalog/installations/installation-1',
          body: undefined,
        },
        {
          method: 'POST',
          path: '/api/catalog/installations/installation-1/rollback',
          body: { expectedRevision: 7, recoveryPointId: 'recovery-1' },
        },
        {
          method: 'GET',
          path: '/api/catalog/installations/installation-1',
          body: undefined,
        },
        {
          method: 'POST',
          path: '/api/catalog/installations/installation-1/uninstall',
          body: { expectedRevision: 7, retainData: false, recoveryPointId: 'recovery-1' },
        },
        {
          method: 'GET',
          path: '/api/catalog/installations/installation-1',
          body: undefined,
        },
        {
          method: 'POST',
          path: '/api/catalog/installations/installation-1/detach',
          body: { expectedRevision: 7 },
        },
        {
          method: 'GET',
          path: '/api/catalog/installations/installation-1',
          body: undefined,
        },
        {
          method: 'POST',
          path: '/api/catalog/installations/installation-1/derive',
          body: { expectedRevision: 7, localBlueprintId: 'notes.local' },
        },
      ]);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('exposes component inspect, immutable scale, rolling restart, replacement, and profile operations', async () => {
    const workingDirectory = project({});
    const credentialDirectory = project({});
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const source = Buffer.concat(chunks).toString();
        requests.push({
          method: request.method || '',
          path: request.url || '',
          ...(source ? { body: JSON.parse(source) } : {}),
        });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify(
            request.url?.endsWith('/application-spec')
              ? { desiredDigest: 'sha256:parent', activeDigest: 'sha256:parent' }
              : { status: 'ok' },
          ),
        );
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, resolveListen));
    const { port } = server.address() as AddressInfo;
    writeFileSync(
      join(credentialDirectory, '.deployrc'),
      JSON.stringify({ username: 'admin', token: 'admin-token' }),
    );
    const environment = { HOME: credentialDirectory };
    const url = `http://127.0.0.1:${port}`;
    try {
      for (const args of [
        ['component', 'inspect', 'notes'],
        ['component', 'inspect', 'notes', '--site', 'site-trip'],
        ['component', 'scale', 'notes', 'web', '3'],
        ['component', 'scale', 'notes', 'web', '4', '--site', 'site-trip'],
        ['component', 'scale', 'notes', 'web', '--site', 'site-trip', '--use-default'],
        ['component', 'restart', 'notes', 'web'],
        ['component', 'replace', 'notes', 'web', 'instance-1'],
        ['component', 'operation', 'notes', 'database', 'backup'],
      ]) {
        const result = await runCliAsync(workingDirectory, [...args, '-u', url], environment);
        assert.equal(result.status, 0, result.stderr);
      }
      assert.deepEqual(requests, [
        { method: 'GET', path: '/api/deployments/notes/application-runtime' },
        {
          method: 'GET',
          path: '/api/deployments/notes/application-runtime?siteId=site-trip',
        },
        { method: 'GET', path: '/api/deployments/notes/application-spec' },
        {
          method: 'PUT',
          path: '/api/deployments/notes/components/web/scale',
          body: {
            instances: 3,
            expectedParentDigest: 'sha256:parent',
            confirmDestructive: false,
            scope: 'default',
          },
        },
        { method: 'GET', path: '/api/deployments/notes/application-spec' },
        {
          method: 'PUT',
          path: '/api/deployments/notes/components/web/scale',
          body: {
            instances: 4,
            expectedParentDigest: 'sha256:parent',
            confirmDestructive: false,
            scope: 'site',
            siteId: 'site-trip',
            useDefault: false,
          },
        },
        { method: 'GET', path: '/api/deployments/notes/application-spec' },
        {
          method: 'PUT',
          path: '/api/deployments/notes/components/web/scale',
          body: {
            instances: null,
            expectedParentDigest: 'sha256:parent',
            confirmDestructive: false,
            scope: 'site',
            siteId: 'site-trip',
            useDefault: true,
          },
        },
        { method: 'POST', path: '/api/deployments/notes/components/web/restart' },
        {
          method: 'POST',
          path: '/api/deployments/notes/components/web/instances/instance-1/replace',
        },
        {
          method: 'POST',
          path: '/api/deployments/notes/components/database/operations/backup',
          body: { variables: {} },
        },
      ]);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});
