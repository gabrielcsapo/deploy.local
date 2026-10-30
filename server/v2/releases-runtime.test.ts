import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type {
  GraphDockerAdapter,
  GraphContainerCreateRequest,
  GraphContainerInspection,
} from '../graph-docker-adapter.ts';
const root = mkdtempSync(join(tmpdir(), 'v2-release-runtime-'));
process.env.DEPLOY_DATA_DIR = root;
const { CoordinatorReleaseRuntime } = await import('./releases-runtime.ts');
const { getSqlite, saveDeployment, readDeploymentRecord, _resetDb } = await import('../store.ts');
const { db } = await import('../workspace/store.ts');
after(() => {
  _resetDb();
  db.close();
  rmSync(root, { recursive: true, force: true });
});
class FakeDocker implements GraphDockerAdapter {
  containers = new Map<
    string,
    { request: GraphContainerCreateRequest; running: boolean; id: string }
  >();
  volumes = new Set<string>();
  calls: string[] = [];
  jobs: GraphContainerCreateRequest[] = [];
  failVerify = false;
  failActivate = '';
  async prepareImage(input: Parameters<GraphDockerAdapter['prepareImage']>[0]) {
    this.calls.push('build');
    return `${input.applicationId}/${input.component}`;
  }
  async ensureNetwork() {}
  async ensureVolume(name: string) {
    this.volumes.add(name);
  }
  async volumeExists(name: string) {
    return this.volumes.has(name);
  }
  async removeNetwork() {}
  async removeVolume(name: string) {
    this.volumes.delete(name);
  }
  async createContainer(request: GraphContainerCreateRequest) {
    const id = randomUUID();
    this.containers.set(request.name, { request, running: false, id });
    return { id, name: request.name };
  }
  async startContainer(name: string) {
    this.calls.push(`start:${name}`);
    this.containers.get(name)!.running = true;
  }
  async inspectContainer(name: string): Promise<GraphContainerInspection> {
    const row = this.containers.get(name);
    return {
      id: row?.id || '',
      name,
      exists: !!row,
      running: !!row?.running,
      status: row?.running ? 'running' : 'stopped',
      health: row?.running ? 'healthy' : 'none',
      hostPorts: row
        ? Object.fromEntries(row.request.publishPorts.map((port) => [port, 5188]))
        : {},
    };
  }
  async waitHealthy(name: string) {
    const row = this.containers.get(name);
    return (
      !!row?.running &&
      !(this.failVerify && row.request.labels['deploy-sh.app-id'].startsWith('verify-')) &&
      !(this.failActivate && row.request.labels['deploy-sh.app-id'] === this.failActivate)
    );
  }
  async stopContainer(name: string) {
    this.calls.push(`stop:${name}`);
    const row = this.containers.get(name);
    if (row) row.running = false;
  }
  async removeContainer(name: string) {
    this.containers.delete(name);
  }
  async runOneShot(request: GraphContainerCreateRequest) {
    this.jobs.push(request);
    this.calls.push(`job:${request.labels['deploy-sh.app-id']}`);
    return { exitCode: 0, output: 'ok' };
  }
  async exec() {
    return { exitCode: 0, output: 'ok' };
  }
  async copyFromContainer() {}
  async copyToContainer() {}
  async exportVolume(volume: string, path: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, volume);
    return {
      digest: `sha256:${createHash('sha256').update(volume).digest('hex')}` as const,
      bytes: volume.length,
    };
  }
  async verifyVolumeArchive(path: string) {
    return existsSync(path);
  }
  async restoreVolume() {}
}
function fixture(jobs = false) {
  const suffix = randomUUID().slice(0, 8);
  const names = [`web-${suffix}`, `sync-${suffix}`];
  for (const [index, name] of names.entries()) {
    const directory = join(root, name);
    mkdirSync(directory);
    writeFileSync(
      join(directory, 'deploy.yaml'),
      `apiVersion: deploy.local/v1\nkind: Application\nmetadata:\n  name: ${name}\ncomponents:\n  app:\n    image: test:1\n    role: ${index ? 'worker' : 'web'}\n    interfaces:\n      http:\n        port: 8080\n        protocol: http\n    health:\n      interface: http\n      path: /health\n${index ? '' : 'routes:\n  public:\n    to: app.http\n'}${jobs ? 'jobs:\n  migrate:\n    component: app\n    command: [migrate, up]\n    execution: perSite\n    beforeTraffic: true\n' : ''}`,
    );
    saveDeployment({ name, username: 'owner', directory, activeNodeId: 'coordinator' });
  }
  const docker = new FakeDocker();
  const runtime = new CoordinatorReleaseRuntime({
    docker,
    workerProbeMs: 0,
    pinImage: async (image) => image,
  });
  const project = {
    id: suffix,
    name: suffix,
    apps: names.map((name, index) => ({
      id: name,
      name,
      kind: index ? ('worker' as const) : ('web' as const),
    })),
  };
  return { docker, runtime, project, names };
}
test('real graph adapter verifies isolated copies, publishes all apps, and rolls both back', async () => {
  const f = fixture();
  const first = await f.runtime.plan(f.project);
  await f.runtime.prepare(first);
  await f.runtime.verify(first);
  await f.runtime.activate(first);
  await f.runtime.watch(first, 0);
  const before = f.names.map((name) => readDeploymentRecord(name)!.containerId);
  const second = await f.runtime.plan(f.project);
  await f.runtime.prepare(second);
  await f.runtime.verify(second);
  assert.deepEqual(
    f.names.map((name) => readDeploymentRecord(name)!.containerId),
    before,
  );
  await f.runtime.activate(second);
  await f.runtime.watch(second, 0);
  const after = f.names.map((name) => readDeploymentRecord(name)!.containerId);
  assert(after.every((value, index) => value !== before[index]));
  await f.runtime.rollback(second, first);
  await f.runtime.watch(first, 0);
  for (const name of f.names) {
    const instance = [...f.docker.containers.values()].find(
      (row) => row.id === readDeploymentRecord(name)!.containerId,
    )!;
    assert(instance.request.image.includes((first.runtime as any).id));
  }
  assert(
    ![...f.docker.containers.values()].some((row) =>
      row.request.labels['deploy-sh.app-id'].startsWith('verify-'),
    ),
  );
});
test('real graph Verify failure never stops or switches original apps', async () => {
  const f = fixture();
  const first = await f.runtime.plan(f.project);
  await f.runtime.prepare(first);
  await f.runtime.activate(first);
  const before = f.names.map((name) => readDeploymentRecord(name));
  f.docker.calls.length = 0;
  const second = await f.runtime.plan(f.project);
  await f.runtime.prepare(second);
  f.docker.failVerify = true;
  await assert.rejects(f.runtime.verify(second));
  assert.deepEqual(
    f.names.map((name) => readDeploymentRecord(name)),
    before,
  );
  for (const row of before)
    assert(
      [...f.docker.containers.values()].find((container) => container.id === row!.containerId)!
        .running,
    );
});
test('activation failure in the second app restores the first app and original route set', async () => {
  const f = fixture();
  const first = await f.runtime.plan(f.project);
  await f.runtime.prepare(first);
  await f.runtime.activate(first);
  const before = f.names.map((name) => readDeploymentRecord(name)!.containerId);
  const endpoints = getSqlite()!
    .prepare('SELECT * FROM service_endpoints WHERE readiness=?')
    .all('ready');
  const second = await f.runtime.plan(f.project);
  await f.runtime.prepare(second);
  await f.runtime.verify(second);
  f.docker.failActivate = f.names[1];
  await assert.rejects(f.runtime.activate(second));
  assert.deepEqual(
    f.names.map((name) => readDeploymentRecord(name)!.containerId),
    before,
  );
  assert.deepEqual(
    getSqlite()!.prepare('SELECT * FROM service_endpoints WHERE readiness=?').all('ready'),
    endpoints,
  );
  for (const id of before)
    assert([...f.docker.containers.values()].find((row) => row.id === id)!.running);
});
test('migration jobs execute after all project routes switch', async () => {
  const f = fixture(true);
  const plan = await f.runtime.plan(f.project);
  await f.runtime.prepare(plan);
  await f.runtime.verify(plan);
  f.docker.calls.length = 0;
  await f.runtime.activate(plan);
  assert(!f.docker.calls.some((call) => call.startsWith('job:')));
  assert(f.names.every((name) => readDeploymentRecord(name)!.containerId));
  await f.runtime.migrate(plan);
  assert.equal(f.docker.calls.filter((call) => call.startsWith('job:')).length, 2);
  const backup = await f.runtime.backup(plan);
  assert.deepEqual(backup.apps, f.names);
  assert((backup.runtime as any[]).every((entry) => entry.backup.format === 'application-graph'));
  await f.runtime.verify(plan, backup);
  await f.runtime.rollback(plan, plan, backup);
  await f.runtime.watch(plan, 0);
});

test('declared reverse migration commands run on rollback without restoring a backup', async () => {
  const f = fixture();
  const first = await f.runtime.plan(f.project);
  await f.runtime.prepare(first);
  await f.runtime.activate(first);
  for (const name of f.names) {
    const directory = readDeploymentRecord(name)!.directory!;
    writeFileSync(
      join(directory, 'deploy.yaml'),
      readFileSync(join(directory, 'deploy.yaml'), 'utf8') +
        'jobs:\n  migrate:\n    component: app\n    command: [migrate, up]\n    execution: perSite\n',
    );
    writeFileSync(
      join(directory, 'release-migrations.json'),
      JSON.stringify({ reverse: { migrate: ['migrate', 'down'] } }),
    );
  }
  const next = await f.runtime.plan(f.project);
  assert(next.migrations.every((migration) => migration.reversible));
  await f.runtime.prepare(next);
  await f.runtime.verify(next);
  await f.runtime.activate(next);
  await f.runtime.migrate(next);
  const rollback = f.runtime.fork(first);
  await f.runtime.prepare(rollback);
  await f.runtime.verify(rollback);
  await f.runtime.rollback({ ...next, migrations: [...next.migrations].reverse() }, rollback);
  assert.deepEqual(
    f.docker.jobs
      .filter((job) => job.command?.[1] === 'down')
      .map((job) => job.labels['deploy-sh.app-id']),
    [...f.names].reverse(),
  );
});
test('reverse metadata rejects commands for nonexistent migrations', async () => {
  const f = fixture();
  writeFileSync(
    join(readDeploymentRecord(f.names[0])!.directory!, 'release-migrations.json'),
    JSON.stringify({ reverse: { missing: ['undo'] } }),
  );
  await assert.rejects(f.runtime.plan(f.project), /Invalid reverse command/);
});

test('Verify migrations off skips copy jobs but still verifies apps and migrates after activation', async () => {
  const f = fixture(true);
  const plan = await f.runtime.plan(f.project);
  plan.verifyMigrations = false;
  await f.runtime.prepare(plan);
  await f.runtime.verify(plan);
  assert.equal(f.docker.jobs.length, 0);
  await f.runtime.activate(plan);
  await f.runtime.migrate(plan);
  assert.equal(f.docker.jobs.length, 2);
  assert.ok(f.names.every((name) => readDeploymentRecord(name)!.containerId));
});

function mediaFixture(readOnly: boolean) {
  const name = `media-${randomUUID().slice(0, 8)}`;
  const directory = join(root, name);
  const library = join(root, `${name}-library`);
  mkdirSync(directory);
  mkdirSync(library);
  // Shaped like Forma: its own data, plus a media library it only reads.
  writeFileSync(
    join(directory, 'deploy.yaml'),
    `apiVersion: deploy.local/v1\nkind: Application\nmetadata:\n  name: ${name}\ncomponents:\n  app:\n    image: test:1\n    role: web\n    interfaces:\n      http:\n        port: 8080\n        protocol: http\n    health:\n      interface: http\n      path: /health\n    mounts:\n      /app/data:\n        resource: data\n      /movies:\n        resource: movies\n        readOnly: ${readOnly}\nresources:\n  data:\n    type: volume\n    durability: durable\n    ownership: application\n  movies:\n    type: volume\n    durability: durable\n    access: multipleReaders\n    ownership: external\n    source:\n      type: bind\n      hostPath: ${library}\n    backup:\n      policy: exclude\nroutes:\n  public:\n    to: app.http\n`,
  );
  saveDeployment({ name, username: 'owner', directory, activeNodeId: 'coordinator' });
  const docker = new FakeDocker();
  const runtime = new CoordinatorReleaseRuntime({
    docker,
    workerProbeMs: 0,
    pinImage: async (image) => image,
  });
  const project = { id: name, name, apps: [{ id: name, name, kind: 'web' as const }] };
  return { docker, runtime, project, library };
}
test('read-only external media is shared with the Verify copy and left out of the backup', async () => {
  const f = mediaFixture(true);
  const first = await f.runtime.plan(f.project);
  await f.runtime.prepare(first);
  await f.runtime.activate(first);
  const second = await f.runtime.plan(f.project);
  await f.runtime.prepare(second);
  const requests: GraphContainerCreateRequest[] = [];
  const create = f.docker.createContainer.bind(f.docker);
  f.docker.createContainer = async (request) => (requests.push(request), create(request));
  await f.runtime.verify(second);
  const copies = requests.filter((request) =>
    request.labels['deploy-sh.app-id'].startsWith('verify-'),
  );
  assert(copies.length);
  for (const request of copies) {
    const media = request.mounts.find((mount) => mount.target === '/movies')!;
    assert.deepEqual([media.type, media.source, media.readOnly], ['bind', f.library, true]);
  }
  assert(
    ![...f.docker.volumes].some(
      (volume) => volume.includes('verify-') && volume.endsWith('movies'),
    ),
  );
  await f.runtime.backup(second);
  await f.runtime.activate(second);
  await f.runtime.watch(second, 0);
});
test('writable external data still cannot be copied for Verify', async () => {
  const f = mediaFixture(false);
  await assert.rejects(f.runtime.plan(f.project), /external data that cannot be copied for Verify/);
});
