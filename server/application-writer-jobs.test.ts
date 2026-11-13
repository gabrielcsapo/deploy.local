import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import type { GraphCommandResult, GraphContainerCreateRequest } from './graph-docker-adapter.ts';

const root = mkdtempSync(join(tmpdir(), 'deploy-writer-jobs-'));
process.env.DEPLOY_DATA_DIR = root;
// Nothing here may reach a real daemon, so even an unfaked call lands on a socket this file owns.
process.env.DOCKER_HOST = `unix://${join(root, 'docker.sock')}`;

const store = await import('./store.ts');
const specs = await import('./application-spec.ts');
const localSite = await import('./local-site.ts');
const contentStore = await import('./content-store.ts');
const { DockerCliGraphAdapter } = await import('./graph-docker-adapter.ts');
const { containersRoutes } = await import('./api/containers.ts');
const { deploymentsRoutes } = await import('./api/deployments.ts');
const { startApplicationGraphSupervisor } = await import('./application-graph-supervisor.ts');
const { executeAgentApplicationGraph } = await import('./agent-graph-runtime.ts');
const { startAllContainers } = await import('./lifecycle.ts');

const USER = 'writer-owner';
const PASSWORD = 'correct horse battery staple';

function manifest(execution: string, label = 'one') {
  return `
apiVersion: deploy.local/v1
kind: Application
metadata:
  name: writer-app
  labels:
    revision: ${label}
components:
  web:
    image: example/web:1
    role: web
    interfaces:
      http: { port: 3000, protocol: http }
routes:
  public: { to: web.http }
jobs:
  migrate:
    component: web
    command: [migrate, up]
    execution: ${execution}
    beforeTraffic: true
`;
}

/** Stands in for the Docker CLI, below the real executor, state store and authority lookup. */
class FakeDockerCli {
  containers = new Map<string, { running: boolean; ports: Record<number, number> }>();
  oneShots: GraphContainerCreateRequest[] = [];
  oneShotExitCode = 0;
  async prepareImage(input: { source: { kind: string; reference?: string } }) {
    return input.source.reference ?? 'local/image:1';
  }
  async ensureNetwork() {}
  async ensureVolume() {}
  async volumeExists() {
    return true;
  }
  async removeNetwork() {}
  async removeVolume() {}
  async createContainer(request: GraphContainerCreateRequest) {
    const ports = Object.fromEntries(request.publishPorts.map((port) => [port, 41_000 + port]));
    this.containers.set(request.name, { running: false, ports });
    return { id: `id-${request.name}`, name: request.name };
  }
  async startContainer(name: string) {
    this.containers.get(name)!.running = true;
  }
  async inspectContainer(name: string) {
    const container = this.containers.get(name);
    return {
      id: container ? `id-${name}` : '',
      name,
      exists: Boolean(container),
      running: container?.running ?? false,
      status: container?.running ? 'running' : 'missing',
      health: container?.running ? 'healthy' : 'none',
      hostPorts: container?.ports ?? {},
    };
  }
  async waitHealthy(name: string) {
    return this.containers.get(name)?.running ?? false;
  }
  async stopContainer(name: string) {
    const container = this.containers.get(name);
    if (container) container.running = false;
  }
  async removeContainer(name: string) {
    this.containers.delete(name);
  }
  async runOneShot(request: GraphContainerCreateRequest): Promise<GraphCommandResult> {
    this.oneShots.push(request);
    return { exitCode: this.oneShotExitCode, output: this.oneShotExitCode ? 'boom' : 'ok' };
  }
  async exec(): Promise<GraphCommandResult> {
    return { exitCode: 0, output: 'ok' };
  }
}

let docker = new FakeDockerCli();
for (const name of Object.getOwnPropertyNames(FakeDockerCli.prototype)) {
  if (name === 'constructor') continue;
  mock.method(
    DockerCliGraphAdapter.prototype,
    name as never,
    ((...args: unknown[]) => (docker as any)[name](...args)) as never,
  );
}

let server: Server;
let baseUrl = '';
let token = '';
const routeContext = {
  workspacePath: root,
};

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', 'http://localhost');
  const ctx = { ...routeContext, req, res, path: url.pathname, method: req.method, url };
  if (await containersRoutes(ctx)) return;
  if (await deploymentsRoutes(ctx)) return;
  res.writeHead(404).end();
}

before(async () => {
  store.getDb();
  localSite.ensureLocalIdentity();
  token = (store.registerUser(USER, PASSWORD) as { token: string }).token;
  server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      res.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  mock.restoreAll();
  await new Promise((done) => server.close(done));
  store._resetDb();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  docker = new FakeDockerCli();
});

function post(path: string, body?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'x-deploy-username': USER, 'x-deploy-token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function seedApp(name: string, execution: string, activeNodeId: string) {
  const directory = join(root, 'apps', name);
  mkdirSync(directory, { recursive: true });
  store.saveDeployment({
    name,
    username: USER,
    directory,
    activeNodeId,
    desiredNodeId: activeNodeId,
  });
  const compiled = specs.compileDeployYaml(manifest(execution));
  store.saveDesiredApplicationSpec({
    digest: compiled.digest,
    deploymentName: name,
    apiVersion: compiled.spec.apiVersion,
    source: 'repository',
    manifestFormat: 'deploy.yaml',
    normalizedSpec: compiled.canonicalJson,
    createdBy: USER,
  });
  store.activateDesiredApplicationSpec(name, compiled.digest);
  const appId = localSite.registerApplicationIdentity(name);
  store._invalidateDeploymentsCache();
  store.updateDeploymentStatus(name, 'running');
  return { appId, compiled };
}

function jobRows(appId: string) {
  return store
    .getSqlite()!
    .prepare(
      `SELECT site_id AS siteId, job_key AS job, scope, status, attempts
         FROM component_job_executions WHERE app_id = ?`,
    )
    .all(appId) as {
    siteId: string;
    job: string;
    scope: string;
    status: string;
    attempts: number;
  }[];
}

describe('writerSite jobs through the real routes', () => {
  it('restarting an app on this machine runs its writerSite job once', async () => {
    // The two ids differ on every real coordinator: instances live under one, Home is the other.
    assert.notEqual(localSite.ensureLocalIdentity().homeSiteId, 'coordinator');
    const { appId } = seedApp('writer-local', 'writerSite', 'coordinator');

    const first = await post('/api/deployments/writer-local/restart');
    assert.equal(first.status, 200, await first.text());
    assert.equal(docker.oneShots.length, 1, 'the writerSite job ran');
    assert.deepEqual(jobRows(appId), [
      {
        siteId: 'coordinator',
        job: 'migrate',
        scope: 'writerSite',
        status: 'succeeded',
        attempts: 1,
      },
    ]);

    const second = await post('/api/deployments/writer-local/restart');
    assert.equal(second.status, 200, await second.text());
    assert.equal(docker.oneShots.length, 1, 'a succeeded job keeps its once-per-revision rule');
  });

  it('applying a revision on a computer sends a writerSite job that the computer runs', async () => {
    const nodeId = 'computer-writer';
    store
      .getSqlite()!
      .prepare(
        `INSERT INTO nodes (id, name, kind, capabilities, enrolled_at, last_seen_at)
         VALUES (?, ?, 'agent', '{}', ?, ?)`,
      )
      .run(nodeId, nodeId, new Date().toISOString(), Date.now());
    const { appId, compiled } = seedApp('writer-remote', 'writerSite', nodeId);
    const artifactPath = join(root, 'source.tar.gz');
    writeFileSync(artifactPath, 'source');
    const artifact = await contentStore.putArtifactFile(artifactPath, {
      type: 'source',
      mediaType: 'application/gzip',
      createdBy: USER,
    } as never);
    store
      .getSqlite()!
      .prepare('UPDATE deployments SET source_artifact_digest = ? WHERE name = ?')
      .run((artifact as { digest: string }).digest, 'writer-remote');
    const next = specs.compileDeployYaml(manifest('writerSite', 'two'));
    store.saveDesiredApplicationSpec({
      digest: next.digest,
      parentDigest: compiled.digest,
      deploymentName: 'writer-remote',
      apiVersion: next.spec.apiVersion,
      source: 'repository',
      manifestFormat: 'deploy.yaml',
      normalizedSpec: next.canonicalJson,
      createdBy: USER,
    });
    store._invalidateDeploymentsCache();

    const apply = post('/api/deployments/writer-remote/application-apply', {
      expectedDesiredDigest: next.digest,
    });
    const job = await queuedDeploy('writer-remote');
    const payload = JSON.parse(store.getAgentJob(job.id)!.payload);
    store.completeAgentJob(job.id, nodeId, { success: false, error: 'stop after dispatch' });
    await (await apply).text();

    assert.equal(payload.graph.applicationId, appId);
    assert.equal(payload.graph.siteId, nodeId);
    assert.equal(payload.graph.writerSiteId, nodeId, 'the computer holds writer authority');

    // Hand the exact payload to the worker's real graph runtime.
    const agentRoot = mkdtempSync(join(root, 'agent-'));
    const onWorker = (graph: typeof payload.graph, stateFile: string) =>
      executeAgentApplicationGraph(
        {
          deploymentName: 'writer-remote',
          jobId: 'job-00000001',
          sourceDirectory: agentRoot,
          volumeDirectory: resolve(agentRoot, 'volumes'),
          statePath: resolve(agentRoot, stateFile),
          artifactSpecDigest: next.digest,
          artifactSpec: next.spec,
          graph,
          probePort: async () => true,
        },
        {
          async run(args) {
            if (args[0] === 'network' && args[1] === 'inspect')
              return { exitCode: 1, stdout: '', stderr: 'missing' };
            if (args[0] === 'ps') return { exitCode: 0, stdout: '', stderr: '' };
            if (args[0] === 'create') return { exitCode: 0, stdout: 'container\n', stderr: '' };
            if (args[0] === 'inspect') return { exitCode: 0, stdout: 'true\n', stderr: '' };
            if (args[0] === 'port') return { exitCode: 0, stdout: '127.0.0.1:43000\n', stderr: '' };
            return { exitCode: 0, stdout: 'ok\n', stderr: '' };
          },
        },
      );
    const result = await onWorker(payload.graph, 'state.json');
    assert.deepEqual(
      result.jobs.map((item) => [item.job, item.executed]),
      [['migrate', true]],
    );
    const again = await onWorker(payload.graph, 'state.json');
    assert.deepEqual(
      again.jobs.map((item) => [item.job, item.executed]),
      [['migrate', false]],
      'the worker keeps its once-per-revision rule',
    );

    const elsewhere = await onWorker(
      { ...payload.graph, writerSiteId: 'another-site' },
      'elsewhere.json',
    );
    assert.deepEqual(elsewhere.jobs, [], 'a computer that is not the writer leaves the job alone');
    await assert.rejects(
      onWorker({ ...payload.graph, writerSiteId: null }, 'unknown.json'),
      /writer site is known/,
    );
  });
});

describe('the first run after the fix', () => {
  it('the supervisor never starts a writerSite job that has not run', async () => {
    const { appId } = seedApp('writer-tick', 'writerSite', 'coordinator');
    const supervisor = startApplicationGraphSupervisor({ intervalMs: 3_600_000 });
    try {
      await supervisor.runNow();
      await supervisor.runNow();
      assert.equal(docker.oneShots.length, 0, 'a release does not run it behind the owner');
      assert.deepEqual(jobRows(appId), []);
      assert.equal(store.getDeployment('writer-tick')?.status, 'running');
      assert.ok(docker.containers.size > 0, 'the app itself is still converged and running');

      const restart = await post('/api/deployments/writer-tick/restart');
      assert.equal(restart.status, 200, await restart.text());
      assert.equal(docker.oneShots.length, 1, 'the next owner action runs it');

      await supervisor.runNow();
      assert.equal(docker.oneShots.length, 1, 'and it does not fire again');
    } finally {
      supervisor.stop();
    }
  });

  it('startup never starts a writerSite job that has not run', async () => {
    const { appId } = seedApp('writer-boot', 'writerSite', 'coordinator');
    store.updateDeploymentStatus('writer-boot', 'stopped');
    await startAllContainers();
    assert.equal(docker.oneShots.length, 0);
    assert.deepEqual(jobRows(appId), []);
    assert.equal(store.getDeployment('writer-boot')?.status, 'running');
  });

  it('a failing job reports failure and does not fire on every supervisor tick', async () => {
    const { appId } = seedApp('writer-fails', 'writerSite', 'coordinator');
    docker.oneShotExitCode = 1;
    const restart = await post('/api/deployments/writer-fails/restart');
    assert.notEqual(restart.status, 200, 'the owner action reports the failure');
    assert.equal((await restart.json()).error, 'Lifecycle job "migrate" failed: boom');
    assert.equal(docker.oneShots.length, 1);

    const supervisor = startApplicationGraphSupervisor({ intervalMs: 3_600_000 });
    const logged = mock.method(console, 'error', () => {});
    try {
      await supervisor.runNow();
      await supervisor.runNow();
      await supervisor.runNow();
    } finally {
      logged.mock.restore();
      supervisor.stop();
    }
    assert.equal(docker.oneShots.length, 1, 'three ticks did not run the job again');
    assert.equal(store.getDeployment('writer-fails')?.status, 'degraded');
    assert.deepEqual(jobRows(appId), [
      { siteId: 'coordinator', job: 'migrate', scope: 'writerSite', status: 'failed', attempts: 1 },
    ]);

    docker.oneShotExitCode = 0;
    const retry = await post('/api/deployments/writer-fails/restart');
    assert.equal(retry.status, 200, await retry.text());
    assert.equal(docker.oneShots.length, 2, 'the owner retries it');
    assert.deepEqual(jobRows(appId), [
      {
        siteId: 'coordinator',
        job: 'migrate',
        scope: 'writerSite',
        status: 'succeeded',
        attempts: 2,
      },
    ]);
  });

  it('per-site jobs still run unattended, once, and a failure no longer loops', async () => {
    const { appId } = seedApp('persite-tick', 'perSite', 'coordinator');
    const supervisor = startApplicationGraphSupervisor({ intervalMs: 3_600_000 });
    const logged = mock.method(console, 'error', () => {});
    try {
      docker.oneShotExitCode = 1;
      await supervisor.runNow();
      await supervisor.runNow();
      assert.equal(docker.oneShots.length, 1, 'the second tick did not run it again');
      assert.equal(jobRows(appId)[0].status, 'failed');
      assert.equal(store.getDeployment('persite-tick')?.status, 'degraded');
    } finally {
      logged.mock.restore();
      supervisor.stop();
    }
  });
});

async function queuedDeploy(name: string) {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
    const job = store
      .getSqlite()!
      .prepare(
        "SELECT id FROM agent_jobs WHERE deployment_name = ? AND type = 'deploy' AND status = 'queued'",
      )
      .get(name) as { id: string } | undefined;
    if (job) return job;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`No queued deploy for ${name}`);
}
