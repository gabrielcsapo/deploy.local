import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'v2-project-removal-'));
process.env.DEPLOY_DATA_DIR = root;
// Nothing here may reach a real daemon, so even an unfaked call lands on a socket this file owns.
const socket = join(root, 'docker.sock');
process.env.DOCKER_HOST = `unix://${socket}`;
const store = await import('../store.ts');
const workspace = await import('../workspace/store.ts');
const specs = await import('../application-spec.ts');
const multisite = await import('../multisite.ts');
const { graphNetworkName, graphVolumeName } = await import('../graph-docker-adapter.ts');
const { DockerApiError } = await import('../docker-api.ts');
const { resolveProject } = await import('./projects.ts');
const { removeProject, stopApp, ProjectRemovalDocker } = await import('./project-removal.ts');

after(() => {
  store._resetDb();
  workspace.db.close();
  rmSync(root, { recursive: true, force: true });
});

const MANIFEST = `
apiVersion: deploy.local/v1
kind: Application
resources:
  database-data:
    type: volume
    durability: durable
    dataRole: database
    access: singleWriter
components:
  web:
    image: nginx:1.27
    mounts:
      /data:
        resource: database-data
`;

/**
 * Stands in for the Docker daemon. As the shared CLI adapter does, it ignores a network or volume
 * that a running container still holds, so a removal that skipped the containers looks like it
 * worked unless something checks what is actually left.
 */
class FakeDocker extends ProjectRemovalDocker {
  containers = new Set<string>();
  networks = new Set<string>();
  volumes = new Set<string>();
  /** Containers Docker keeps despite a clean answer to the removal call. */
  stuck = new Set<string>();
  volumeError: Error | null = null;
  calls = 0;
  override async removeContainer(name: string) {
    this.calls++;
    if (!this.stuck.has(name)) this.containers.delete(name);
  }
  override async removeNetwork(name: string) {
    this.calls++;
    if (this.containers.size === 0) this.networks.delete(name);
  }
  override async removeVolume(name: string) {
    this.calls++;
    if (this.volumeError) throw this.volumeError;
    if (this.containers.size === 0) this.volumes.delete(name);
  }
  override async removeLegacyContainers(name: string) {
    this.calls++;
    this.containers.delete(`deploy-sh-${name}`);
  }
  override async findLeftovers() {
    this.calls++;
    return {
      containers: [...this.containers],
      networks: [...this.networks],
      volumes: [...this.volumes],
    };
  }
}

interface Seed {
  sites?: { siteId: string; nodeId: string | null; status?: string }[];
  activeNodeId?: string;
  manifestFormat?: 'deploy.yaml' | 'generated';
}

function seedGraphApp(owner: string, name: string, seed: Seed = {}) {
  const { sites = [{ siteId: 'coordinator', nodeId: 'coordinator' }] } = seed;
  store.saveDeployment({ name, username: owner, activeNodeId: seed.activeNodeId });
  const compiled = specs.compileDeployYaml(MANIFEST);
  store.saveDesiredApplicationSpec({
    digest: compiled.digest,
    deploymentName: name,
    apiVersion: compiled.spec.apiVersion,
    source: 'repository',
    manifestFormat: seed.manifestFormat ?? 'deploy.yaml',
    normalizedSpec: compiled.canonicalJson,
    createdBy: owner,
  });
  store.activateDesiredApplicationSpec(name, compiled.digest);
  // The real path: identity registration writes the replica and alias rows under the Home site.
  const appId = multisite.registerApplicationIdentity(name);
  store._invalidateDeploymentsCache();
  const now = Date.now();
  const containers: string[] = [];
  for (const [index, { siteId, nodeId, status = 'ready' }] of sites.entries()) {
    const containerName = `deploy-sh-${name}-web-${index + 1}`;
    if (nodeId === 'coordinator') containers.push(containerName);
    store
      .getSqlite()!
      .prepare(
        `INSERT INTO component_instances
          (id, app_id, deployment_name, site_id, component_key, slot_key, node_id,
           release_digest, configuration_digest, image, container_id, container_name,
           status, health, ready_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'web', ?, ?, ?, 'sha256:config', 'nginx:1.27', ?, ?,
                 ?, 'healthy', ?, ?, ?)`,
      )
      .run(
        `instance-${name}-${index}`,
        appId,
        name,
        siteId,
        `web/${index + 1}`,
        nodeId,
        compiled.digest,
        `id-${containerName}`,
        containerName,
        status,
        now,
        now,
        now,
      );
  }
  return { appId, containers };
}

function dockerHolding(appId: string, containers: string[]) {
  const docker = new FakeDocker();
  for (const container of containers) docker.containers.add(container);
  docker.networks.add(graphNetworkName(appId));
  docker.volumes.add(graphVolumeName(appId, 'database-data'));
  return docker;
}

function removeWith(owner: string, project: any, docker: FakeDocker) {
  return removeProject(owner, project, project.name, {
    stopApp: (app: any, jobId: string) => stopApp(app, jobId, docker),
  });
}

function assertEmpty(docker: FakeDocker) {
  assert.deepEqual([...docker.containers], []);
  assert.deepEqual([...docker.networks], []);
  assert.deepEqual([...docker.volumes], []);
}

function identityRows(appId: string) {
  const sqlite = store.getSqlite()!;
  const count = (table: string) =>
    (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE app_id = ?`).get(appId) as any).n;
  return { replicas: count('app_replicas'), aliases: count('application_aliases') };
}

function enrollComputer(id: string, online = true) {
  store
    .getSqlite()!
    .prepare(
      `INSERT INTO nodes (id, name, kind, capabilities, enrolled_at, last_seen_at)
       VALUES (?, ?, 'agent', '{}', ?, ?)`,
    )
    .run(id, id, new Date().toISOString(), online ? Date.now() : null);
}

/** Plays the worker: waits for the next queued delete and finishes it as told. */
async function workerFinishes(
  name: string,
  completion: { success: boolean; result?: Record<string, unknown>; error?: string },
) {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
    const job = store
      .getSqlite()!
      .prepare(
        "SELECT id, node_id FROM agent_jobs WHERE deployment_name = ? AND type = 'delete' AND status = 'queued'",
      )
      .get(name) as { id: string; node_id: string } | undefined;
    if (job) {
      const payload = JSON.parse(store.getAgentJob(job.id)!.payload);
      store.completeAgentJob(job.id, job.node_id, completion);
      return { id: job.id, payload };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`No queued delete job for ${name}`);
}

test('removal finds instances stored under coordinator, not under the Home site id', async () => {
  const { appId, containers } = seedGraphApp('site-owner', 'site-app');
  // The two ids differ on every real coordinator, which is the whole of the bug.
  assert.notEqual(multisite.ensureFleetIdentity().homeSiteId, 'coordinator');

  const docker = dockerHolding(appId, containers);
  const project = await resolveProject('site-owner', 'app:site-app');
  await removeWith('site-owner', project, docker);

  assertEmpty(docker);
});

test('removal covers every local site, a generated app, and containers no row knows about', async () => {
  const home = multisite.ensureFleetIdentity().homeSiteId;
  const { appId, containers } = seedGraphApp('all-sites-owner', 'all-sites', {
    manifestFormat: 'generated',
    sites: [
      { siteId: 'coordinator', nodeId: 'coordinator' },
      { siteId: home, nodeId: 'coordinator' },
      { siteId: home, nodeId: null },
    ],
  });
  const docker = dockerHolding(appId, containers);
  docker.containers.add('deploy-sh-all-sites-web-untracked');
  const project = await resolveProject('all-sites-owner', 'app:all-sites');
  await removeWith('all-sites-owner', project, docker);
  assertEmpty(docker);
  assert.equal(store.getDeployment('all-sites'), null);
});

test('removal clears the fleet rows of its own app and no other', async () => {
  const removed = seedGraphApp('rows-owner', 'rows-removed');
  const kept = seedGraphApp('rows-owner', 'rows-kept');
  assert.deepEqual(identityRows(removed.appId), { replicas: 1, aliases: 1 });
  assert.deepEqual(identityRows(kept.appId), { replicas: 1, aliases: 1 });

  const project = await resolveProject('rows-owner', 'app:rows-removed');
  await removeWith('rows-owner', project, dockerHolding(removed.appId, removed.containers));

  assert.deepEqual(identityRows(removed.appId), { replicas: 0, aliases: 0 });
  assert.deepEqual(identityRows(kept.appId), { replicas: 1, aliases: 1 });
});

test('a legacy app loses its containers and its data directory', async () => {
  store.saveDeployment({ name: 'old-app', username: 'legacy-owner' });
  const directory = join(root, 'volumes', 'old-app');
  mkdirSync(directory, { recursive: true });
  const docker = new FakeDocker();
  docker.containers.add('deploy-sh-old-app');
  docker.containers.add('deploy-sh-old-app-prev-1');
  const project = await resolveProject('legacy-owner', 'app:old-app');
  await removeWith('legacy-owner', project, docker);
  assertEmpty(docker);
  assert.equal(existsSync(directory), false);
});

test('anything still on the machine fails removal, keeps the retry receipt, and a retry finishes', async () => {
  const { appId, containers } = seedGraphApp('stuck-owner', 'stuck-app');
  const docker = dockerHolding(appId, containers);
  docker.stuck.add(containers[0]);
  const project = await resolveProject('stuck-owner', 'app:stuck-app');

  await assert.rejects(
    removeWith('stuck-owner', project, docker),
    (error: any) => error.status === 409 && error.message.includes(containers[0]),
  );
  assert.ok(store.getDeployment('stuck-app'));
  assert.equal(workspace.list('v2-project-removal', 'stuck-owner').length, 1);
  assert.deepEqual(workspace.list('v2-project-removal', 'stuck-owner')[0].stopped, []);
  assert.deepEqual(identityRows(appId), { replicas: 1, aliases: 1 });

  docker.stuck.clear();
  await removeWith('stuck-owner', project, docker);
  assertEmpty(docker);
  assert.equal(store.getDeployment('stuck-app'), null);
  assert.equal(workspace.list('v2-project-removal', 'stuck-owner').length, 0);
  assert.deepEqual(identityRows(appId), { replicas: 0, aliases: 0 });
});

test('a volume Docker refuses to remove fails removal', async () => {
  const { appId, containers } = seedGraphApp('volume-owner', 'volume-app');
  const docker = dockerHolding(appId, containers);
  docker.volumeError = new DockerApiError(409, 'volume is in use');
  const project = await resolveProject('volume-owner', 'app:volume-app');
  await assert.rejects(removeWith('volume-owner', project, docker), /volume is in use/);
  assert.ok(store.getDeployment('volume-app'));
  assert.equal(workspace.list('v2-project-removal', 'volume-owner').length, 1);
  docker.volumeError = null;
  await removeWith('volume-owner', project, docker);
  assertEmpty(docker);
});

test('a remote app is removed by a confirmed worker job, without touching this machine', async () => {
  enrollComputer('computer-ok');
  const { appId } = seedGraphApp('remote-owner', 'remote-app', {
    activeNodeId: 'computer-ok',
    sites: [{ siteId: 'computer-ok', nodeId: 'computer-ok' }],
  });
  const docker = new FakeDocker();
  const project = await resolveProject('remote-owner', 'app:remote-app');
  const removal = removeWith('remote-owner', project, docker);
  const job = await workerFinishes('remote-app', {
    success: true,
    result: { deleted: true, verified: true },
  });
  await removal;
  assert.deepEqual(job.payload, { deleteVolumes: true, applicationId: appId });
  assert.equal(docker.calls, 0);
  assert.equal(store.getDeployment('remote-app'), null);
  assert.deepEqual(identityRows(appId), { replicas: 0, aliases: 0 });
});

test('an app on this machine and a computer is removed from both', async () => {
  enrollComputer('computer-both');
  const { appId, containers } = seedGraphApp('both-owner', 'both-app', {
    sites: [
      { siteId: 'coordinator', nodeId: 'coordinator' },
      { siteId: 'computer-both', nodeId: 'computer-both' },
    ],
  });
  const docker = dockerHolding(appId, containers);
  const project = await resolveProject('both-owner', 'app:both-app');
  const removal = removeWith('both-owner', project, docker);
  await workerFinishes('both-app', { success: true, result: { verified: true } });
  await removal;
  assertEmpty(docker);
  assert.equal(store.getDeployment('both-app'), null);
});

test('an offline computer stops removal before anything is removed', async () => {
  enrollComputer('computer-offline', false);
  const { appId, containers } = seedGraphApp('offline-owner', 'offline-app', {
    sites: [
      { siteId: 'coordinator', nodeId: 'coordinator' },
      { siteId: 'computer-offline', nodeId: 'computer-offline' },
    ],
  });
  const docker = dockerHolding(appId, containers);
  const project = await resolveProject('offline-owner', 'app:offline-app');
  await assert.rejects(removeWith('offline-owner', project, docker), /offline/);
  assert.equal(docker.calls, 0);
  assert.ok(store.getDeployment('offline-app'));
  assert.equal(workspace.list('v2-project-removal', 'offline-owner').length, 1);

  store
    .getSqlite()!
    .prepare('UPDATE nodes SET last_seen_at = ? WHERE id = ?')
    .run(Date.now(), 'computer-offline');
  const retry = removeWith('offline-owner', project, docker);
  await workerFinishes('offline-app', { success: true, result: { verified: true } });
  await retry;
  assertEmpty(docker);
  assert.equal(workspace.list('v2-project-removal', 'offline-owner').length, 0);
});

test('a failed or unconfirmed worker job fails removal, and each retry sends a new job', async () => {
  enrollComputer('computer-retry');
  seedGraphApp('retry-owner', 'retry-app', {
    activeNodeId: 'computer-retry',
    sites: [{ siteId: 'computer-retry', nodeId: 'computer-retry' }],
  });
  const docker = new FakeDocker();
  const project = await resolveProject('retry-owner', 'app:retry-app');

  const failed = removeWith('retry-owner', project, docker);
  const first = await workerFinishes('retry-app', { success: false, error: 'docker is down' });
  await assert.rejects(failed, /could not remove the app: docker is down/);
  assert.ok(store.getDeployment('retry-app'));

  // A worker from before this change says deleted and has checked nothing.
  const unconfirmed = removeWith('retry-owner', project, docker);
  const second = await workerFinishes('retry-app', { success: true, result: { deleted: true } });
  await assert.rejects(unconfirmed, /newer worker/);
  assert.ok(store.getDeployment('retry-app'));
  assert.equal(workspace.list('v2-project-removal', 'retry-owner').length, 1);

  const finished = removeWith('retry-owner', project, docker);
  const third = await workerFinishes('retry-app', {
    success: true,
    result: { deleted: true, verified: true },
  });
  await finished;
  assert.equal(new Set([first.id, second.id, third.id]).size, 3);
  assert.equal(store.getDeployment('retry-app'), null);
  assert.equal(workspace.list('v2-project-removal', 'retry-owner').length, 0);
});

test('instances on a site this server cannot reach fail removal by name', async () => {
  const { appId, containers } = seedGraphApp('unknown-owner', 'unknown-app', {
    sites: [
      { siteId: 'coordinator', nodeId: 'coordinator' },
      { siteId: 'site-gone', nodeId: null },
    ],
  });
  const docker = dockerHolding(appId, containers);
  const project = await resolveProject('unknown-owner', 'app:unknown-app');
  await assert.rejects(removeWith('unknown-owner', project, docker), /site-gone/);
  assert.equal(docker.calls, 0);
  assert.ok(store.getDeployment('unknown-app'));
});

test('instances already marked removed on a lost site do not block removal', async () => {
  const { appId, containers } = seedGraphApp('stale-owner', 'stale-app', {
    sites: [
      { siteId: 'coordinator', nodeId: 'coordinator' },
      { siteId: 'site-gone', nodeId: null, status: 'removed' },
    ],
  });
  const docker = dockerHolding(appId, containers);
  const project = await resolveProject('stale-owner', 'app:stale-app');
  await removeWith('stale-owner', project, docker);
  assertEmpty(docker);
  assert.equal(store.getDeployment('stale-app'), null);
});

test('the real adapter treats only a missing object as removed and reads what Docker reports', async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${decodeURIComponent(req.url!)}`);
    const reply = (status: number, body?: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (req.url === '/networks/gone' || req.url === '/volumes/gone')
      return reply(404, { message: 'not found' });
    if (req.url === '/networks/busy') return reply(403, { message: 'has active endpoints' });
    if (req.url === '/volumes/busy') return reply(409, { message: 'volume is in use' });
    if (req.method === 'DELETE') return reply(204);
    const url = new URL(req.url!, 'http://docker');
    const label = JSON.parse(url.searchParams.get('filters') || '{}').label?.[0];
    if (url.pathname === '/containers/json')
      return reply(
        200,
        label === 'deploy-sh.app-id=app-1'
          ? [{ Names: ['/deploy-sh-demo-web-1'] }]
          : label
            ? []
            : [
                { Names: ['/deploy-sh-demo'] },
                { Names: ['/deploy-sh-demo-prev-1'] },
                { Names: ['/deploy-sh-demo2'] },
              ],
      );
    if (url.pathname === '/networks')
      return reply(200, label === 'deploy-sh.app-id=app-1' ? [{ Name: 'demo-private' }] : []);
    if (url.pathname === '/volumes')
      return reply(
        200,
        label === 'deploy-sh.app-id=app-1'
          ? { Volumes: [{ Name: 'demo-data' }] }
          : { Volumes: null },
      );
    return reply(500, { message: `unexpected ${req.url}` });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const docker = new ProjectRemovalDocker();
    await docker.removeNetwork('gone');
    await docker.removeVolume('gone');
    await docker.removeNetwork('free');
    await docker.removeVolume('free');
    await assert.rejects(docker.removeNetwork('busy'), /active endpoints/);
    await assert.rejects(docker.removeVolume('busy'), /in use/);
    assert.deepEqual(await docker.findLeftovers('Demo', ['app-1']), {
      containers: ['deploy-sh-demo', 'deploy-sh-demo-prev-1', 'deploy-sh-demo-web-1'],
      networks: ['demo-private'],
      volumes: ['demo-data'],
    });
    assert.ok(requests.includes('DELETE /volumes/free'));
    assert.ok(requests.includes('DELETE /networks/free'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
