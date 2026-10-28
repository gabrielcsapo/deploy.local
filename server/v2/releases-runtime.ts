import { dispatchReleaseNodeJob, type ReleaseNodeTransport } from './releases-remote.ts';
import type { ReleaseNodePhase, ReleaseNodePayload, ReleaseNodeResult } from './releases-worker.ts';
import { createAgentGraphPayload } from '../agent-graph-payload.ts';
import { recordAgentGraphMaterialization } from '../agent-graph-recording.ts';
import { readReleaseJournal, writeReleaseJournal } from './releases-journal.ts';
import type { ShipChoices } from './releases-plan.ts';
import { compileDeployYaml, renderDeployYaml } from '../application-spec.ts';
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
  getNode,
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
  nodeId?: string;
  applicationId: string;
  directory: string;
  spec: ApplicationSpec;
  digest: string;
  images: Record<string, string>;
  source: string | null;
  canonicalJson: string;
  choice?: ShipChoices['apps'][number];
  originalApplicationId?: string;
  reverse?: Record<string, string[]>;
};
type RuntimePlan = { apps: RuntimeApp[]; id: string; activated?: boolean };
type ActivationJournal = {
  phase: 'staging' | 'published' | 'aborted';
  previous: ReturnType<DurableGraphRuntimeStore['listInstances']>;
  jobs: GraphContainerCreateRequest[];
  finished: string[];
  running?: string;
};
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
  readonly remote: ReleaseNodeTransport;
  readonly workerProbeMs: number;
  readonly pinImage: (image: string) => Promise<string>;
  private staged = new Map<
    string,
    { jobs: GraphContainerCreateRequest[]; state: ProjectStageStore }
  >();
  constructor(
    options: {
      docker?: GraphDockerAdapter;
      remote?: ReleaseNodeTransport;
      workerProbeMs?: number;
      pinImage?: (image: string) => Promise<string>;
    } = {},
  ) {
    this.remote = options.remote ?? dispatchReleaseNodeJob;
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
  async plan(project: Project, ref?: string, choices?: ShipChoices): Promise<ReleasePlan> {
    const runtime: RuntimePlan = { id: randomUUID(), apps: [] };
    const apps: ReleasePlan['apps'] = [];
    const migrations: ReleasePlan['migrations'] = [];
    for (const app of project.apps) {
      const deployment = readDeploymentRecord(app.name);
      if (!deployment?.directory) fail(`Source for ${app.name} is unavailable`, 409);

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
      const choice = choices?.apps.find((entry) => entry.appId === app.id);
      let compiled = definition.compiled;
      if (choice) {
        const spec = structuredClone(compiled.spec);
        for (const route of Object.values(spec.routes)) {
          route.hostname = choice.address;
          route.discoverable = choice.visibility === 'home';
        }
        compiled = compileDeployYaml(renderDeployYaml(spec));
      }
      const { spec, digest } = compiled;
      const reverse: Record<string, string[]> = {};
      try {
        const metadata = JSON.parse(
          readFileSync(join(directory, 'release-migrations.json'), 'utf8'),
        );
        for (const [name, command] of Object.entries(metadata.reverse || {})) {
          if (
            !spec.jobs[name] ||
            !Array.isArray(command) ||
            !command.length ||
            command.some((word) => typeof word !== 'string' || !word || word.includes('\0'))
          )
            fail(`Invalid reverse command for migration ${name}`);
          reverse[name] = command;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      runtime.apps.push({
        name: app.name,
        nodeId:
          choice?.computerId ||
          deployment.desiredNodeId ||
          deployment.activeNodeId ||
          'coordinator',
        applicationId: deployment.appId || app.name,
        originalApplicationId: deployment.appId || app.name,
        choice,
        reverse,
        directory,
        spec,
        digest,
        source: definition.source,
        canonicalJson: compiled.canonicalJson,
        images: {},
      });
      apps.push({
        appId: app.id,
        ...(deployment.activeSpecDigest ? { from: deployment.activeSpecDigest } : {}),
        to: runtime.id,
      });
      for (const name of Object.keys(spec.jobs))
        migrations.push({ id: `${app.id}:${name}`, title: name, reversible: !!reverse[name] });
    }
    return { apps, migrations, runtime };
  }
  fork(plan: ReleasePlan): ReleasePlan {
    const copy = structuredClone(plan);
    (copy.runtime as RuntimePlan).id = randomUUID();
    (copy.runtime as RuntimePlan).activated = false;
    return copy;
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
      siteId: app.nodeId || 'coordinator',
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
      siteId: app.nodeId || 'coordinator',
    });
    return {
      applicationId,
      deploymentName: applicationId === app.applicationId ? app.name : applicationId,
      siteId: app.nodeId || 'coordinator',
      nodeId: app.nodeId || 'coordinator',
      projectDirectory: app.directory,
      runtime,
      writerSiteId: app.nodeId || 'coordinator',
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
  private async onComputer(
    plan: ReleasePlan,
    app: RuntimeApp,
    phase: ReleaseNodePhase,
    extra: Partial<ReleaseNodePayload> = {},
  ) {
    const runtime = plan.runtime as RuntimePlan;
    let artifact: string | undefined;
    let graph;
    if (phase === 'prepare') {
      artifact = deployDataPath('project-releases', runtime.id, `${app.name}.tar.gz`);
      await mkdir(deployDataPath('project-releases', runtime.id), { recursive: true });
      await execFileAsync('tar', ['-czf', artifact, '-C', app.directory, '.']);
      const context = this.context(app);
      graph = createAgentGraphPayload({
        deploymentName: app.name,
        applicationId: app.applicationId,
        siteId: app.nodeId!,
        writerSiteId: app.nodeId!,
        runtime: context.runtime,
      });
    }
    return this.remote(
      app.nodeId!,
      app.name,
      {
        version: 1,
        releaseId: runtime.id,
        phase,
        graph,
        images: app.images,
        data: app.choice?.data,
        ...extra,
      },
      artifact,
    );
  }
  async prepare(plan: ReleasePlan) {
    for (const app of (plan.runtime as RuntimePlan).apps) {
      if (app.nodeId && app.nodeId !== 'coordinator') {
        await this.onComputer(plan, app, 'prepare');
        continue;
      }
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
      if (app.nodeId && app.nodeId !== 'coordinator') {
        const entry = (backup?.runtime as any[] | undefined)?.find((row) => row.name === app.name);
        const result = await this.onComputer(
          plan,
          app,
          'verify',
          entry ? { backupId: entry.backupId, backupReleaseId: entry.releaseId } : {},
        );
        app.images = result.images || {};
        if (!result.verified) throw new Error(`${app.name} did not verify on its computer`);
        continue;
      }
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
            .listProfileVolumeBindings(
              app.originalApplicationId || app.applicationId,
              'coordinator',
            )
            .find((row) => row.resourceKey === resource);
          const source =
            binding?.activeProviderVolume ||
            graphVolumeName(app.originalApplicationId || app.applicationId, resource);
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
    writeReleaseJournal((plan.runtime as RuntimePlan).id, {
      phase: 'staging',
      previous,
      jobs: [],
      finished: [],
    });
    try {
      for (const instance of previous) await this.docker.stopContainer(instance.containerName);
      for (const app of apps.filter((entry) => entry.nodeId && entry.nodeId !== 'coordinator'))
        await this.onComputer(plan, app, 'quiesce');
      for (const app of apps) {
        if (app.nodeId && app.nodeId !== 'coordinator') {
          const backupId = randomUUID();
          await this.onComputer(plan, app, 'backup', { backupId });
          backups.push({
            name: app.name,
            nodeId: app.nodeId,
            releaseId: (plan.runtime as RuntimePlan).id,
            backupId,
          });
          continue;
        }
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
      capturedAt: new Date().toISOString(),
      apps: plan.apps.map((app) => app.appId),
      runtime: backups,
    };
  }
  async activate(
    plan: ReleasePlan,
    options: { resumePrevious?: boolean; skipMigrations?: boolean } = {},
  ) {
    const runtime = plan.runtime as RuntimePlan;
    const remoteApps = runtime.apps.filter((app) => app.nodeId && app.nodeId !== 'coordinator');
    const localApps = runtime.apps.filter((app) => !remoteApps.includes(app));
    const remoteResults: { app: RuntimeApp; receipt: ReleaseNodeResult }[] = [];
    const state = new DurableGraphRuntimeStore();
    const previous = localApps.flatMap((app) =>
      state
        .listInstances(app.originalApplicationId || app.applicationId, 'coordinator')
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
    const journal: ActivationJournal = { phase: 'staging', previous, jobs, finished: [] };
    getSqlite()!.prepare('DELETE FROM project_release_activation WHERE id=?').run(runtime.id);
    writeReleaseJournal(runtime.id, journal);
    // Quiesce the whole project after Verify, before opening its data with new processes.
    try {
      for (const app of remoteApps) await this.onComputer(plan, app, 'quiesce');
      for (const instance of previous) {
        await this.docker.stopContainer(instance.containerName);
        state.patchInstance(instance.id, { status: 'stopped', health: 'unknown' });
      }
      for (const app of remoteApps) {
        const receipt = await this.onComputer(plan, app, 'activate', {
          skipMigrations: options.skipMigrations,
        });
        if (receipt.phase !== 'activated' || !receipt.result)
          throw new Error(`${app.name} did not activate`);
        remoteResults.push({ app, receipt });
      }
      for (const app of localApps) {
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
      writeReleaseJournal(runtime.id, journal);
      const sql = getSqlite()!;
      sql
        .transaction(() => {
          for (const { app, result, context } of results) {
            saveDesiredApplicationSpec({
              digest: app.digest,
              parentDigest:
                readDeploymentRecord(app.name)!.desiredSpecDigest ||
                readDeploymentRecord(app.name)!.activeSpecDigest,
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
          for (const { app, receipt } of remoteResults) {
            const context = this.context(app);
            const node = getNode(app.nodeId!);
            if (!node?.address) throw new Error('Computer address is unavailable');
            saveDesiredApplicationSpec({
              digest: app.digest,
              parentDigest:
                readDeploymentRecord(app.name)!.desiredSpecDigest ||
                readDeploymentRecord(app.name)!.activeSpecDigest,
              deploymentName: app.name,
              apiVersion: app.spec.apiVersion,
              source: 'repository',
              manifestFormat: 'deploy.yaml',
              normalizedSpec: app.canonicalJson,
              createdBy: readDeploymentRecord(app.name)!.username,
            });
            recordAgentGraphMaterialization({
              deploymentName: app.name,
              applicationId: app.applicationId,
              siteId: app.nodeId!,
              nodeId: app.nodeId!,
              nodeAddress: node.address,
              relayPort: receipt.port || null,
              runtime: context.runtime,
              result: receipt.result!,
            });
            sql
              .prepare(
                "UPDATE deployments SET port=?,container_id=?,container_name=?,active_node_id=?,desired_node_id=?,active_spec_digest=?,desired_release_digest=?,configuration_digest=?,status='running' WHERE name=?",
              )
              .run(
                receipt.port || null,
                receipt.result!.primaryContainerId,
                receipt.result!.primaryContainerName,
                app.nodeId,
                app.nodeId,
                app.digest,
                app.digest,
                context.runtime.configurationDigest,
                app.name,
              );
          }
          for (const app of runtime.apps) {
            if (app.choice)
              sql
                .prepare('UPDATE deployments SET discoverable=? WHERE name=?')
                .run(app.choice.visibility === 'home' ? 1 : 0, app.name);
          }
          sql
            .prepare('INSERT OR REPLACE INTO project_release_activation VALUES(?,?)')
            .run(runtime.id, new Date().toISOString());
          stagedState.publish();
          for (const instance of previous)
            state.patchInstance(instance.id, { status: 'removed', health: 'unknown' });
        })
        .immediate();
      runtime.activated = true;
      journal.phase = 'published';
      writeReleaseJournal(runtime.id, journal);
      this.staged.set(runtime.id, { jobs, state: stagedState });
      for (const app of runtime.apps) {
        refreshDeploymentInCache(app.name);
        notifyRouteChanged(app.name);
      }
    } catch (error) {
      const remoteRecovery = await Promise.allSettled(
        remoteApps.map((app) =>
          this.onComputer(plan, app, options.resumePrevious === false ? 'recover' : 'abort'),
        ),
      );
      if (
        remoteRecovery.some((result) => result.status === 'rejected') ||
        (error as any).requiresRecovery
      )
        throw Object.assign(new Error('Computer activation needs recovery'), {
          requiresRecovery: true,
        });
      for (const app of localApps) {
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
      journal.phase = 'aborted';
      writeReleaseJournal(runtime.id, journal);
      throw error;
    }
  }
  async recover(plan: ReleasePlan): Promise<'activated' | 'aborted'> {
    const runtime = plan.runtime as RuntimePlan;
    const journal = readReleaseJournal<ActivationJournal>(runtime.id);
    if (!journal) {
      if (readReleaseJournal(`rollback-${runtime.id}`))
        throw Object.assign(
          new Error(
            'Rollback data changes were interrupted before activation; recovery is required',
          ),
          { requiresRecovery: true },
        );
      return 'aborted';
    }
    const sql = getSqlite()!;
    const table = sql
      .prepare("SELECT 1 FROM sqlite_master WHERE name='project_release_activation'")
      .get();
    if (
      table &&
      sql.prepare('SELECT 1 FROM project_release_activation WHERE id=?').get(runtime.id)
    ) {
      for (const app of runtime.apps.filter(
        (entry) => entry.nodeId && entry.nodeId !== 'coordinator',
      )) {
        const receipt = await this.onComputer(plan, app, 'status');
        if (receipt.phase !== 'activated')
          throw Object.assign(new Error('Published computer activation needs recovery'), {
            requiresRecovery: true,
          });
      }
      runtime.activated = true;
      return 'activated';
    }
    const rollback = readReleaseJournal<{ state: string }>(`rollback-${runtime.id}`);
    if (rollback?.state === 'data-ready') {
      for (const app of runtime.apps.filter(
        (entry) => entry.nodeId && entry.nodeId !== 'coordinator',
      ))
        await this.onComputer(plan, app, 'recover');
      await this.activate(plan, { resumePrevious: false, skipMigrations: true });
      return 'activated';
    }
    if (rollback)
      throw Object.assign(
        new Error('Rollback data operation was interrupted; project remains stopped for recovery'),
        { requiresRecovery: true },
      );
    for (const app of runtime.apps.filter(
      (entry) => entry.nodeId && entry.nodeId !== 'coordinator',
    ))
      await this.onComputer(plan, app, 'abort');
    const state = new DurableGraphRuntimeStore();
    const names = new Set(journal.previous.map((instance) => instance.containerName));
    for (const app of runtime.apps) {
      for (const instance of state.listInstances(app.applicationId, 'coordinator')) {
        if (!names.has(instance.containerName)) {
          await this.docker.removeContainer(instance.containerName);
          state.patchInstance(instance.id, { status: 'removed' });
        }
      }
    }
    if (readReleaseJournal(`rollback-${runtime.id}`))
      throw Object.assign(
        new Error(
          'Rollback data changes require recovery; original processes cannot safely resume',
        ),
        { requiresRecovery: true },
      );
    for (const instance of journal.previous) {
      if (instance.status === 'ready') await this.docker.startContainer(instance.containerName);
      state.patchInstance(instance.id, { status: instance.status, health: instance.health });
    }
    journal.phase = 'aborted';
    writeReleaseJournal(runtime.id, journal);
    return 'aborted';
  }
  async migrate(plan: ReleasePlan) {
    for (const app of (plan.runtime as RuntimePlan).apps.filter(
      (entry) => entry.nodeId && entry.nodeId !== 'coordinator',
    ))
      await this.onComputer(plan, app, 'migrate');
    const runtime = plan.runtime as RuntimePlan;
    const journal = readReleaseJournal<ActivationJournal>(runtime.id);
    if (!journal || journal.phase === 'aborted') return;
    const state = new ProjectStageStore(new Set());
    for (const job of journal.jobs) {
      const key = job.labels['deploy-sh.job-key'];
      if (journal.finished.includes(key)) continue;
      if (journal.running === key)
        throw Object.assign(
          new Error('Migration outcome is uncertain after restart; data recovery is required'),
          { requiresRecovery: true },
        );
      journal.running = key;
      writeReleaseJournal(runtime.id, journal);
      const result = await this.docker.runOneShot(job);
      state.finishDeferredJob(key, result.exitCode, result.output);
      if (result.exitCode !== 0)
        throw new Error(
          `Migration ${job.labels['deploy-sh.job']} failed; review the release log before rollback`,
        );
      journal.finished.push(key);
      delete journal.running;
      writeReleaseJournal(runtime.id, journal);
    }
  }
  async watch(plan: ReleasePlan, milliseconds: number) {
    const deadline = Date.now() + milliseconds;
    const state = new DurableGraphRuntimeStore();
    do {
      for (const app of (plan.runtime as RuntimePlan).apps) {
        if (app.nodeId && app.nodeId !== 'coordinator') {
          await this.onComputer(plan, app, 'watch');
          continue;
        }
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
    const origins = from.undo || [from];
    if (
      origins.some((origin) =>
        origin.migrations.some(
          (migration) =>
            migration.reversible &&
            !migration.id.includes(':profile:') &&
            !(origin.runtime as RuntimePlan).apps.some(
              (app) =>
                migration.id.startsWith(`${app.name}:`) &&
                app.reverse?.[migration.id.slice(app.name.length + 1)],
            ),
        ),
      )
    )
      throw new Error('No reverse operation is registered for this migration');
    if (from.migrations.some((migration) => !migration.reversible) && !backup)
      throw new Error('Required pre-release backup missing');
    if (backup || from.migrations.length) {
      const target = to.runtime as RuntimePlan;
      const state = new DurableGraphRuntimeStore();
      const previous = (from.runtime as RuntimePlan).apps
        .filter((app) => !app.nodeId || app.nodeId === 'coordinator')
        .flatMap((app) =>
          state
            .listInstances(app.applicationId, 'coordinator')
            .filter((instance) => instance.status === 'ready'),
        );
      writeReleaseJournal(target.id, { phase: 'staging', previous, jobs: [], finished: [] });
      writeReleaseJournal(`rollback-${target.id}`, { state: 'changing-data' });
      for (const app of target.apps.filter(
        (entry) => entry.nodeId && entry.nodeId !== 'coordinator',
      ))
        await this.onComputer(to, app, 'quiesce');
      for (const instance of previous) await this.docker.stopContainer(instance.containerName);
    }
    try {
      if (backup) {
        try {
          const executor = new ApplicationGraphExecutor({ docker: this.docker });
          for (const app of (from.runtime as RuntimePlan).apps.filter(
            (entry) => !entry.nodeId || entry.nodeId === 'coordinator',
          ))
            await executor.stop({ applicationId: app.applicationId, siteId: 'coordinator' });
          for (const entry of backup.runtime as {
            name: string;
            deployment: NonNullable<ReturnType<typeof readDeploymentRecord>>;
            backup: { filename: string };
            nodeId?: string;
            backupId?: string;
            releaseId?: string;
          }[]) {
            if (entry.nodeId) {
              const app = (to.runtime as RuntimePlan).apps.find((app) => app.name === entry.name)!;
              await this.onComputer(to, app, 'quiesce');
              await this.onComputer(to, app, 'restore', {
                backupId: entry.backupId,
                backupReleaseId: entry.releaseId,
              });
              continue;
            }
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
          }
        } catch (error) {
          throw Object.assign(
            new Error(
              `Backup restore did not complete: ${error instanceof Error ? error.message : String(error)}`,
            ),
            { requiresRecovery: true },
          );
        }
      }
      for (const origin of origins) {
        for (const app of (origin.runtime as RuntimePlan).apps) {
          if (app.nodeId && app.nodeId !== 'coordinator') continue;
          const target = (to.runtime as RuntimePlan).apps.find((entry) => entry.name === app.name)!;
          const sourceContext = this.context(app),
            targetContext = this.context(target);
          for (const migration of origin.migrations.filter(
            (entry) => entry.reversible && entry.id.startsWith(`${app.name}:profile:`),
          )) {
            const component = migration.id.slice(`${app.name}:profile:`.length);
            await new ApplicationGraphExecutor({ docker: this.docker }).executeProfileOperation(
              sourceContext,
              { component, operation: 'rollback', targetContext },
            );
          }
        }
        for (const migration of origin.migrations.filter(
          (entry) => entry.reversible && !entry.id.includes(':profile:'),
        )) {
          const app = (origin.runtime as RuntimePlan).apps.find((entry) =>
            migration.id.startsWith(`${entry.name}:`),
          )!;
          const name = migration.id.slice(app.name.length + 1);
          if (app.nodeId && app.nodeId !== 'coordinator') {
            await this.onComputer(origin, app, 'reverse', {
              reverse: { [name]: app.reverse![name] },
            });
            continue;
          }
          const journal = readReleaseJournal<ActivationJournal>((origin.runtime as RuntimePlan).id);
          const job = journal?.jobs.find(
            (entry) =>
              entry.labels['deploy-sh.job'] === name &&
              entry.labels['deploy-sh.app-id'] === app.applicationId,
          );
          if (!job) throw new Error(`Migration receipt is unavailable for ${migration.id}`);
          const result = await this.docker.runOneShot({
            ...job,
            name: `${job.name}-reverse`,
            command: app.reverse![name],
          });
          if (result.exitCode !== 0)
            throw Object.assign(new Error(`Reverse migration ${migration.id} failed`), {
              requiresRecovery: true,
            });
        }
      }
      if (backup || from.migrations.length)
        writeReleaseJournal(`rollback-${(to.runtime as RuntimePlan).id}`, { state: 'data-ready' });
      await this.activate(to, {
        resumePrevious: !backup && from.migrations.length === 0,
        skipMigrations: true,
      });
    } catch (error) {
      if (backup || from.migrations.length)
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          requiresRecovery: true,
        });
      throw error;
    }
    // The target's jobs already ran in its original release; no new migration is inferred.
  }
  async dispose(plan: ReleasePlan) {
    const runtime = plan.runtime as RuntimePlan;
    if (!runtime.activated) {
      for (const app of runtime.apps.filter(
        (entry) => entry.nodeId && entry.nodeId !== 'coordinator',
      ))
        await this.onComputer(plan, app, 'abort');
    }
    this.staged.delete((plan.runtime as RuntimePlan).id);
    // Immutable source and image receipts are retained for subsequent rollback.
  }
}
