import { readFile } from 'node:fs/promises';
import { sendJson } from '../http.ts';
import { copyHostname } from '../edge/copies.ts';
import { ensureCertCoversHost } from '../certs.ts';
import { notifyCertReload } from '../ipc.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
  BackupPoint,
  BackupRestore,
  BackupsResponse,
  Project,
} from '../../shared/v2/contracts.ts';
import type { ApplicationSpec } from '../application-spec.ts';
import { createCoordinatorApplicationBackup } from '../application-backups.ts';
import {
  ApplicationGraphExecutor,
  type GraphExecutorContext,
} from '../application-graph-executor.ts';
import {
  buildApplicationGraphRuntime,
  resolveApplicationGraphRuntime,
} from '../application-runtime.ts';
import { DurableGraphRuntimeStore } from '../graph-runtime-store.ts';
import {
  DockerCliGraphAdapter,
  graphVolumeName,
  type GraphDockerAdapter,
} from '../graph-docker-adapter.ts';
import {
  getBackups,
  getBackupSettings,
  getDeployments,
  getSqlite,
  isAdmin,
  readDeploymentRecord,
} from '../store.ts';
import { getArtifact } from '../content-store.ts';
import { handleOperationsRequest } from '../operations-handler.ts';
import { deployDataPath } from '../data-directory.ts';
import { getBackupDir } from '../volumes.ts';
import { db, get, list, now, save } from '../workspace/store.ts';
import { projectsForOwner } from './projects.ts';
import { fail } from '../errors.ts';
import { maintenance } from '../maintenance.ts';
import {
  assertProjectIdle,
  currentProjectReleases,
  ProjectReleaseService,
  type ReleaseBackup,
  type ReleasePlan,
  type ReleaseRuntime,
} from './releases.ts';
import { CoordinatorReleaseRuntime } from './releases-runtime.ts';
import { dispatch, routes } from '../routes.ts';

type BackupEntry = {
  name: string;
  deployment: NonNullable<ReturnType<typeof readDeploymentRecord>>;
  backup: {
    filename: string;
    timestamp: string;
    sizeBytes: number;
    format: string;
    volumePaths: string[];
  };
};
type Source = {
  point: BackupPoint;
  backup?: ReleaseBackup;
  bundlePath?: string;
  bundleId?: string;
};
type RuntimeApp = {
  name: string;
  applicationId: string;
  directory: string;
  spec: ApplicationSpec;
  digest: string;
  images: Record<string, string>;
};
type Copy = { app: string; context: GraphExecutorContext; port?: number };
type RestoreRecord = BackupRestore & {
  project: Project;
  plan: ReleasePlan;
  backup: ReleaseBackup;
  copies: Copy[];
  currentId: string;
};
const hash = (value: Buffer | string) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
const publicRestore = ({
  id,
  backupId,
  projectId,
  state,
  createdAt,
  addresses,
  releaseId,
  retainedBackupId,
  error,
}: RestoreRecord): BackupRestore => ({
  id,
  backupId,
  projectId,
  state,
  createdAt,
  addresses: state === 'ready' ? addresses : [],
  releaseId,
  retainedBackupId,
  error,
});

function persistRestore(owner: string, record: RestoreRecord) {
  const receipt = structuredClone(record);
  for (const copy of receipt.copies) {
    copy.context.runtime.configurationValues = {};
    copy.context.runtime.componentEnvironment = {};
  }
  save('v2-backup-restore', owner, receipt);
}

export async function backupSources(owner: string, presentation = false): Promise<Source[]> {
  const projects = await projectsForOwner(owner, presentation);
  const sources: Source[] = [];
  const current = currentProjectReleases(owner);
  const seen = new Set<string>();
  const add = (
    backup: ReleaseBackup,
    project: Project | undefined,
    kind: BackupPoint['kind'],
    releaseId?: string,
  ) => {
    const entries = backup.runtime as BackupEntry[];
    if (!Array.isArray(entries) || !entries.length) return;
    if (entries.some((entry) => !getDeployments(owner).some((app) => app.name === entry.name)))
      return;
    entries.forEach((entry) => seen.add(`${entry.name}/${entry.backup.filename}`));
    const graph = entries.every(
      (entry) =>
        entry.backup.filename.endsWith('.graph') &&
        (!entry.deployment.activeNodeId || entry.deployment.activeNodeId === 'coordinator'),
    );
    const available =
      graph &&
      !!project &&
      current.some((row) => row.release.projectId === project.id && row.plan) &&
      entries.every((entry) => existsSync(join(getBackupDir(entry.name), entry.backup.filename)));

    sources.push({
      backup,
      point: {
        id: backup.id,
        name: project?.name || entries[0].name,
        projectId: project?.id,
        apps: entries.map((entry) => entry.name),
        kind,
        createdAt: backup.capturedAt,
        sizeBytes: entries.reduce((size, entry) => size + entry.backup.sizeBytes, 0),
        contents: [...new Set(entries.flatMap((entry) => entry.backup.volumePaths))],
        destination: getBackupDir(entries[0].name),
        computer: entries[0].deployment.activeNodeId || 'coordinator',
        releaseId,
        verified: false,
        testStatus: 'untested',
        restoreAvailable: available,
        ...(!available
          ? {
              unavailableReason:
                'Restore to a copy requires an available local graph archive and a complete current project release.',
            }
          : {}),
      },
    });
  };
  for (const record of list('v2-release', owner)) {
    if (record.backup)
      add(
        record.backup,
        projects.find((project) => project.id === record.release.projectId),
        'pre-release',
        record.id,
      );
  }
  for (const app of getDeployments(owner)) {
    for (const backup of getBackups(app.name)) {
      if (seen.has(`${app.name}/${backup.filename}`)) continue;
      add(
        {
          id: `app:${app.name}:${backup.filename}`,
          capturedAt: backup.createdAt,
          apps: [app.name],
          runtime: [
            {
              name: app.name,
              deployment: app,
              backup: {
                ...backup,
                timestamp: backup.createdAt,
                format: backup.filename.endsWith('.graph') ? 'application-graph' : 'legacy',
              },
            },
          ],
        },
        projects.find((project) => project.apps.some((entry) => entry.name === app.name)),
        backup.auto ? 'scheduled' : 'manual',
      );
    }
  }
  if (isAdmin(owner)) {
    const rows = getSqlite()!
      .prepare('SELECT * FROM fleet_recovery_bundles ORDER BY created_at DESC')
      .all() as Array<Record<string, any>>;
    for (const row of rows) {
      const artifact = getArtifact(row.artifact_digest);
      const path = JSON.parse(row.encryption_metadata).scheduledPath || artifact?.localPath;
      sources.push({
        bundleId: row.id,
        bundlePath: path,
        point: {
          id: `recovery:${row.id}`,
          name: 'deploy.local',
          apps: [],
          kind: 'recovery',
          createdAt: row.created_at,
          sizeBytes: path && existsSync(path) ? statSync(path).size : null,
          contents: ['Projects, tasks, settings, secrets and recovery inventory'],
          destination: path ? dirname(path) : 'Unavailable',
          computer: 'coordinator',
          verified: row.verification_status === 'verified',
          testedAt: row.rehearsed_at || undefined,
          testStatus:
            row.rehearsal_status === 'passed'
              ? 'passed'
              : row.rehearsal_status === 'failed'
                ? 'failed'
                : 'untested',
          restoreAvailable: false,
          unavailableReason:
            'Recover deploy.local on a new computer. Test-restore checks this bundle in a temporary folder.',
        },
      });
    }
  }
  for (const source of sources) {
    const test = list('v2-backup-test', owner).find((row) => row.id === source.point.id);
    if (test) Object.assign(source.point, { testedAt: test.at, testStatus: test.status });
  }
  return sources.sort((a, b) => b.point.createdAt.localeCompare(a.point.createdAt));
}

/** Preview endpoints never enter the live routing table. Profile credentials still belong to the original app. */
class CopyStore extends DurableGraphRuntimeStore {
  private originalId: string;
  private originalName: string;
  constructor(originalId: string, originalName: string) {
    super();
    this.originalId = originalId;
    this.originalName = originalName;
  }
  override replaceReadyEndpoints() {
    return 0;
  }
  override getOrCreateProfileValue(
    input: Parameters<DurableGraphRuntimeStore['getOrCreateProfileValue']>[0],
  ) {
    return super.getOrCreateProfileValue({
      ...input,
      appId: this.originalId,
      deploymentName: this.originalName,
    });
  }
}

export interface BackupRuntime {
  publish?(record: RestoreRecord): Promise<void>;
  create(record: RestoreRecord, checkpoint: () => void): Promise<void>;
  remove(record: RestoreRecord): Promise<void>;
  switchRuntime(record: RestoreRecord, checkpoint: () => void): ReleaseRuntime;
}

// A failed archive normally reconverges the app. Restore must instead resume
// the exact previous processes, and a successful archive must leave them cold.
class ColdBackupExecutor extends ApplicationGraphExecutor {
  override async converge(): Promise<never> {
    throw new Error('The restore operation will restart the previous apps');
  }
}

export class CoordinatorBackupRuntime implements BackupRuntime {
  readonly docker: GraphDockerAdapter;
  readonly releases: CoordinatorReleaseRuntime;
  constructor(options: { docker?: GraphDockerAdapter; releases?: CoordinatorReleaseRuntime } = {}) {
    this.docker = options.docker ?? new DockerCliGraphAdapter();
    this.releases = options.releases ?? new CoordinatorReleaseRuntime({ docker: this.docker });
  }
  private executor(copy: Copy, app: RuntimeApp) {
    const docker = this.docker;
    const adapter = new Proxy(docker, {
      get(target, key) {
        if (key === 'prepareImage')
          return async (input: { component: string }) => {
            if (!app.images[input.component])
              fail('The current release has no pinned image for this app', 409);
            return app.images[input.component];
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return new ApplicationGraphExecutor({
      docker: adapter,
      state: new CopyStore(app.applicationId, copy.app),
    });
  }
  async create(record: RestoreRecord, checkpoint: () => void) {
    // Uses the release adapter's isolation admission before opening any archive.
    await this.releases.prepare(record.plan);
    for (const entry of record.backup.runtime as BackupEntry[]) {
      if (basename(entry.backup.filename) !== entry.backup.filename)
        fail('Invalid backup filename');
      const app = (record.plan.runtime as { apps: RuntimeApp[] }).apps.find(
        (app) => app.name === entry.name,
      )!;
      const deployment = readDeploymentRecord(entry.name)!;
      const runtime = resolveApplicationGraphRuntime(deployment);
      if (runtime.execution.specDigest !== app.digest)
        fail('The active app changed; create a new restore copy', 409);
      if (
        new DurableGraphRuntimeStore().listProfileVolumeBindings(app.applicationId, 'coordinator')
          .length
      )
        fail('Restore for upgraded profile volumes is not available yet', 422);
      const root = join(getBackupDir(entry.name), entry.backup.filename);
      const content = await readFile(join(root, 'recovery-manifest.json'));
      const expected = entry.backup.filename.match(/-([a-f0-9]{64})\.graph$/)?.[1];
      if (!expected || hash(content) !== `sha256:${expected}`) fail('Backup manifest is corrupt');
      const manifest = JSON.parse(content.toString());
      if (
        manifest.applicationId !== app.applicationId ||
        manifest.siteId !== 'coordinator' ||
        manifest.specDigest !== app.digest ||
        manifest.configurationDigest !== runtime.configurationDigest
      )
        fail(
          'This backup needs its original code and configuration. Roll back the project release first.',
          409,
        );
      if (
        Object.values(runtime.spec.resources).some(
          (resource) => resource.durability === 'durable' && resource.backup.policy === 'exclude',
        )
      )
        fail('The backup excludes durable app data', 422);
      const resources = Object.entries(runtime.spec.resources)
        .filter(([, resource]) => resource.backup.policy !== 'exclude')
        .map(([name]) => name)
        .sort();
      if (
        JSON.stringify(resources) !==
        JSON.stringify(manifest.resources.map((entry: any) => entry.resource).sort())
      )
        fail('The backup does not cover every data resource', 409);
      const copyId = `restore-${record.id}-${record.copies.length}`;
      const copy: Copy = {
        app: entry.name,
        context: {
          applicationId: copyId,
          deploymentName: copyId,
          siteId: 'coordinator',
          nodeId: 'coordinator',
          projectDirectory: app.directory,
          runtime: buildApplicationGraphRuntime({
            applicationId: copyId,
            specDigest: app.digest,
            spec: runtime.spec,
            configuration: {
              digest: runtime.configurationDigest,
              values: runtime.configurationValues,
              missing: runtime.missing,
            },
            siteId: 'coordinator',
          }),
          writerSiteId: 'coordinator',
          validation: { denyExternalNetwork: true },
        },
      };
      record.copies.push(copy);
      checkpoint();
      for (const resource of manifest.resources) {
        if (!/^[a-f0-9]+\.tar\.gz$/.test(resource.archive)) fail('Invalid resource archive');
        const archive = join(root, resource.archive);
        if (
          hash(await readFile(archive)) !== resource.digest ||
          !(await this.docker.verifyVolumeArchive(archive))
        )
          fail('Backup data is corrupt');
        const volume = graphVolumeName(copyId, resource.resource);
        await this.docker.ensureVolume(volume, { 'deploy-sh.app-id': copyId });
        await this.docker.restoreVolume(volume, archive);
      }
      const result = await this.executor(copy, app).converge(copy.context);
      if (result.primaryPort) {
        copy.port = result.primaryPort;
        const host = copyHostname(record.id, entry.name);
        record.addresses.push({ app: entry.name, url: `https://${host}` });
      }
      checkpoint();
    }
  }
  async publish(record: RestoreRecord) {
    // Upgrade copies made before edge access existed, without changing their data.
    for (const copy of record.copies) {
      const address = record.addresses.find((entry) => entry.app === copy.app);
      if (!address) continue;
      const previous = new URL(address.url);
      if (!copy.port && ['localhost', '127.0.0.1'].includes(previous.hostname)) {
        const port = Number(previous.port);
        if (Number.isInteger(port) && port > 0 && port <= 65535) copy.port = port;
      }
      if (copy.port) address.url = `https://${copyHostname(record.id, copy.app)}`;
    }
    record.addresses = record.addresses.filter((address) =>
      record.copies.some(
        (copy) =>
          copy.port &&
          copy.app === address.app &&
          new URL(address.url).hostname === copyHostname(record.id, copy.app),
      ),
    );
    const names = (
      getSqlite()!.prepare('SELECT name FROM deployments').all() as { name: string }[]
    ).map((app) => app.name);
    const rows = db.prepare("SELECT data FROM records WHERE kind='v2-backup-restore'").all() as {
      data: string;
    }[];
    for (const row of rows) {
      const restore = JSON.parse(row.data);
      if (!['ready', 'creating'].includes(restore.state)) continue;
      for (const address of restore.addresses || []) {
        const host = new URL(address.url).hostname;
        if (host.endsWith('.deploy.local')) names.push(host.slice(0, -6));
      }
    }
    for (const address of record.addresses) {
      const name = new URL(address.url).hostname.slice(0, -6);
      if (!names.includes(name)) names.push(name);
    }
    for (const address of record.addresses)
      if (ensureCertCoversHost(new URL(address.url).hostname.slice(0, -6), names))
        notifyCertReload();
  }
  async remove(record: RestoreRecord) {
    for (const copy of record.copies) {
      await new ApplicationGraphExecutor({ docker: this.docker }).remove({
        applicationId: copy.context.applicationId,
        siteId: 'coordinator',
        managedVolumeResources: Object.keys(copy.context.runtime.spec.resources),
        removeInfrastructure: true,
      });
    }
  }
  switchRuntime(record: RestoreRecord, checkpoint: () => void): ReleaseRuntime {
    const runtime = this.releases;
    let checkedBackup: ReleaseBackup;
    return {
      plan: async () => ({
        ...structuredClone(record.plan),
        migrations: [
          { id: `restore:${record.id}`, title: 'Switch to checked data copy', reversible: false },
        ],
      }),
      prepare: async (plan) => {
        await runtime.prepare(plan);
      },
      verify: async () => {
        const entries: BackupEntry[] = [];
        for (const copy of record.copies) {
          const app = (record.plan.runtime as { apps: RuntimeApp[] }).apps.find(
            (app) => app.name === copy.app,
          )!;
          const active = resolveApplicationGraphRuntime(readDeploymentRecord(copy.app)!);
          if (
            active.execution.specDigest !== app.digest ||
            active.configurationDigest !== copy.context.runtime.configurationDigest
          )
            fail('The app configuration changed; cancel and create a new copy', 409);
          copy.context.runtime = buildApplicationGraphRuntime({
            applicationId: copy.context.applicationId,
            specDigest: app.digest,
            spec: active.spec,
            configuration: {
              digest: active.configurationDigest,
              values: active.configurationValues,
              missing: active.missing,
            },
            siteId: 'coordinator',
          });
          const executor = this.executor(copy, app);
          const root = deployDataPath('restore-copies', record.id, copy.context.applicationId);
          await mkdir(root, { recursive: true });
          // Freeze exactly the data the person checked, keeping the copy stopped through Switch.
          const artifact = await executor.createRecoveryPoint(copy.context, root, {
            resume: false,
          });
          const manifest = JSON.parse(await readFile(artifact.artifactReference, 'utf8'));
          manifest.applicationId = app.applicationId;
          const content = `${JSON.stringify(manifest, null, 2)}\n`;
          writeFileSync(artifact.artifactReference, content, { mode: 0o600 });
          const filename = `${record.id}-checked-${hash(content).slice(7)}.graph`;
          await cp(root, join(getBackupDir(copy.app), filename), { recursive: true });
          entries.push({
            name: copy.app,
            deployment: readDeploymentRecord(copy.app)!,
            backup: {
              filename,
              timestamp: now(),
              sizeBytes: manifest.resources.reduce(
                (sum: number, resource: any) => sum + resource.bytes,
                0,
              ),
              format: 'application-graph',
              volumePaths: Object.keys(copy.context.runtime.spec.resources),
            },
          });
        }
        checkedBackup = {
          id: `checked:${record.id}`,
          capturedAt: now(),
          apps: entries.map((entry) => entry.name),
          runtime: entries,
        };
      },
      backup: async (plan) => {
        const state = new DurableGraphRuntimeStore();
        const apps = (plan.runtime as { apps: RuntimeApp[] }).apps;
        const previous = apps.flatMap((app) =>
          state
            .listInstances(app.applicationId, 'coordinator')
            .filter((instance) => instance.status === 'ready'),
        );
        const docker = this.docker;
        const executor = new ColdBackupExecutor({ docker });
        try {
          for (const instance of previous) await docker.stopContainer(instance.containerName);
          const entries = [];
          for (const app of apps) {
            if (
              Object.values(app.spec.resources).some(
                (resource) =>
                  resource.durability === 'durable' && resource.backup.policy === 'exclude',
              )
            )
              fail(`${app.name} excludes durable data from the required live backup`, 409);
            const deployment = readDeploymentRecord(app.name)!;
            const backup = await createCoordinatorApplicationBackup(deployment, 'before-restore', {
              executor: {
                createRecoveryPoint: (context, destination) =>
                  executor.createRecoveryPoint(context, destination, { resume: false }),
                restoreRecoveryPoint: executor.restoreRecoveryPoint.bind(executor),
                converge: executor.converge.bind(executor),
              },
            });
            entries.push({ name: app.name, deployment, backup });
          }
          const backup: ReleaseBackup = {
            id: randomUUID(),
            capturedAt: now(),
            apps: plan.apps.map((app) => app.appId),
            runtime: entries,
          };
          record.retainedBackupId = backup.id;
          checkpoint();
          return backup;
        } catch (error) {
          const resumed = await Promise.allSettled(
            previous.map(async (instance) => {
              await docker.startContainer(instance.containerName);
              state.patchInstance(instance.id, { status: 'ready', health: instance.health });
            }),
          );
          if (resumed.some((result) => result.status === 'rejected'))
            throw Object.assign(
              new Error('The live backup failed and the previous apps could not all restart'),
              { requiresRecovery: true },
            );
          throw error;
        }
      },
      activate: async (plan) =>
        runtime.rollback({ ...plan, migrations: [] }, { ...plan, migrations: [] }, checkedBackup),
      migrate: async () => {},
      watch: runtime.watch.bind(runtime),
      rollback: runtime.rollback.bind(runtime),
      dispose: runtime.dispose.bind(runtime),
    };
  }
}

export class BackupService {
  readonly runtime: BackupRuntime;
  readonly sources: typeof backupSources;
  readonly projects: typeof projectsForOwner;
  readonly watchMs: number;
  constructor(
    runtime: BackupRuntime = new CoordinatorBackupRuntime(),
    sources = backupSources,
    projects = projectsForOwner,
    watchMs = 600_000,
  ) {
    this.runtime = runtime;
    this.sources = sources;
    this.projects = projects;
    this.watchMs = watchMs;
  }
  private record(owner: string, backupId: string, restoreId: string): RestoreRecord {
    const record = get('v2-backup-restore', owner, restoreId) as RestoreRecord;
    if (record.backupId !== backupId) fail('Restore not found', 404);
    if (record.state === 'switching' && record.releaseId) {
      const release = get('v2-release', owner, record.releaseId).release;
      if (release.state !== 'running') {
        record.state = release.state === 'live' ? 'live' : 'failed';
        record.error = release.steps.find((step: any) => step.state === 'failed')?.detail;
        persistRestore(owner, record);
      }
    }
    return record;
  }
  async listing(owner: string): Promise<BackupsResponse> {
    const settings = getBackupSettings();
    return {
      backups: (await this.sources(owner, true)).map((source) => source.point),
      restores: await Promise.all(
        list('v2-backup-restore', owner).map(async (row) => {
          const record = this.record(owner, row.backupId, row.id);
          if (record.state === 'ready' && this.runtime.publish) {
            await this.runtime.publish(record);
            const current = this.record(owner, row.backupId, row.id);
            if (current.state !== 'ready') return publicRestore(current);
            persistRestore(owner, record);
          }
          return publicRestore(record);
        }),
      ),
      schedules: isAdmin(owner)
        ? [
            {
              name: 'App data and deploy.local',
              enabled: settings.enabled,
              schedule: settings.cron,
              destination: settings.destination,
              contents: 'App backups and coordinator database',
            },
            {
              name: 'Encrypted recovery bundle',
              enabled: !!process.env.DEPLOY_RECOVERY_PASSPHRASE,
              schedule: process.env.DEPLOY_RECOVERY_SCHEDULE || '30 2 * * *',
              destination:
                process.env.DEPLOY_RECOVERY_DIRECTORY || deployDataPath('recovery-bundles'),
              contents: 'Projects, tasks, settings, secrets and recovery inventory',
            },
          ]
        : [],
    };
  }
  async restore(owner: string, backupId: string) {
    const source = (await this.sources(owner)).find((source) => source.point.id === backupId);
    if (!source) fail('Backup not found', 404);
    if (!source.point.restoreAvailable || !source.backup)
      fail(source.point.unavailableReason || 'Restore is unavailable', 422);
    const project = (await this.projects(owner)).find(
      (project) => project.id === source.point.projectId,
    );
    if (!project) fail('Project not found', 404);
    const current = currentProjectReleases(owner).find(
      (row) => row.release.projectId === project.id,
    );
    if (!current?.plan)
      fail('A complete current project release is required to restore data safely', 409);
    const record: RestoreRecord = {
      id: randomUUID(),
      backupId,
      projectId: project.id,
      project,
      currentId: current.id,
      plan: structuredClone(current.plan),
      backup: source.backup!,
      copies: [],
      state: 'creating',
      createdAt: now(),
      addresses: [],
    };
    db.transaction(() => {
      assertProjectIdle(owner, project.id);
      if (
        list('v2-backup-restore', owner).some(
          (row) =>
            row.projectId === project.id && ['creating', 'ready', 'switching'].includes(row.state),
        )
      )
        fail('A restore copy already exists for this project', 409);
      persistRestore(owner, record);
    }).immediate();
    try {
      await this.runtime.create(record, () => persistRestore(owner, record));
      await this.runtime.publish?.(record);
      record.state = 'ready';
      save('v2-backup-test', owner, { id: backupId, at: now(), status: 'passed' });
    } catch (error) {
      record.state = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      try {
        await this.runtime.remove(record);
      } catch {
        record.error += ' Copy cleanup needs a retry with Cancel.';
      }
      persistRestore(owner, record);
      throw error;
    }
    persistRestore(owner, record);
    return publicRestore(record);
  }
  async cancel(owner: string, backupId: string, restoreId: string) {
    const record = this.record(owner, backupId, restoreId);
    if (record.state === 'cancelled') return publicRestore(record);
    if (!['ready', 'failed'].includes(record.state) || record.releaseId)
      fail('This restore cannot be cancelled after Switch starts', 409);
    // Claim before awaiting cleanup so Switch cannot race Cancel.
    record.state = 'creating';
    persistRestore(owner, record);
    try {
      await this.runtime.remove(record);
      record.state = 'cancelled';
    } catch (error) {
      record.state = 'failed';
      record.error = String(error);
      throw error;
    } finally {
      persistRestore(owner, record);
    }
    return publicRestore(record);
  }
  async switch(owner: string, backupId: string, restoreId: string, confirm: unknown) {
    if (confirm !== true) fail('Confirm that you checked the copy before switching');
    const project = (await this.projects(owner)).find(
      (project) => project.id === this.record(owner, backupId, restoreId).projectId,
    );
    if (!project) fail('Project not found', 404);
    return db
      .transaction(() => {
        const record = this.record(owner, backupId, restoreId);
        if (record.state !== 'ready') fail('Only a ready restore copy can be switched', 409);
        assertProjectIdle(owner, project.id);
        const current = currentProjectReleases(owner).find(
          (row) => row.release.projectId === project.id,
        );
        if (
          current?.id !== record.currentId ||
          JSON.stringify(project.apps) !== JSON.stringify(record.project.apps)
        )
          fail('The project changed; cancel and create a new copy', 409);
        const service = new ProjectReleaseService(
          this.runtime.switchRuntime(record, () => persistRestore(owner, record)),
          { watchMs: this.watchMs },
        );
        const release = service.ship(owner, project, {
          source: { kind: 'ship', ref: `Restore ${backupId}` },
        });
        record.state = 'switching';
        record.releaseId = release.id;
        persistRestore(owner, record);
        return publicRestore(record);
      })
      .immediate();
  }
  async test(owner: string, backupId: string, passphrase?: string) {
    try {
      return await this.runTest(owner, backupId, passphrase);
    } catch (error) {
      save('v2-backup-test', owner, { id: backupId, at: now(), status: 'failed' });
      throw error;
    }
  }
  private async runTest(owner: string, backupId: string, passphrase?: string) {
    const source = (await this.sources(owner)).find((source) => source.point.id === backupId);
    if (!source) fail('Backup not found', 404);
    if (source.bundleId) {
      if (!isAdmin(owner)) fail('Recovery tests require an administrator', 403);
      if (!source.bundlePath || !passphrase) fail('Enter the recovery passphrase');
      for (const pathname of [
        '/operations/recovery-bundles/verify',
        `/operations/recovery-bundles/${encodeURIComponent(source.bundleId)}/rehearsal`,
      ]) {
        const result = await handleOperationsRequest({
          method: 'POST',
          pathname,
          actor: { username: owner, role: 'admin' },
          body: { bundlePath: source.bundlePath, bundleId: source.bundleId, passphrase },
        });
        if (result.status !== 200) fail((result.body as { error: string }).error, result.status);
      }
    } else {
      const restore = await this.restore(owner, backupId);
      await this.cancel(owner, backupId, restore.id);
    }
    save('v2-backup-test', owner, { id: backupId, at: now(), status: 'passed' });
    return { testedAt: now(), status: 'passed' };
  }
}

const service = new BackupService();
export async function backupsApi(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  operations = service,
): Promise<boolean> {
  try {
    return await backupsDispatch(req, res, { owner, operations });
  } catch (error: any) {
    return sendJson(res, { error: error.message }, error.status || 400);
  }
}

interface BackupsContext {
  owner: string;
  operations: BackupService;
}

const route = routes<BackupsContext>();

export const backupsRoutes = [
  route({
    method: 'GET',
    path: '/api/v2/backups',
    handler: async ({ res, context }) =>
      sendJson(res, await context.operations.listing(context.owner)),
  }),
  route({
    method: 'POST',
    path: '/api/v2/backups/run',
    handler: async ({ res, context }) => {
      if (!isAdmin(context.owner))
        return sendJson(res, { error: 'Only the owner can back up the coordinator' }, 403);
      const result = await maintenance.runBackup();
      return sendJson(res, result, result.success ? 200 : 409);
    },
  }),
  route({
    method: '*',
    path: '/api/v2/backups/:backup/:action(restore|test)',
    handler: ({ req, res, params, context }) =>
      backupRoute(req, res, context, [params.backup, params.action]),
  }),
  route({
    method: '*',
    path: '/api/v2/backups/:backup/:action(restore|test)/:restore/:step(switch|cancel)',
    handler: ({ req, res, params, context }) =>
      backupRoute(req, res, context, [params.backup, params.action, params.restore, params.step]),
  }),
];

const backupsDispatch = dispatch(backupsRoutes, {
  scope: '/api/v2/backups',
  before: ({ req, res }) =>
    !!(req.headers['x-deploy-agent-token'] || req.headers['x-deploy-worker-token']) &&
    sendJson(res, { error: 'Only a signed-in person can restore backups' }, 403),
  notFound: ({ res }) => sendJson(res, { error: 'Not found' }, 404),
});

async function backupRoute(
  req: IncomingMessage,
  res: ServerResponse,
  { owner, operations }: BackupsContext,
  route: [backup: string, action: string, restore?: string, step?: string],
) {
  const send = (value: unknown, status = 200) => sendJson(res, value, status);
  if (req.method !== 'POST') return send({ error: 'Method not allowed' }, 405);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 16_384) {
      req.resume();
      fail('Request body too large', 413);
    }
    chunks.push(Buffer.from(chunk));
  }
  const body = size ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  const backupId = decodeURIComponent(route[0]);
  if (route[1] === 'test' && !route[2])
    return send(await operations.test(owner, backupId, body.passphrase));
  if (route[1] !== 'restore') return send({ error: 'Not found' }, 404);
  if (!route[2]) return send({ restore: await operations.restore(owner, backupId) }, 201);
  const restoreId = decodeURIComponent(route[2]);
  if (route[3] === 'switch')
    return send(
      { restore: await operations.switch(owner, backupId, restoreId, body.confirm) },
      202,
    );
  return send({ restore: await operations.cancel(owner, backupId, restoreId) });
}
