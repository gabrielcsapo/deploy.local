import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { Project } from '../../shared/v2/contracts.ts';
import type { BackupRuntime } from './backups.ts';
import type { ReleaseRuntime } from './releases.ts';
import type {
  GraphDockerAdapter,
  GraphContainerCreateRequest,
  GraphContainerInspection,
} from '../graph-docker-adapter.ts';
const root = mkdtempSync(join(tmpdir(), 'v2-backups-'));
process.env.DEPLOY_DATA_DIR = root;
const { BackupService, CoordinatorBackupRuntime, backupSources, backupsApi } =
  await import('./backups.ts');
const { CoordinatorReleaseRuntime } = await import('./releases-runtime.ts');
const { ProjectReleaseService } = await import('./releases.ts');
const { db, save, get, list } = await import('../workspace/store.ts');
const { registerUser, saveDeployment, saveBackup, readDeploymentRecord, getSqlite, _resetDb } =
  await import('../store.ts');
const { createRecoveryBundle } = await import('../recovery-bundle.ts');
const { graphVolumeName } = await import('../graph-docker-adapter.ts');
after(() => {
  _resetDb();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const owner = randomUUID();
  registerUser(owner, 'test-password');
  const project: Project = {
    id: randomUUID(),
    name: 'home-gym',
    apps: [{ id: 'gym', name: 'gym', kind: 'web' }],
  };
  const calls: string[] = [];
  const plan = { apps: [{ appId: 'gym', to: 'code' }], migrations: [], runtime: {} };
  const backup = {
    id: randomUUID(),
    capturedAt: new Date().toISOString(),
    apps: ['gym'],
    runtime: [],
  };
  const source = {
    point: {
      id: backup.id,
      projectId: project.id,
      name: 'home-gym',
      apps: ['gym'],
      kind: 'scheduled' as const,
      createdAt: backup.capturedAt,
      sizeBytes: 123,
      contents: ['database'],
      destination: '/backup',
      computer: 'SER',
      verified: false,
      testStatus: 'untested' as const,
      restoreAvailable: true,
    },
    backup,
  };
  save('v2-release', owner, {
    id: 'current',
    project,
    plan,
    release: {
      id: 'current',
      projectId: project.id,
      apps: plan.apps,
      migrations: [],
      state: 'live',
      steps: [],
    },
  });
  save('v2-project-current', owner, { id: project.id, releaseId: 'current' });
  const switchRuntime: ReleaseRuntime = {
    plan: async () => ({
      ...plan,
      migrations: [{ id: 'restore', title: 'Restore', reversible: false }],
    }),
    prepare: async () => {
      calls.push('prepare');
    },
    verify: async () => {
      calls.push('verify');
    },
    backup: async () => {
      calls.push('keep-live-data');
      return backup;
    },
    activate: async () => {
      calls.push('switch');
    },
    migrate: async () => {},
    watch: async () => {},
    rollback: async () => {},
    dispose: async () => {},
  };
  const runtime: BackupRuntime = {
    create: async (record) => {
      calls.push('copy');
      record.addresses = [{ app: 'gym', url: 'http://localhost:5188' }];
    },
    remove: async () => {
      calls.push('remove-copy');
    },
    switchRuntime: () => switchRuntime,
  };
  const service = new BackupService(
    runtime,
    async (actor) => (actor === owner ? [source] : []),
    async () => [project],
    0,
  );
  return { owner, project, calls, backup, source, runtime, service, switchRuntime };
}
async function settled(service: InstanceType<typeof BackupService>, owner: string) {
  for (let i = 0; i < 100; i++) {
    const result = await service.listing(owner);
    if (!result.restores.some((row) => row.state === 'switching')) return result;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Restore did not settle');
}

test('listing is owner scoped and public receipts omit runtime and secrets', async () => {
  const f = fixture();
  const copy = await f.service.restore(f.owner, f.backup.id);
  const result = await f.service.listing(f.owner);
  assert.equal(result.backups[0].id, f.backup.id);
  assert.equal(result.restores[0].id, copy.id);
  assert.equal('plan' in result.restores[0], false);
  assert.equal('backup' in result.restores[0], false);
  assert.deepEqual((await f.service.listing('stranger')).backups, []);
  await assert.rejects(f.service.cancel('stranger', f.backup.id, copy.id), { status: 404 });
});
test('restore creates a copy and an address without activating or backing up live data', async () => {
  const f = fixture();
  const result = await f.service.restore(f.owner, f.backup.id);
  assert.equal(result.state, 'ready');
  assert.equal(result.addresses[0].url, 'http://localhost:5188');
  assert.deepEqual(f.calls, ['copy']);
  assert.equal(get('v2-project-current', f.owner, f.project.id).releaseId, 'current');
  await assert.rejects(f.service.restore(f.owner, f.backup.id), { status: 409 });
});
test('switch is a whole-project release and keeps live data before activating', async () => {
  const f = fixture();
  const copy = await f.service.restore(f.owner, f.backup.id);
  await assert.rejects(f.service.switch(f.owner, f.backup.id, copy.id, false));
  const switched = await f.service.switch(f.owner, f.backup.id, copy.id, true);
  assert.equal(switched.state, 'switching');
  await assert.rejects(f.service.switch(f.owner, f.backup.id, copy.id, true), { status: 409 });
  const result = await settled(f.service, f.owner);
  assert.equal(result.restores[0].state, 'live');
  assert.deepEqual(f.calls, ['copy', 'prepare', 'verify', 'keep-live-data', 'switch']);
  assert.equal(get('v2-release', f.owner, switched.releaseId!).backup.id, f.backup.id);
  await assert.rejects(f.service.cancel(f.owner, f.backup.id, copy.id), { status: 409 });
});
test('refuses Switch while a project release is running and after current release changes', async () => {
  const f = fixture();
  const copy = await f.service.restore(f.owner, f.backup.id);
  save('v2-project-run', f.owner, { id: f.project.id, apps: ['gym'], operationId: 'other' });
  await assert.rejects(f.service.switch(f.owner, f.backup.id, copy.id, true), { status: 409 });
  db.prepare("DELETE FROM records WHERE kind='v2-project-run' AND owner=?").run(f.owner);
  save('v2-release', f.owner, { ...get('v2-release', f.owner, 'current'), id: 'new' });
  save('v2-project-current', f.owner, { id: f.project.id, releaseId: 'new' });
  await assert.rejects(f.service.switch(f.owner, f.backup.id, copy.id, true), { status: 409 });
  assert.deepEqual(f.calls, ['copy']);
});
test('Cancel removes only the copy, is repeatable, and fences a racing Switch', async () => {
  const f = fixture();
  const copy = await f.service.restore(f.owner, f.backup.id);
  let finish!: () => void;
  f.runtime.remove = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  const cancelling = f.service.cancel(f.owner, f.backup.id, copy.id);
  await assert.rejects(f.service.switch(f.owner, f.backup.id, copy.id, true), { status: 409 });
  finish();
  assert.equal((await cancelling).state, 'cancelled');
  assert.equal((await f.service.cancel(f.owner, f.backup.id, copy.id)).state, 'cancelled');
  assert.equal(get('v2-project-current', f.owner, f.project.id).releaseId, 'current');
});
test('failed copy cleans up and failed activation retains the project recovery lock', async () => {
  const f = fixture();
  f.runtime.create = async () => {
    throw new Error('Corrupt backup');
  };
  await assert.rejects(f.service.restore(f.owner, f.backup.id), /Corrupt/);
  assert.deepEqual(f.calls, ['remove-copy']);
  f.runtime.create = async () => {};
  const copy = await f.service.restore(f.owner, f.backup.id);
  f.switchRuntime.activate = async () => {
    throw Object.assign(new Error('Partial restore'), { requiresRecovery: true });
  };
  await f.service.switch(f.owner, f.backup.id, copy.id, true);
  assert.equal(
    (await settled(f.service, f.owner)).restores.find((row) => row.id === copy.id)?.state,
    'failed',
  );
  assert.equal(list('v2-project-run', f.owner).length, 1);
});
test('Test-restore uses a disposable copy', async () => {
  const f = fixture();
  assert.equal((await f.service.test(f.owner, f.backup.id)).status, 'passed');
  assert.deepEqual(f.calls, ['copy', 'remove-copy']);
});

class FakeDocker implements GraphDockerAdapter {
  containers = new Map<
    string,
    { request: GraphContainerCreateRequest; running: boolean; id: string }
  >();
  volumes = new Map<string, string>();
  calls: string[] = [];
  async prepareImage() {
    return 'test-image';
  }
  async ensureNetwork() {}
  async ensureVolume(name: string) {
    if (!this.volumes.has(name)) this.volumes.set(name, '');
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
    return !!this.containers.get(name)?.running;
  }
  async stopContainer(name: string) {
    this.calls.push(`stop:${name}`);
    const row = this.containers.get(name);
    if (row) row.running = false;
  }
  async removeContainer(name: string) {
    this.containers.delete(name);
  }
  async runOneShot() {
    return { exitCode: 0, output: 'ok' };
  }
  async exec() {
    return { exitCode: 0, output: 'ok' };
  }
  async copyFromContainer() {}
  async copyToContainer() {}
  async exportVolume(volume: string, path: string) {
    const value = this.volumes.get(volume) || '';
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
    return {
      digest: `sha256:${createHash('sha256').update(value).digest('hex')}` as const,
      bytes: value.length,
    };
  }
  async verifyVolumeArchive(path: string) {
    return existsSync(path);
  }
  async restoreVolume(volume: string, path: string) {
    this.calls.push(`restore:${volume}`);
    this.volumes.set(volume, readFileSync(path, 'utf8'));
  }
}

test('real graph runtime restores isolated data, switches checked edits, and retains original live data', async () => {
  const { ensureCerts, getTlsOptions } = await import('../certs.ts');
  const { X509Certificate } = await import('node:crypto');
  ensureCerts();
  const owner = randomUUID();
  registerUser(owner, 'test-password');
  const name = `gym-${randomUUID().slice(0, 8)}`;
  const directory = join(root, name);
  mkdirSync(directory);
  writeFileSync(
    join(directory, 'deploy.yaml'),
    `apiVersion: deploy.local/v1\nkind: Application\nmetadata:\n  name: ${name}\ncomponents:\n  app:\n    image: test:1\n    role: web\n    interfaces:\n      http:\n        port: 8080\n        protocol: http\n    mounts:\n      /data: { resource: data }\nresources:\n  data:\n    type: volume\nroutes:\n  public:\n    to: app.http\n`,
  );
  saveDeployment({ name, username: owner, directory, activeNodeId: 'coordinator' });
  const project: Project = { id: `app:${name}`, name, apps: [{ id: name, name, kind: 'web' }] };
  const docker = new FakeDocker();
  const releases = new CoordinatorReleaseRuntime({
    docker,
    workerProbeMs: 0,
    pinImage: async () => `sha256:${'a'.repeat(64)}`,
  });
  const engine = new ProjectReleaseService(releases, { watchMs: 0 });
  const release = engine.ship(owner, project, { source: { kind: 'ship', ref: 'fixture' } });
  await engine.settled();
  const current = get('v2-release', owner, release.id);
  assert.equal(current.release.state, 'live', JSON.stringify(current.release));
  const liveVolume = graphVolumeName(name, 'data');
  docker.volumes.set(liveVolume, 'old-backup-data');
  const backup = await releases.backup(current.plan);
  save('v2-release', owner, { ...current, backup });
  docker.volumes.set(liveVolume, 'live-data-written-later');
  const before = readDeploymentRecord(name)!.containerId;
  docker.calls.length = 0;
  const service = new BackupService(
    new CoordinatorBackupRuntime({ docker, releases }),
    backupSources,
    async () => [project],
    0,
  );
  let copy = await service.restore(owner, backup.id);
  assert.equal(copy.state, 'ready');
  assert.match(copy.addresses[0].url, /^https:\/\/copy-/);
  assert(
    new X509Certificate(getTlsOptions().cert).checkHost(new URL(copy.addresses[0].url).hostname),
  );
  assert.equal(docker.volumes.get(liveVolume), 'live-data-written-later');
  assert.equal(readDeploymentRecord(name)!.containerId, before);
  assert(!docker.calls.some((call) => call === `restore:${liveVolume}`));
  const copiedVolume = [...docker.volumes.keys()].find((key) => key.includes('restore-'))!;
  assert.equal(docker.volumes.get(copiedVolume), 'old-backup-data');
  await service.cancel(owner, backup.id, copy.id);
  assert.equal(docker.volumes.has(copiedVolume), false);
  assert.equal(docker.volumes.get(liveVolume), 'live-data-written-later');
  assert.equal(readDeploymentRecord(name)!.containerId, before);
  copy = await service.restore(owner, backup.id);
  const checkedVolume = [...docker.volumes.keys()].find((key) => key.includes('restore-'))!;
  docker.volumes.set(checkedVolume, 'checked-copy-edits');
  const pending = get('v2-backup-restore', owner, copy.id);
  const exportVolume = docker.exportVolume.bind(docker);
  docker.exportVolume = async () => {
    throw new Error('Backup disk unavailable');
  };
  await assert.rejects(
    service.runtime.switchRuntime(pending, () => {}).backup(pending.plan),
    /Backup disk unavailable/,
  );
  assert.equal([...docker.containers.values()].find((entry) => entry.id === before)?.running, true);
  assert.equal(docker.volumes.get(liveVolume), 'live-data-written-later');
  docker.exportVolume = exportVolume;
  docker.calls.length = 0;
  await service.switch(owner, backup.id, copy.id, true);
  const result = await settled(service, owner);
  const restored = result.restores.find((row) => row.id === copy.id)!;
  assert.equal(restored.state, 'live', JSON.stringify(result.restores));
  assert.equal(docker.volumes.get(liveVolume), 'checked-copy-edits');
  const previousName = [...docker.containers.entries()].find(
    ([, value]) => value.id === before,
  )![0];
  assert.equal(
    docker.calls.filter((call) => call === `start:${previousName}`).length,
    0,
    'live writers stay stopped after their final backup',
  );
  const receipt = get('v2-backup-restore', owner, copy.id);
  assert.deepEqual(receipt.copies[0].context.runtime.configurationValues, {});
  assert.deepEqual(receipt.copies[0].context.runtime.componentEnvironment, {});
  const retained = get('v2-release', owner, restored.releaseId!).backup;
  const entry = retained.runtime[0];
  const { getBackupDir } = await import('../volumes.ts');
  const manifest = JSON.parse(
    readFileSync(join(getBackupDir(name), entry.backup.filename, 'recovery-manifest.json'), 'utf8'),
  );
  assert.equal(
    readFileSync(
      join(getBackupDir(name), entry.backup.filename, manifest.resources[0].archive),
      'utf8',
    ),
    'live-data-written-later',
  );
});

test('real listing includes scheduled app backups and admin recovery bundles; rehearsal uses existing operations', async () => {
  const admin = getSqlite()!.prepare("SELECT username FROM users WHERE role='admin'").get() as {
    username: string;
  };
  const name = `scheduled-${randomUUID().slice(0, 8)}`;
  saveDeployment({ name, username: admin.username });
  saveBackup({
    deploymentName: name,
    filename: 'nightly.tar.gz',
    label: 'scheduled',
    sizeBytes: 123,
    createdAt: new Date().toISOString(),
    createdBy: 'scheduler',
    volumePaths: ['data'],
    auto: true,
  });
  const bundlePath = join(root, `recovery-${randomUUID()}.json`);
  const passphrase = 'temporary rehearsal passphrase';
  const { loadOrCreateSecretKey } = await import('../secrets.ts');
  loadOrCreateSecretKey();
  const { ensureCerts } = await import('../certs.ts');
  ensureCerts();
  const bundle = await createRecoveryBundle({ outputPath: bundlePath, passphrase });
  const service = new BackupService();
  const points = (await service.listing(admin.username)).backups;
  assert(points.some((point) => point.kind === 'scheduled' && point.apps.includes(name)));
  assert(points.some((point) => point.id === `recovery:${bundle.id}`));
  assert.equal(
    (await service.test(admin.username, `recovery:${bundle.id}`, passphrase)).status,
    'passed',
  );
  const tested = (await service.listing(admin.username)).backups.find(
    (point) => point.id === `recovery:${bundle.id}`,
  )!;
  assert.equal(tested.testStatus, 'passed');
  assert.equal(tested.verified, true);
  await assert.rejects(service.test(admin.username, `recovery:${bundle.id}`, 'wrong passphrase'));
  assert.equal(
    (await service.listing(admin.username)).backups.find(
      (point) => point.id === `recovery:${bundle.id}`,
    )!.testStatus,
    'failed',
  );
  const other = fixture();
  assert(!(await backupSources(other.owner)).some((source) => source.point.kind === 'recovery'));
});

test('HTTP routes return copy address, refuse agents, and enforce restore identity', async () => {
  const f = fixture();
  const server = createServer((req, res) => {
    void backupsApi(req, res, f.owner, f.service);
  });
  let port = 5180;
  for (; port <= 5199; port++) {
    try {
      server.listen(port, '127.0.0.1');
      await once(server, 'listening');
      break;
    } catch (error: any) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  assert(port <= 5199);
  const url = `http://127.0.0.1:${port}/api/backups`;
  try {
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(url, { headers: { 'x-deploy-agent-token': 'agent' } })).status, 403);
    const response = await fetch(`${url}/${f.backup.id}/restore`, { method: 'POST' });
    assert.equal(response.status, 201);
    const { restore } = await response.json();
    assert.equal(restore.addresses.length, 1);
    assert.equal(restore.addresses[0].url, 'http://localhost:5188');
    assert.equal(
      (await fetch(`${url}/wrong/restore/${restore.id}/cancel`, { method: 'POST' })).status,
      404,
    );
    assert.equal(
      (await fetch(`${url}/${f.backup.id}/restore/${restore.id}/cancel`, { method: 'POST' }))
        .status,
      200,
    );
    const next = await (await fetch(`${url}/${f.backup.id}/restore`, { method: 'POST' })).json();
    const switchUrl = `${url}/${f.backup.id}/restore/${next.restore.id}/switch`;
    assert.equal((await fetch(switchUrl, { method: 'POST' })).status, 400);
    save('v2-project-run', f.owner, { id: f.project.id, apps: ['gym'], operationId: 'running' });
    const confirmation = { method: 'POST', body: JSON.stringify({ confirm: true }) };
    assert.equal((await fetch(switchUrl, confirmation)).status, 409);
    db.prepare("DELETE FROM records WHERE kind='v2-project-run' AND owner=?").run(f.owner);
    assert.equal((await fetch(switchUrl, confirmation)).status, 202);
    await settled(f.service, f.owner);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Back up now is owner-only and reports a disabled backup without starting work', async () => {
  const admin = getSqlite()!.prepare("SELECT username FROM users WHERE role='admin'").get() as {
    username: string;
  };
  const member = fixture().owner;
  const { getBackupSettings } = await import('../store.ts');
  assert.equal(getBackupSettings().enabled, false);
  async function run(owner: string) {
    let status = 0;
    let body: any;
    await backupsApi(
      {
        url: '/api/backups/run',
        method: 'POST',
        headers: {},
      } as import('node:http').IncomingMessage,
      {
        writeHead(code: number) {
          status = code;
        },
        end(value: string) {
          body = JSON.parse(value);
        },
      } as unknown as import('node:http').ServerResponse,
      owner,
    );
    return { status, body };
  }
  assert.equal((await run(member)).status, 403);
  const result = await run(admin.username);
  assert.equal(result.status, 409);
  assert.equal(result.body.success, false);
  assert.equal(result.body.error, 'Backup is disabled');
});

test('refreshing preview addresses cannot revive a copy cancelled during publication', async () => {
  const f = fixture();
  const copy = await f.service.restore(f.owner, f.backup.id);
  let finish!: () => void;
  const entered = new Promise<void>((ready) => {
    f.runtime.publish = () =>
      new Promise<void>((done) => {
        finish = done;
        ready();
      });
  });
  const listing = f.service.listing(f.owner);
  await entered;
  await f.service.cancel(f.owner, f.backup.id, copy.id);
  finish();
  const result = await listing;
  assert.equal(result.restores[0].state, 'cancelled');
  assert.deepEqual(result.restores[0].addresses, []);
  assert.equal(get('v2-backup-restore', f.owner, copy.id).state, 'cancelled');
});
