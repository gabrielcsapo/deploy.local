import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { get } from '../workspace/store.ts';
import { inspectUploadArchive } from '../upload-archive.ts';
import { readFileSync } from 'node:fs';
import { getBackupDir } from '../volumes.ts';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Project } from '../../shared/v2/contracts.ts';
import {
  ApplicationGraphExecutor,
  type GraphExecutorContext,
  type GraphMaterializationResult,
} from '../application-graph-executor.ts';
import { resolveApplicationConfiguration } from '../application-configuration.ts';
import { buildApplicationGraphRuntime } from '../application-runtime.ts';
import { readDeploymentDefinition } from '../deploy-config.ts';
import {
  DockerCliGraphAdapter,
  graphVolumeName,
  type GraphContainerCreateRequest,
  type GraphDockerAdapter,
} from '../graph-docker-adapter.ts';
import { DurableGraphRuntimeStore, type ReadyEndpointInput } from '../graph-runtime-store.ts';
import {
  createCoordinatorApplicationBackup,
  restoreCoordinatorApplicationBackup,
} from '../application-backups.ts';
import {
  getSqlite,
  readDeploymentRecord,
  refreshDeploymentInCache,
  saveDesiredApplicationSpec,
} from '../store.ts';
import { deployDataPath } from '../data-directory.ts';
import { notifyRouteChanged } from '../ipc.ts';
import type { ApplicationSpec } from '../application-spec.ts';
import type { ReleaseBackup, ReleasePlan, ReleaseRuntime } from './releases.ts';
import { fail } from './inbox.ts';

const execFileAsync = promisify(execFile);

type RuntimeApp = {
  name: string;
  applicationId: string;
  directory: string;
  spec: ApplicationSpec;
  digest: string;
  images: Record<string, string>;
  source: string | null;
  canonicalJson: string;
};
type RuntimePlan = { apps: RuntimeApp[]; id: string };
type Endpoint = {
  deployment: string;
  service: string;
  endpoints: readonly ReadyEndpointInput[];
  deadline: number;
};

/** Defer traffic publication and retirement until every app has staged successfully. */
class ProjectStageStore extends DurableGraphRuntimeStore {
  endpoints: Endpoint[] = [];
  oldIds: Set<string>;
  jobs = new Map<string, { status: 'succeeded' | 'failed'; exitCode: number; output: string }>();
  constructor(oldIds: Set<string>) {
    super();
    this.oldIds = oldIds;
  }
  override replaceReadyEndpoints(
    deployment: string,
    service: string,
    endpoints: readonly ReadyEndpointInput[],
    deadline: number,
  ) {
    this.endpoints.push({ deployment, service, endpoints, deadline });
    return 0;
  }
  override patchInstance(
    id: string,
    patch: Parameters<DurableGraphRuntimeStore['patchInstance']>[1],
  ) {
    if (this.oldIds.has(id) && ['removed', 'draining'].includes(patch.status || '')) return;
    super.patchInstance(id, patch);
  }
  override finishJob(
    key: string,
    status: 'succeeded' | 'failed',
    exitCode: number,
    output: string,
  ) {
    this.jobs.set(key, { status, exitCode, output });
  }
  publish() {
    for (const row of this.endpoints)
      super.replaceReadyEndpoints(row.deployment, row.service, row.endpoints, row.deadline);
  }
  finishDeferredJob(key: string, exitCode: number, output: string) {
    super.finishJob(key, exitCode === 0 ? 'succeeded' : 'failed', exitCode, output);
  }
}

/** Reuse graph builds, probes and profile operations; keep project coordination outside the executor. */
export class CoordinatorReleaseRuntime implements ReleaseRuntime {
  readonly docker: GraphDockerAdapter;
  readonly workerProbeMs: number;
  readonly pinImage: (image: string) => Promise<string>;
  private staged = new Map<
    string,
    { jobs: GraphContainerCreateRequest[]; state: ProjectStageStore }
  >();
  constructor(
    options: {
      docker?: GraphDockerAdapter;
      workerProbeMs?: number;
      pinImage?: (image: string) => Promise<string>;
    } = {},
  ) {
    this.docker = options.docker ?? new DockerCliGraphAdapter();
    this.workerProbeMs = options.workerProbeMs ?? 5_000;
    this.pinImage =
      options.pinImage ??
      (async (image) => {
        const { stdout } = await execFileAsync('docker', [
          'image',
          'inspect',
          '--format',
          '{{.Id}}',
          image,
        ]);
        const digest = stdout.trim();
        if (!/^sha256:[a-f0-9]{64}$/.test(digest))
          throw new Error('Prepared image digest is unavailable');
        return digest;
      });
  }
  async plan(project: Project, ref?: string): Promise<ReleasePlan> {
    const runtime: RuntimePlan = { id: randomUUID(), apps: [] };
    const apps: ReleasePlan['apps'] = [];
    const migrations: ReleasePlan['migrations'] = [];
    for (const app of project.apps) {
      const deployment = readDeploymentRecord(app.name);
      if (!deployment?.directory) fail(`Source for ${app.name} is unavailable`, 409);
      if (
        (deployment.activeNodeId && deployment.activeNodeId !== 'coordinator') ||
        (deployment.desiredNodeId && deployment.desiredNodeId !== 'coordinator')
      )
        fail(`Project release staging on ${app.name}'s computer is not available`, 422);

      const directory = deployDataPath('project-releases', runtime.id, app.name);
      await mkdir(directory, { recursive: true });
      if (ref) {
        const repository = get('project', deployment.username, project.id);
        const { stdout } = await execFileAsync('git', [
          '-C',
          repository.repositoryPath,
          'rev-parse',
          '--verify',
          '--end-of-options',
          `${ref}^{commit}`,
        ]);
        const commit = stdout.trim();
        if (!/^[a-f0-9]{40,64}$/.test(commit)) fail('Invalid repository ref');
        const archive = join(directory, '.source.tar.gz');
        await execFileAsync('git', [
          '-C',
          repository.repositoryPath,
          'archive',
          '--format=tar.gz',
          `--output=${archive}`,
          commit,
        ]);
        await inspectUploadArchive(archive);
        await execFileAsync('tar', ['-xzf', archive, '-C', directory]);
        await rm(archive);
      } else await cp(deployment.directory, directory, { recursive: true, dereference: false });
      const definition = readDeploymentDefinition(directory);
      this.assertIsolatable(app.name, definition.compiled.spec);
      const { spec, digest } = definition.compiled;
      runtime.apps.push({
        name: app.name,
        applicationId: deployment.appId || app.name,
        directory,
        spec,
        digest,
        source: definition.source,
        canonicalJson: definition.compiled.canonicalJson,
        images: {},
      });
      apps.push({
        appId: app.id,
        ...(deployment.activeSpecDigest ? { from: deployment.activeSpecDigest } : {}),
        to: runtime.id,
      });
      for (const name of Object.keys(spec.jobs))
        migrations.push({ id: `${app.id}:${name}`, title: name, reversible: false });
    }
    return { apps, migrations, runtime };
  }
  private assertIsolatable(name: string, spec: ApplicationSpec) {
    for (const component of Object.values(spec.components)) {
      if (
        component.runtime.networkMode === 'host' ||
        component.runtime.privileged ||
        component.runtime.privilegedDocker ||
        component.runtime.devices.length ||
        component.runtime.networks.length
      )
        fail(`${name} requires host access that cannot be isolated for Verify`, 422);
    }
    if (
      Object.values(spec.resources).some(
        (resource) => resource.source || resource.ownership === 'external',
      )
    )
      fail(`${name} has external data that cannot be copied for Verify`, 422);
    if (
      readDeploymentRecord(name)?.volumes &&
      JSON.parse(readDeploymentRecord(name)!.volumes!).length
    )
      fail(`${name} has host mounts that cannot be copied for Verify`, 422);
  }
  private context(app: RuntimeApp, applicationId = app.applicationId): GraphExecutorContext {
    const configuration = resolveApplicationConfiguration({
      deploymentName: app.name,
      specDigest: app.digest,
      declarations: app.spec.configuration,
      siteId: 'coordinator',
    });
    if (!configuration.ready)
      fail(
        `Required configuration is missing for ${app.name}: ${configuration.missing.join(', ')}`,
        422,
      );
    const runtime = buildApplicationGraphRuntime({
      applicationId,
      specDigest: app.digest,
      spec: app.spec,
      configuration,
      siteId: 'coordinator',
    });
    return {
      applicationId,
      deploymentName: applicationId === app.applicationId ? app.name : applicationId,
      siteId: 'coordinator',
      nodeId: 'coordinator',
      projectDirectory: app.directory,
      runtime,
      writerSiteId: 'coordinator',
      drainTimeoutMs: 0,
      forceReplace: true,
    };
  }
  private adapter(
    app: RuntimeApp,
    overrides: Partial<GraphDockerAdapter> = {},
  ): GraphDockerAdapter {
    const docker = this.docker;
    return new Proxy(docker, {
      get(target, key) {
        if (key === 'prepareImage')
          return async (input: Parameters<GraphDockerAdapter['prepareImage']>[0]) => {
            const image = app.images[input.component];
            if (!image)
              throw new Error(`Prepared image missing for ${app.name}/${input.component}`);
            return image;
          };
        if (key in overrides) return overrides[key as keyof GraphDockerAdapter];
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  async prepare(plan: ReleasePlan) {
    for (const app of (plan.runtime as RuntimePlan).apps) {
      this.assertIsolatable(app.name, app.spec);
      const context = this.context(app);
      const adapter = new Proxy(this.docker, {
        get: (target, key) => {
          if (key === 'prepareImage')
            return async (input: Parameters<GraphDockerAdapter['prepareImage']>[0]) => {
              if (app.images[input.component]) return app.images[input.component];
              const image = await target.prepareImage({
                ...input,
                applicationId: `release-${(plan.runtime as RuntimePlan).id}-${app.name}`,
                forceBuild: true,
              });
              app.images[input.component] = await this.pinImage(image);
              return app.images[input.component];
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      await new ApplicationGraphExecutor({ docker: adapter }).prepare(context);
    }
  }
  async verify(plan: ReleasePlan, backup?: ReleaseBackup) {
    for (const app of (plan.runtime as RuntimePlan).apps) {
      const temporaryId = `verify-${randomUUID()}`;
      const context = this.context(app, temporaryId);
      context.validation = { denyExternalNetwork: true };
      const state = new ProjectStageStore(new Set());
      // Profiles must use the existing database credentials on the copied data.
      const originalValue = state.getOrCreateProfileValue.bind(state);
      state.getOrCreateProfileValue = (input) =>
        originalValue({ ...input, appId: app.applicationId, deploymentName: app.name });
      const executor = new ApplicationGraphExecutor({ docker: this.adapter(app), state });
      const root = await mkdtemp(deployDataPath('project-releases', 'verify-'));
      try {
        for (const [resource, definition] of Object.entries(app.spec.resources)) {
          const binding = state
            .listProfileVolumeBindings(app.applicationId, 'coordinator')
            .find((row) => row.resourceKey === resource);
          const source =
            binding?.activeProviderVolume || graphVolumeName(app.applicationId, resource);
          const destination = graphVolumeName(temporaryId, resource);
          await this.docker.ensureVolume(destination, { 'deploy-sh.app-id': temporaryId });
          if (backup) {
            const entry = (
              backup.runtime as { name: string; backup: { filename: string; format: string } }[]
            ).find((row) => row.name === app.name);
            if (!entry || entry.backup.format !== 'application-graph')
              throw new Error('A graph backup is required to verify the rollback copy');
            const backupRoot = join(getBackupDir(app.name), entry.backup.filename);
            const manifest = JSON.parse(
              readFileSync(join(backupRoot, 'recovery-manifest.json'), 'utf8'),
            );
            const resourceArchive = manifest.resources.find(
              (row: { resource: string }) => row.resource === resource,
            );
            if (!resourceArchive || !/^[a-f0-9]+\.tar\.gz$/.test(resourceArchive.archive))
              throw new Error(`Backup is missing ${resource}`);
            const archive = join(backupRoot, resourceArchive.archive);
            const digest = `sha256:${createHash('sha256').update(readFileSync(archive)).digest('hex')}`;
            if (
              digest !== resourceArchive.digest ||
              !(await this.docker.verifyVolumeArchive(archive))
            )
              throw new Error(`Backup data for ${resource} is corrupt`);
            await this.docker.restoreVolume(destination, archive);
          } else if (await this.docker.volumeExists(source)) {
            const archive = join(
              root,
              `${Object.keys(app.spec.resources).indexOf(resource)}.tar.gz`,
            );
            await this.docker.exportVolume(source, archive);
            if (!(await this.docker.verifyVolumeArchive(archive)))
              throw new Error(`Data copy for ${app.name}/${resource} is unreadable`);
            await this.docker.restoreVolume(destination, archive);
          } else if (
            definition.durability === 'durable' &&
            readDeploymentRecord(app.name)?.containerId
          ) {
            throw new Error(`Existing data volume for ${app.name}/${resource} is unavailable`);
          }
        }
        const result = await executor.converge(context);
        await this.probe(app, result, context);
      } finally {
        await executor.remove({
          applicationId: temporaryId,
          siteId: 'coordinator',
          managedVolumeResources: Object.keys(app.spec.resources),
          removeInfrastructure: true,
        });
        await rm(root, { recursive: true, force: true });
      }
    }
  }
  private async probe(
    app: RuntimeApp,
    result: Pick<GraphMaterializationResult, 'instances'>,
    context: GraphExecutorContext,
  ) {
    for (const instance of result.instances) {
      const component = context.runtime.execution.components[instance.componentKey];
      if (component.role === 'worker') {
        await delay(this.workerProbeMs);
        const inspection = await this.docker.inspectContainer(instance.containerName);
        if (!inspection.running || (!component.health && inspection.health !== 'healthy'))
          throw new Error(
            `${app.name}/${instance.componentKey} needs a healthy process and a heartbeat or health signal`,
          );
      }
      if (component.health) {
        const endpoint = component.interfaces[component.health.interface];
        const healthy = await this.docker.waitHealthy(
          instance.containerName,
          endpoint.protocol === 'http'
            ? { kind: 'http', containerPort: endpoint.port, path: component.health.path ?? '/' }
            : { kind: 'tcp', containerPort: endpoint.port },
          30_000,
        );
        if (!healthy)
          throw new Error(`${app.name}/${instance.componentKey} did not answer its health check`);
      } else if (component.role === 'web') {
        const endpoint = Object.values(component.interfaces).find(
          (entry) => entry.protocol === 'http',
        );
        if (
          !endpoint ||
          !(await this.docker.waitHealthy(
            instance.containerName,
            { kind: 'http', containerPort: endpoint.port, path: '/' },
            30_000,
          ))
        )
          throw new Error(`${app.name} did not answer HTTP on its copy`);
      }
    }
  }
  async backup(plan: ReleasePlan): Promise<ReleaseBackup> {
    const apps = (plan.runtime as RuntimePlan).apps;
    const state = new DurableGraphRuntimeStore();
    const previous = apps.flatMap((app) =>
      state.listInstances(app.applicationId, 'coordinator').filter((row) => row.status === 'ready'),
    );
    const executor = new ApplicationGraphExecutor({ docker: this.docker });
    const backups = [];
    try {
      for (const instance of previous) await this.docker.stopContainer(instance.containerName);
      for (const app of apps) {
        const deployment = readDeploymentRecord(app.name)!;
        if (
          Object.values(app.spec.resources).some(
            (resource) => resource.durability === 'durable' && resource.backup.policy === 'exclude',
          )
        )
          fail(`${app.name} excludes durable data from the required pre-release backup`, 409);
        const backup = await createCoordinatorApplicationBackup(deployment, 'pre-release', {
          executor: {
            createRecoveryPoint: (context, destination) =>
              executor.createRecoveryPoint(context, destination, { resume: false }),
            restoreRecoveryPoint: executor.restoreRecoveryPoint.bind(executor),
            converge: executor.converge.bind(executor),
          },
        });
        backups.push({ name: app.name, deployment, backup });
      }
    } finally {
      // Resume the exact previous processes, never rebuild from a newer uploaded tree.
      for (const instance of previous) {
        await this.docker.startContainer(instance.containerName);
        state.patchInstance(instance.id, { status: 'ready', health: instance.health });
      }
    }
    return {
      id: randomUUID(),
      capturedAt: backups[0]?.backup.timestamp || new Date().toISOString(),
      apps: plan.apps.map((app) => app.appId),
      runtime: backups,
    };
  }
  async activate(plan: ReleasePlan, options: { resumePrevious?: boolean } = {}) {
    const runtime = plan.runtime as RuntimePlan;
    const state = new DurableGraphRuntimeStore();
    const previous = runtime.apps.flatMap((app) =>
      state
        .listInstances(app.applicationId, 'coordinator')
        .filter((row) => row.status !== 'removed'),
    );
    const previousNames = new Set(previous.map((row) => row.containerName));
    const stagedState = new ProjectStageStore(new Set(previous.map((row) => row.id)));
    const jobs: GraphContainerCreateRequest[] = [];
    const results: {
      app: RuntimeApp;
      result: GraphMaterializationResult;
      context: GraphExecutorContext;
    }[] = [];
    // Quiesce the whole project after Verify, before opening its data with new processes.
    try {
      for (const instance of previous) {
        await this.docker.stopContainer(instance.containerName);
        state.patchInstance(instance.id, { status: 'stopped', health: 'unknown' });
      }
      for (const app of runtime.apps) {
        const context = this.context(app);
        const executor = new ApplicationGraphExecutor({
          state: stagedState,
          docker: this.adapter(app, {
            stopContainer: async (name) => {
              if (!previousNames.has(name)) await this.docker.stopContainer(name);
            },
            removeContainer: async (name) => {
              if (!previousNames.has(name)) await this.docker.removeContainer(name);
            },
            runOneShot: async (request) => {
              jobs.push(request);
              return { exitCode: 0, output: 'Waiting for project activation' };
            },
          }),
        });
        const result = await executor.converge(context);
        await this.probe(app, result, context);
        results.push({ app, result, context });
      }
      const sql = getSqlite()!;
      sql
        .transaction(() => {
          for (const { app, result, context } of results) {
            saveDesiredApplicationSpec({
              digest: app.digest,
              deploymentName: app.name,
              apiVersion: app.spec.apiVersion,
              source: 'repository',
              manifestFormat: 'deploy.yaml',
              normalizedSpec: app.canonicalJson,
              ...(app.source ? { originalSource: app.source } : {}),
              createdBy: readDeploymentRecord(app.name)!.username,
            });
            sql
              .prepare(
                "UPDATE deployments SET port=?,container_id=?,container_name=?,active_spec_digest=?,configuration_digest=?,desired_release_digest=?,release_generation=release_generation+1,status='running',updated_at=? WHERE name=?",
              )
              .run(
                result.primaryPort,
                result.primaryContainerId,
                result.primaryContainerName,
                app.digest,
                context.runtime.configurationDigest,
                app.digest,
                new Date().toISOString(),
                app.name,
              );
          }
          stagedState.publish();
          for (const instance of previous)
            state.patchInstance(instance.id, { status: 'removed', health: 'unknown' });
        })
        .immediate();
      this.staged.set(runtime.id, { jobs, state: stagedState });
      for (const app of runtime.apps) {
        refreshDeploymentInCache(app.name);
        notifyRouteChanged(app.name);
      }
    } catch (error) {
      for (const app of runtime.apps) {
        for (const instance of state.listInstances(app.applicationId, 'coordinator')) {
          if (!previousNames.has(instance.containerName)) {
            await this.docker.removeContainer(instance.containerName);
            state.patchInstance(instance.id, { status: 'removed' });
          }
        }
      }
      if (options.resumePrevious === false)
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          requiresRecovery: true,
        });
      const recovered = await Promise.allSettled(
        previous.map(async (instance) => {
          await this.docker.startContainer(instance.containerName);
          state.patchInstance(instance.id, { status: instance.status, health: instance.health });
        }),
      );
      if (recovered.some((result) => result.status === 'rejected'))
        throw Object.assign(new Error('Previous project processes could not all be restored'), {
          requiresRecovery: true,
        });
      throw error;
    }
  }
  async migrate(plan: ReleasePlan) {
    const pending = this.staged.get((plan.runtime as RuntimePlan).id);
    if (!pending) return;
    for (const job of pending.jobs) {
      const result = await this.docker.runOneShot(job);
      pending.state.finishDeferredJob(
        job.labels['deploy-sh.job-key'],
        result.exitCode,
        result.output,
      );
      if (result.exitCode !== 0)
        throw new Error(
          `Migration ${job.labels['deploy-sh.job']} failed; review the release log before rollback`,
        );
    }
  }
  async watch(plan: ReleasePlan, milliseconds: number) {
    const deadline = Date.now() + milliseconds;
    const state = new DurableGraphRuntimeStore();
    do {
      for (const app of (plan.runtime as RuntimePlan).apps) {
        const context = this.context(app);
        const instances = state
          .listInstances(app.applicationId, 'coordinator')
          .filter((row) => row.status === 'ready');
        if (!instances.length) throw new Error(`${app.name} has no ready processes`);
        for (const instance of instances) {
          if (!(await this.docker.inspectContainer(instance.containerName)).running)
            throw new Error(`${app.name} stopped during Watch`);
        }
        await this.probe(app, { instances }, context);
      }
      if (Date.now() >= deadline) break;
      await delay(Math.min(5_000, deadline - Date.now()));
    } while (Date.now() < deadline);
  }
  async rollback(from: ReleasePlan, to: ReleasePlan, backup?: ReleaseBackup) {
    if (
      from.migrations.some(
        (migration) => migration.reversible && !migration.id.includes(':profile:'),
      )
    )
      throw new Error('No reverse operation is registered for this migration');
    if (from.migrations.some((migration) => !migration.reversible) && !backup)
      throw new Error('Required pre-release backup missing');
    if (backup) {
      try {
        const executor = new ApplicationGraphExecutor({ docker: this.docker });
        for (const app of (from.runtime as RuntimePlan).apps)
          await executor.stop({ applicationId: app.applicationId, siteId: 'coordinator' });
        for (const entry of backup.runtime as {
          name: string;
          deployment: NonNullable<ReturnType<typeof readDeploymentRecord>>;
          backup: { filename: string };
        }[])
          await restoreCoordinatorApplicationBackup(entry.deployment, entry.backup.filename, {
            executor: {
              createRecoveryPoint: executor.createRecoveryPoint.bind(executor),
              restoreRecoveryPoint: executor.restoreRecoveryPoint.bind(executor),
              // Keep every restored app cold until the project activation barrier.
              converge: async (context) => ({
                applicationId: context.applicationId,
                releaseDigest: context.runtime.execution.specDigest,
                configurationDigest: context.runtime.configurationDigest,
                network: '',
                primaryPort: null,
                primaryContainerId: null,
                primaryContainerName: null,
                instances: [],
              }),
            },
          });
      } catch (error) {
        throw Object.assign(
          new Error(
            `Backup restore did not complete: ${error instanceof Error ? error.message : String(error)}`,
          ),
          { requiresRecovery: true },
        );
      }
    }
    for (const app of (from.runtime as RuntimePlan).apps) {
      const target = (to.runtime as RuntimePlan).apps.find((entry) => entry.name === app.name)!;
      const sourceContext = this.context(app),
        targetContext = this.context(target);
      for (const migration of from.migrations.filter(
        (entry) => entry.reversible && entry.id.startsWith(`${app.name}:profile:`),
      )) {
        const component = migration.id.slice(`${app.name}:profile:`.length);
        await new ApplicationGraphExecutor({ docker: this.docker }).executeProfileOperation(
          sourceContext,
          { component, operation: 'rollback', targetContext },
        );
      }
    }
    await this.activate(to, { resumePrevious: !backup && from.migrations.length === 0 });
    // The target's jobs already ran in its original release; no new migration is inferred.
  }
  async dispose(plan: ReleasePlan) {
    this.staged.delete((plan.runtime as RuntimePlan).id);
    // Immutable source and image receipts are retained for subsequent rollback.
  }
}
