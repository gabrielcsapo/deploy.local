import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ComponentExecutionPlan, StableComponentService } from './application-execution.ts';
import { planApplicationJobs } from './application-jobs.ts';
import type { ActualComponentInstance } from './application-reconciler.ts';
import type { ResolvedApplicationGraphRuntime } from './application-runtime.ts';
import type { ApplicationSpec } from './application-spec.ts';
import {
  evaluateApplicationPlacement,
  type PlacementTargetEvidence,
} from './application-placement.ts';
import { resolvePlacementTarget } from './application-placement-target.ts';
import type { ProfileLifecycleOperation } from './component-profiles.ts';
import { getArtifact, putArtifactFile, verifyArtifact } from './content-store.ts';
import { deployDataPath } from './data-directory.ts';
import {
  DockerCliGraphAdapter,
  graphNetworkName,
  graphVolumeName,
  type GraphContainerCreateRequest,
  type GraphContainerMount,
  type GraphDockerAdapter,
  type GraphHealthProbe,
} from './graph-docker-adapter.ts';
import {
  DurableGraphRuntimeStore,
  type ComponentInstanceRow,
  type ComponentProfileVolumeBindingRow,
  type GraphRuntimeStateStore,
} from './graph-runtime-store.ts';

export interface GraphExecutorContext {
  deploymentName: string;
  applicationId: string;
  siteId: string;
  nodeId?: string;
  /** Authenticated live node facts; production resolves these again at materialization time. */
  placementTarget?: PlacementTargetEvidence;
  projectDirectory: string;
  runtime: ResolvedApplicationGraphRuntime;
  memoryLimit?: string;
  cpuLimit?: string;
  /** Host bind mounts selected by the operator for this site, outside deploy.yaml ownership. */
  runtimeVolumes?: readonly {
    component?: string;
    hostPath: string;
    containerPath: string;
    readOnly?: boolean;
  }[];
  noCache?: boolean;
  writerSiteId?: string | null;
  healthTimeoutMs?: number;
  drainTimeoutMs?: number;
  /** Operator recreate: materialize fresh siblings even when release/configuration are unchanged. */
  forceReplace?: boolean;
  /** Rolling restart scope: only these components receive fresh fixed-slot siblings. */
  forceReplaceComponents?: readonly string[];
  /** Surgical repair scope: replace these durable instance identities only. */
  forceReplaceInstanceIds?: readonly string[];
  /** Profile lifecycle restore may stage a verified provider without changing the manifest. */
  volumeOverrides?: Readonly<Record<string, string>>;
  /** Explicit admission token for a profile-owned version transition. */
  profileTransition?: { component: string; operationId: string };
  /** Runs after graph health/jobs and before endpoint activation. */
  admissionCommit?: () => void;
  /** Reverts a committed external admission if endpoint publication later fails. */
  admissionRollback?: () => void;
  /** Exact temporary-validation constraints; never enabled for the ordinary runtime. */
  validation?: { denyExternalNetwork?: boolean; enforceReadOnlyRoot?: boolean };
}

export interface GraphMaterializationResult {
  applicationId: string;
  releaseDigest: string;
  configurationDigest: string;
  network: string;
  primaryPort: number | null;
  primaryContainerId: string | null;
  primaryContainerName: string | null;
  instances: readonly ComponentInstanceRow[];
}

export interface GraphOfflineBuildProof {
  inputDigest: `sha256:${string}`;
  sourceArtifactDigest: `sha256:${string}`;
  specDigest: string;
  networkMode: 'none';
  components: readonly { component: string; image: string }[];
  verifiedAt: string;
}

export interface GraphPreparationResult {
  applicationId: string;
  releaseDigest: string;
  components: readonly { component: string; image: string }[];
}

export interface ProfileOperationRequest {
  component: string;
  operation: string;
  variables?: Readonly<Record<string, string>>;
  artifactDigest?: string;
  targetContext?: GraphExecutorContext;
  activationCommit?: () => void;
  activationRollback?: () => void;
}

export interface ProfileOperationResult {
  id: string;
  exitCode: number;
  output: string;
  artifactDigest?: string;
  verification?: string;
  sourceVolume?: string;
  activeVolume?: string;
  rollbackVolume?: string;
  materialization?: GraphMaterializationResult;
}

export interface GraphRecoveryArtifact {
  artifactReference: string;
  artifactDigest: `sha256:${string}`;
  verification: string;
}

export interface GraphRecoveryPointOptions {
  /** Keep the graph quiesced after a successful archive for a single-writer authority handoff. */
  resume?: boolean;
}

export interface ApplicationGraphExecutorOptions {
  docker?: GraphDockerAdapter;
  state?: GraphRuntimeStateStore;
  artifacts?: ProfileArtifactStore;
  profileOperationsDirectory?: string;
}

export interface ProfileArtifactStore {
  putFile(
    path: string,
    metadata: { type: string; mediaType: string; retentionClass: 'recovery' },
  ): Promise<{ digest: string; path: string; byteSize: number }>;
  get(digest: string): { localPath: string; mediaType: string; type: string } | null;
  verify(digest: string): Promise<boolean>;
}

function assertNodeLocalPlacement(context: GraphExecutorContext): void {
  const targetNodeId = context.nodeId || context.siteId;
  const target = context.placementTarget ?? resolvePlacementTarget(targetNodeId);
  const admission = evaluateApplicationPlacement({
    spec: context.runtime.spec,
    desiredInstances: Object.fromEntries(
      Object.entries(context.runtime.execution.components).map(([name, component]) => [
        name,
        component.desiredInstances,
      ]),
    ),
    target,
  });
  if (!admission.ready) {
    throw new Error(
      `Application placement admission is blocked on ${targetNodeId}: ${admission.findings
        .filter((finding) => finding.severity === 'error')
        .map((finding) => finding.message)
        .join('; ')}`,
    );
  }
}

/** Durable same-site graph materializer. Docker objects are siblings on one private app network. */
export class ApplicationGraphExecutor {
  readonly #docker: GraphDockerAdapter;
  readonly #state: GraphRuntimeStateStore;
  readonly #artifacts: ProfileArtifactStore;
  readonly #profileOperationsDirectory: string;

  constructor(options: ApplicationGraphExecutorOptions = {}) {
    this.#docker = options.docker ?? new DockerCliGraphAdapter();
    this.#state = options.state ?? new DurableGraphRuntimeStore();
    this.#artifacts = options.artifacts ?? {
      putFile: (path, metadata) => putArtifactFile(path, metadata),
      get: (digest) => {
        const record = getArtifact(digest) as
          | (Record<string, unknown> & { localPath: string })
          | null;
        return record
          ? {
              localPath: record.localPath,
              mediaType: String(record.media_type ?? 'application/octet-stream'),
              type: String(record.type ?? ''),
            }
          : null;
      },
      verify: verifyArtifact,
    };
    this.#profileOperationsDirectory =
      options.profileOperationsDirectory ?? deployDataPath('profile-operations');
  }

  /**
   * Re-run every source-backed component build with Docker networking disabled. The source archive
   * digest covers the exact checked-out tree (including lockfiles), while the immutable spec digest
   * covers every build context/dockerfile/target declaration. `forceBuild` prevents a pre-existing
   * output tag from being mistaken for proof that Docker can execute this build offline.
   */
  async proveOfflineBuild(
    context: GraphExecutorContext,
    sourceArtifactDigest: `sha256:${string}`,
  ): Promise<GraphOfflineBuildProof> {
    const buildComponents = context.runtime.execution.componentOrder.filter(
      (component) => context.runtime.execution.components[component].source.kind === 'build',
    );
    if (buildComponents.length === 0) {
      throw new Error('Offline build proof requires at least one source-backed component');
    }
    const components: Array<{ component: string; image: string }> = [];
    for (const component of buildComponents) {
      const source = context.runtime.execution.components[component].source;
      if (source.kind !== 'build') continue;
      const image = await this.#docker.prepareImage({
        applicationId: context.applicationId,
        component,
        releaseDigest: componentReleaseDigest(context.runtime.spec, component),
        source,
        projectDirectory: context.projectDirectory,
        forceBuild: true,
        networkMode: 'none',
      });
      components.push({ component, image });
    }
    return {
      inputDigest: offlineBuildProofInputDigest(context, sourceArtifactDigest),
      sourceArtifactDigest,
      specDigest: context.runtime.execution.specDigest,
      networkMode: 'none',
      components,
      verifiedAt: new Date().toISOString(),
    };
  }

  /**
   * Build or pull every immutable component image without creating runtime infrastructure.
   * Missing server-side configuration is intentionally permitted here: configuration gates
   * consumers, jobs, and routes, but it is not an input to a source/image build. All other graph
   * admission failures still fail closed before Docker is touched.
   */
  async prepare(context: GraphExecutorContext): Promise<GraphPreparationResult> {
    const blocking = context.runtime.execution.findings.filter(
      (finding) =>
        finding.severity === 'error' &&
        finding.code !== 'COMPONENT_CONFIGURATION_UNRESOLVED' &&
        finding.code !== 'COMPONENT_CONFIGURATION_FILE_UNRESOLVED',
    );
    if (blocking.length > 0) {
      throw new Error(
        `Application graph build admission is blocked: ${blocking.map((item) => item.message).join('; ')}`,
      );
    }
    assertNodeLocalPlacement(context);
    const components: Array<{ component: string; image: string }> = [];
    for (const componentName of context.runtime.execution.componentOrder) {
      const component = context.runtime.execution.components[componentName];
      const releaseDigest = componentReleaseDigest(context.runtime.spec, componentName);
      const image = await this.#docker.prepareImage({
        applicationId: context.applicationId,
        component: componentName,
        releaseDigest,
        source: component.source,
        projectDirectory: context.projectDirectory,
        noCache: context.noCache,
      });
      components.push({ component: componentName, image });
    }
    return {
      applicationId: context.applicationId,
      releaseDigest: context.runtime.execution.specDigest,
      components,
    };
  }

  async converge(context: GraphExecutorContext): Promise<GraphMaterializationResult> {
    if (!context.runtime.ready || context.runtime.execution.blocked) {
      const reasons = context.runtime.execution.findings
        .filter((item) => item.severity === 'error')
        .map((item) => item.message);
      throw new Error(`Application graph admission is blocked: ${reasons.join('; ')}`);
    }
    assertNodeLocalPlacement(context);
    if (
      context.validation?.denyExternalNetwork &&
      Object.values(context.runtime.execution.components).some(
        (component) => component.runtime.networkMode === 'host',
      )
    ) {
      throw new Error('Offline validation cannot isolate a host-network component');
    }
    const { execution } = context.runtime;
    const network = graphNetworkName(context.applicationId);
    if (
      Object.values(execution.components).some(
        (component) => component.runtime.networkMode === 'private',
      )
    ) {
      await this.#docker.ensureNetwork(
        network,
        {
          'deploy-sh.app-id': context.applicationId,
          'deploy-sh.deployment': context.deploymentName,
          'deploy-sh.private-network': 'true',
          ...(context.validation?.denyExternalNetwork
            ? { 'deploy-sh.validation-network': 'internal' }
            : {}),
        },
        { internal: context.validation?.denyExternalNetwork === true },
      );
    }

    const providerVolumes = await this.ensureVolumes(context);
    const profileValues = this.ensureProfileValues(context);
    const publishedServices = new Set(
      Object.values(execution.routes).map((route) => route.serviceId),
    );
    for (const service of Object.values(execution.services)) {
      this.#state.upsertService({
        id: service.id,
        appId: context.applicationId,
        deploymentName: context.deploymentName,
        componentKey: service.component,
        interfaceKey: service.interface,
        protocol: service.protocol,
        containerPort: service.containerPort,
        published: publishedServices.has(service.id),
        updatedAt: Date.now(),
      });
    }

    const images = new Map<string, string>();
    for (const componentName of execution.componentOrder) {
      const component = execution.components[componentName];
      const releaseDigest = componentReleaseDigest(context.runtime.spec, componentName);
      images.set(
        componentName,
        await this.#docker.prepareImage({
          applicationId: context.applicationId,
          component: componentName,
          releaseDigest,
          source: component.source,
          projectDirectory: context.projectDirectory,
          noCache: context.noCache,
        }),
      );
      this.#state.upsertPlacement({
        appId: context.applicationId,
        deploymentName: context.deploymentName,
        siteId: context.siteId,
        componentKey: componentName,
        desiredInstances: component.desiredInstances,
        defaultInstances: component.defaultInstances,
        minimumReady: component.minimumReady,
        rolloutStrategy: component.rollout.strategy,
        maxSurge: component.rollout.maxSurge,
        maxUnavailable: component.rollout.maxUnavailable,
        placementIntent: component.placement.intent,
        capacity: JSON.stringify(component.capacity),
        releaseDigest,
        configurationDigest: componentConfigurationDigest(context.runtime, componentName),
        generation: 1,
        state: 'preparing',
        profile: component.profile?.profile ?? null,
        updatedAt: new Date().toISOString(),
      });
    }

    const created: ComponentInstanceRow[] = [];
    const stoppedForExclusive: ComponentInstanceRow[] = [];
    const current: ComponentInstanceRow[] = [];
    let admissionCommitted = false;
    try {
      for (const componentName of execution.componentOrder) {
        const component = execution.components[componentName];
        const componentInstances = await this.convergeComponent({
          context,
          component,
          image: images.get(componentName)!,
          network,
          providerVolumes,
          profileValues,
          publishedServices,
          created,
          stoppedForExclusive,
        });
        current.push(...componentInstances);
      }

      await this.runPendingJobs({
        context,
        instances: current,
        images,
        network,
        providerVolumes,
        profileValues,
      });

      if (context.admissionCommit) {
        context.admissionCommit();
        admissionCommitted = true;
      }

      await this.publishEndpoints(context, current, publishedServices);
      await this.retireStaleInstances(context, current);
      for (const componentName of execution.componentOrder) {
        const component = execution.components[componentName];
        this.#state.upsertPlacement({
          appId: context.applicationId,
          deploymentName: context.deploymentName,
          siteId: context.siteId,
          componentKey: componentName,
          desiredInstances: component.desiredInstances,
          defaultInstances: component.defaultInstances,
          minimumReady: component.minimumReady,
          rolloutStrategy: component.rollout.strategy,
          maxSurge: component.rollout.maxSurge,
          maxUnavailable: component.rollout.maxUnavailable,
          placementIntent: component.placement.intent,
          capacity: JSON.stringify(component.capacity),
          releaseDigest: componentReleaseDigest(context.runtime.spec, componentName),
          configurationDigest: componentConfigurationDigest(context.runtime, componentName),
          generation: 1,
          state: 'ready',
          profile: component.profile?.profile ?? null,
          updatedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      let admissionRollbackError: unknown;
      if (admissionCommitted && context.admissionRollback) {
        try {
          context.admissionRollback();
        } catch (rollbackError) {
          admissionRollbackError = rollbackError;
        }
      }
      // New instances have not entered an active endpoint generation yet. Removing them preserves
      // the previous healthy pool; reused instances are deliberately not in this list.
      for (const instance of created) {
        await this.#docker.removeContainer(instance.containerName).catch(() => {});
        this.#state.patchInstance(instance.id, {
          status: 'failed',
          health: 'unhealthy',
          updatedAt: Date.now(),
        });
      }
      // Single-writer replacements must stop the old writer before the replacement can mount the
      // volume. If the candidate fails its health gate, restore the previous writer so the active
      // endpoint generation remains usable instead of turning rollback into an outage.
      for (const instance of stoppedForExclusive) {
        await this.#docker.startContainer(instance.containerName).catch(() => {});
        const healthy = await this.#docker
          .waitHealthy(
            instance.containerName,
            healthProbe(
              context.runtime.execution.components[instance.componentKey],
              profileValues.get(instance.componentKey),
            ),
            context.healthTimeoutMs ?? 30_000,
          )
          .catch(() => false);
        this.#state.patchInstance(instance.id, {
          status: healthy ? 'ready' : 'failed',
          health: healthy ? 'healthy' : 'unhealthy',
          updatedAt: Date.now(),
        });
      }
      if (admissionRollbackError) {
        throw new Error(
          `Graph admission failed (${error instanceof Error ? error.message : String(error)}) and external admission rollback failed (${admissionRollbackError instanceof Error ? admissionRollbackError.message : String(admissionRollbackError)})`,
          { cause: error },
        );
      }
      throw error;
    }

    const finalInstances = this.#state
      .listInstances(context.applicationId, context.siteId)
      .filter((item) => item.status === 'ready');
    const primaryService = Object.values(execution.services).find((service) =>
      publishedServices.has(service.id),
    );
    const primaryInstance = primaryService
      ? finalInstances.find((item) => item.componentKey === primaryService.component)
      : finalInstances[0];
    const primaryInspection = primaryInstance
      ? await this.#docker.inspectContainer(primaryInstance.containerName)
      : null;
    return {
      applicationId: context.applicationId,
      releaseDigest: execution.specDigest,
      configurationDigest: context.runtime.configurationDigest,
      network,
      primaryPort:
        primaryService && primaryInspection
          ? execution.components[primaryService.component].runtime.networkMode === 'host'
            ? primaryService.containerPort
            : (primaryInspection.hostPorts[primaryService.containerPort] ?? null)
          : null,
      primaryContainerId: primaryInstance?.containerId ?? null,
      primaryContainerName: primaryInstance?.containerName ?? null,
      instances: finalInstances,
    };
  }

  async stop(context: Pick<GraphExecutorContext, 'applicationId' | 'siteId'>): Promise<void> {
    const instances = this.#state
      .listInstances(context.applicationId, context.siteId)
      .filter((item) => item.status !== 'removed');
    for (const instance of instances) {
      await this.#docker.stopContainer(instance.containerName);
      this.#state.patchInstance(instance.id, {
        status: 'stopped',
        health: 'unknown',
        updatedAt: Date.now(),
      });
    }
  }

  async restartComponent(
    context: GraphExecutorContext,
    component: string,
  ): Promise<GraphMaterializationResult> {
    if (!context.runtime.execution.components[component]) {
      throw new Error(`Unknown application component ${JSON.stringify(component)}`);
    }
    return this.converge({ ...context, forceReplaceComponents: [component] });
  }

  async replaceInstance(
    context: GraphExecutorContext,
    instanceId: string,
  ): Promise<GraphMaterializationResult> {
    const instance = this.#state
      .listInstances(context.applicationId, context.siteId)
      .find((candidate) => candidate.id === instanceId && candidate.status !== 'removed');
    if (!instance)
      throw new Error(`Active component instance ${JSON.stringify(instanceId)} not found`);
    return this.converge({ ...context, forceReplaceInstanceIds: [instanceId] });
  }

  async remove(
    context: Pick<GraphExecutorContext, 'applicationId' | 'siteId'> & {
      managedVolumeResources?: readonly string[];
      removeInfrastructure?: boolean;
    },
  ): Promise<void> {
    const instances = this.#state.listInstances(context.applicationId, context.siteId);
    for (const instance of instances) {
      await this.#docker.removeContainer(instance.containerName);
      this.#state.patchInstance(instance.id, {
        status: 'removed',
        health: 'unknown',
        updatedAt: Date.now(),
      });
    }
    if (context.removeInfrastructure) {
      const bindings = this.#state.listProfileVolumeBindings(context.applicationId, context.siteId);
      for (const resource of context.managedVolumeResources ?? []) {
        const binding = bindings.find((candidate) => candidate.resourceKey === resource);
        const providers = new Set([
          graphVolumeName(context.applicationId, resource),
          binding?.activeProviderVolume,
          binding?.rollbackProviderVolume,
        ]);
        for (const provider of providers) {
          if (provider) await this.#docker.removeVolume(provider);
        }
        if (binding) {
          this.#state.restoreProfileVolumeBinding(
            {
              appId: binding.appId,
              siteId: binding.siteId,
              componentKey: binding.componentKey,
              resourceKey: binding.resourceKey,
            },
            undefined,
          );
        }
      }
    }
    // The private network is runtime infrastructure, not retained application data.
    await this.#docker.removeNetwork(graphNetworkName(context.applicationId));
  }

  async executeProfileOperation(
    context: GraphExecutorContext,
    request: ProfileOperationRequest,
  ): Promise<ProfileOperationResult> {
    const component = context.runtime.execution.components[request.component];
    if (!component?.profile) {
      throw new Error(`Component ${JSON.stringify(request.component)} has no lifecycle profile`);
    }
    const operation = component.profile.operations.find((item) => item.id === request.operation);
    if (!operation) {
      throw new Error(
        `Profile ${JSON.stringify(component.profile.profile)} does not support operation ${JSON.stringify(request.operation)}`,
      );
    }
    const instance = this.#state
      .listInstances(context.applicationId, context.siteId, request.component)
      .find((item) => item.status === 'ready');
    if (!instance) throw new Error(`Component ${JSON.stringify(request.component)} is not ready`);
    const id = randomUUID();
    const now = Date.now();
    this.#state.startProfileOperation({
      id,
      appId: context.applicationId,
      deploymentName: context.deploymentName,
      siteId: context.siteId,
      componentKey: request.component,
      instanceId: instance.id,
      profile: component.profile.profile,
      operation: request.operation,
      // Templates are evidence without leaking generated credentials into the operation log.
      command: JSON.stringify(operation.command),
      status: 'running',
      sourceSpecDigest: context.runtime.execution.specDigest,
      targetSpecDigest: request.targetContext?.runtime.execution.specDigest ?? null,
      evidence: JSON.stringify({ workflow: operation.workflow ?? 'command' }),
      startedAt: now,
      updatedAt: now,
    });
    try {
      let result: ProfileOperationResult;
      switch (operation.workflow ?? 'command') {
        case 'logical-backup':
          result = await this.executeLogicalBackup(id, context, request, instance, operation);
          break;
        case 'logical-restore':
          result = await this.executeLogicalRestore(id, context, request, operation);
          break;
        case 'logical-major-upgrade':
          result = await this.executeLogicalMajorUpgrade(id, context, request, instance, operation);
          break;
        case 'logical-rollback':
          result = await this.executeLogicalRollback(id, context, request);
          break;
        case 'command':
          result = await this.executeProfileCommand(id, context, request, instance, operation);
          break;
      }
      this.#state.finishProfileOperation(
        id,
        'succeeded',
        result.exitCode,
        result.output,
        result.verification ?? 'command-completed',
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#state.finishProfileOperation(id, 'failed', 1, message, 'profile-operation-failed');
      throw error;
    }
  }

  private async executeProfileCommand(
    id: string,
    context: GraphExecutorContext,
    request: ProfileOperationRequest,
    instance: ComponentInstanceRow,
    operation: ProfileLifecycleOperation,
  ): Promise<ProfileOperationResult> {
    const component = context.runtime.execution.components[request.component];
    const generated = this.ensureProfileValues(context).get(request.component) ?? {};
    const command = operation.command.map((argument) =>
      substitute(argument, {
        ...profileOperationVariables(component, generated),
        ...(request.variables ?? {}),
      }),
    );
    const result = await this.#docker.exec(instance.containerName, command);
    if (result.exitCode !== 0) {
      throw new Error(`Profile operation ${request.operation} failed: ${result.output}`);
    }
    return { id, ...result, verification: 'command-completed' };
  }

  private async executeLogicalBackup(
    id: string,
    context: GraphExecutorContext,
    request: ProfileOperationRequest,
    instance: ComponentInstanceRow,
    operation: ProfileLifecycleOperation,
  ): Promise<ProfileOperationResult> {
    const archive = await this.captureLogicalArchive(
      id,
      context,
      request.component,
      instance,
      operation,
      request.variables,
    );
    return {
      id,
      exitCode: 0,
      output: archive.output,
      artifactDigest: archive.digest,
      verification: archive.verification,
      sourceVolume: archive.sourceVolume,
    };
  }

  private async executeLogicalRestore(
    id: string,
    context: GraphExecutorContext,
    request: ProfileOperationRequest,
    operation: ProfileLifecycleOperation,
  ): Promise<ProfileOperationResult> {
    if (!request.artifactDigest) {
      throw new Error('Logical restore requires an immutable artifactDigest');
    }
    const target = request.targetContext ?? context;
    assertSameProfileOperationTarget(context, target, request.component);
    assertNoImplicitProfileMajorTransition(context, target, request.component);
    const artifact = await this.requireLogicalArtifact(
      id,
      context,
      request.component,
      request.artifactDigest,
      operation,
      false,
    );
    return this.restoreLogicalArchive({
      id,
      source: context,
      target,
      request,
      operation,
      artifact,
      captureOutput: '',
      captureEvidence: undefined,
    });
  }

  private async executeLogicalMajorUpgrade(
    id: string,
    context: GraphExecutorContext,
    request: ProfileOperationRequest,
    instance: ComponentInstanceRow,
    operation: ProfileLifecycleOperation,
  ): Promise<ProfileOperationResult> {
    const target = request.targetContext;
    if (!target) throw new Error('Major profile upgrade requires a target application revision');
    assertSameProfileOperationTarget(context, target, request.component);
    assertExplicitProfileMajorTransition(context, target, request.component);
    const backupOperation = context.runtime.execution.components[
      request.component
    ].profile?.operations.find((candidate) => candidate.workflow === 'logical-backup');
    if (!backupOperation) {
      throw new Error('Major profile upgrade requires a logical-backup operation');
    }
    const archive = await this.captureLogicalArchive(
      id,
      context,
      request.component,
      instance,
      backupOperation,
      request.variables,
    );
    const artifact = await this.requireLogicalArtifact(
      id,
      context,
      request.component,
      archive.digest,
      backupOperation,
      true,
    );
    return this.restoreLogicalArchive({
      id,
      source: context,
      target,
      request,
      operation,
      artifact,
      captureOutput: archive.output,
      captureEvidence: { format: archive.format, bytes: archive.bytes },
    });
  }

  private async executeLogicalRollback(
    id: string,
    context: GraphExecutorContext,
    request: ProfileOperationRequest,
  ): Promise<ProfileOperationResult> {
    const target = request.targetContext;
    if (!target) throw new Error('Profile rollback requires the preserved rollback revision');
    assertSameProfileOperationTarget(context, target, request.component);
    const managed = profileManagedDataResource(context, request.component);
    const targetManaged = profileManagedDataResource(target, request.component);
    if (managed.resource !== targetManaged.resource) {
      throw new Error('Profile rollback cannot change the managed data resource key');
    }
    const address = profileVolumeBindingAddress(context, request.component, managed.resource);
    const previous = this.#state.getProfileVolumeBinding(address);
    if (!previous?.rollbackProviderVolume || !previous.rollbackSpecDigest) {
      throw new Error('No preserved profile volume is available for rollback');
    }
    if (target.runtime.execution.specDigest !== previous.rollbackSpecDigest) {
      throw new Error('Rollback revision does not match the preserved profile volume evidence');
    }
    if (!(await this.#docker.volumeExists(previous.rollbackProviderVolume))) {
      throw new Error('Preserved profile rollback volume is missing from Docker');
    }
    const nextBinding = {
      ...address,
      activeProviderVolume: previous.rollbackProviderVolume,
      rollbackProviderVolume: previous.activeProviderVolume,
      activeOperationId: id,
      rollbackOperationId: previous.activeOperationId,
      activeSpecDigest: target.runtime.execution.specDigest,
      rollbackSpecDigest: context.runtime.execution.specDigest,
      artifactDigest: previous.artifactDigest,
      updatedAt: Date.now(),
    };
    const materialization = await this.convergeProfileTransition({
      id,
      source: context,
      target,
      request,
      resource: managed.resource,
      sourceVolume: previous.activeProviderVolume,
      targetVolume: previous.rollbackProviderVolume,
      previousBinding: previous,
      nextBinding,
    });
    const verification = 'rollback:profile-readiness-and-application-graph-health-verified';
    this.#state.patchProfileOperation(id, {
      sourceVolume: previous.activeProviderVolume,
      targetVolume: previous.rollbackProviderVolume,
      rollbackVolume: previous.activeProviderVolume,
      artifactDigest: previous.artifactDigest,
      evidence: JSON.stringify({
        workflow: 'logical-rollback',
        resource: managed.resource,
        graphHealth: 'verified',
        oldVolumePreserved: true,
      }),
      updatedAt: Date.now(),
    });
    return {
      id,
      exitCode: 0,
      output: 'Preserved profile volume reactivated after full graph health admission',
      artifactDigest: previous.artifactDigest ?? undefined,
      verification,
      sourceVolume: previous.activeProviderVolume,
      activeVolume: previous.rollbackProviderVolume,
      rollbackVolume: previous.activeProviderVolume,
      materialization,
    };
  }

  private async captureLogicalArchive(
    id: string,
    context: GraphExecutorContext,
    componentName: string,
    instance: ComponentInstanceRow,
    operation: ProfileLifecycleOperation,
    requestVariables: Readonly<Record<string, string>> = {},
  ): Promise<{
    digest: string;
    path: string;
    output: string;
    verification: string;
    sourceVolume: string;
    format: string;
    bytes: number;
  }> {
    if (!operation.artifact || operation.output !== 'logical-archive') {
      throw new Error('Logical backup profile operation has no archive contract');
    }
    const component = context.runtime.execution.components[componentName];
    const generated = this.ensureProfileValues(context).get(componentName) ?? {};
    const command = operation.command.map((argument) =>
      substitute(argument, {
        ...profileOperationVariables(component, generated),
        ...requestVariables,
        OUTPUT: operation.artifact!.containerPath,
      }),
    );
    const result = await this.#docker.exec(instance.containerName, command);
    if (result.exitCode !== 0) {
      throw new Error(`Logical backup command failed: ${result.output}`);
    }
    const stagingDirectory = resolve(this.#profileOperationsDirectory, safeIdentifier(id));
    const stagingPath = resolve(stagingDirectory, 'logical-archive.partial');
    mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });
    await this.#docker.copyFromContainer(
      instance.containerName,
      operation.artifact.containerPath,
      stagingPath,
    );
    const stored = await this.#artifacts.putFile(stagingPath, {
      type: profileArtifactType(context, componentName),
      mediaType: operation.artifact.mediaType,
      retentionClass: 'recovery',
    });
    try {
      unlinkSync(stagingPath);
    } catch {
      // The immutable content-addressed copy is authoritative.
    }
    if (!(await this.#artifacts.verify(stored.digest))) {
      throw new Error('Logical backup changed while entering immutable recovery storage');
    }
    const managed = profileManagedDataResource(context, componentName);
    const binding = this.#state.getProfileVolumeBinding(
      profileVolumeBindingAddress(context, componentName, managed.resource),
    );
    const sourceVolume =
      binding?.activeProviderVolume ?? graphVolumeName(context.applicationId, managed.resource);
    const verification = 'logical-archive:content-digest-verified';
    this.#state.patchProfileOperation(id, {
      artifactPath: stored.path,
      artifactDigest: stored.digest,
      artifactMediaType: operation.artifact.mediaType,
      sourceVolume,
      evidence: JSON.stringify({
        workflow: 'logical-backup',
        format: operation.artifact.format,
        bytes: stored.byteSize,
        digestVerified: true,
        sourceSpecDigest: context.runtime.execution.specDigest,
      }),
      updatedAt: Date.now(),
    });
    return {
      digest: stored.digest,
      path: stored.path,
      output: result.output,
      verification,
      sourceVolume,
      format: operation.artifact.format,
      bytes: stored.byteSize,
    };
  }

  private async requireLogicalArtifact(
    operationId: string,
    context: GraphExecutorContext,
    componentName: string,
    digest: string,
    operation: ProfileLifecycleOperation,
    allowCrossRevision: boolean,
  ): Promise<{ digest: string; path: string; mediaType: string }> {
    if (!operation.artifact) throw new Error('Logical restore profile has no archive contract');
    const record = this.#artifacts.get(digest);
    if (!record) throw new Error('Logical restore artifact is not present on this site');
    if (!(await this.#artifacts.verify(digest))) {
      throw new Error('Logical restore artifact failed its content digest verification');
    }
    if (record.type !== profileArtifactType(context, componentName)) {
      throw new Error('Logical restore artifact belongs to a different application component');
    }
    const provenance = this.#state.findProfileArtifactOperation({
      appId: context.applicationId,
      siteId: context.siteId,
      componentKey: componentName,
      artifactDigest: digest,
    });
    if (!provenance || (provenance.status !== 'succeeded' && provenance.id !== operationId)) {
      throw new Error('Logical restore artifact has no successful profile capture evidence');
    }
    if (
      !allowCrossRevision &&
      provenance.sourceSpecDigest !== context.runtime.execution.specDigest
    ) {
      throw new Error(
        'Logical restore artifact belongs to a different application revision; use the profile upgrade or rollback workflow',
      );
    }
    const mediaType = record.mediaType;
    if (mediaType !== operation.artifact.mediaType) {
      throw new Error(
        `Logical restore artifact media type ${JSON.stringify(mediaType)} does not match ${JSON.stringify(operation.artifact.mediaType)}`,
      );
    }
    return { digest, path: record.localPath, mediaType };
  }

  private async restoreLogicalArchive(input: {
    id: string;
    source: GraphExecutorContext;
    target: GraphExecutorContext;
    request: ProfileOperationRequest;
    operation: ProfileLifecycleOperation;
    artifact: { digest: string; path: string; mediaType: string };
    captureOutput: string;
    captureEvidence: { format: string; bytes: number } | undefined;
  }): Promise<ProfileOperationResult> {
    const { id, source, target, request, operation, artifact } = input;
    if (!operation.artifact) throw new Error('Logical restore profile has no archive contract');
    const sourceManaged = profileManagedDataResource(source, request.component);
    const targetManaged = profileManagedDataResource(target, request.component);
    if (sourceManaged.resource !== targetManaged.resource) {
      throw new Error('Logical restore cannot change the managed data resource key');
    }
    const resource = sourceManaged.resource;
    const address = profileVolumeBindingAddress(source, request.component, resource);
    const previousBinding = this.#state.getProfileVolumeBinding(address);
    const sourceVolume =
      previousBinding?.activeProviderVolume ?? graphVolumeName(source.applicationId, resource);
    const targetVolume = profileStagingVolumeName(source.applicationId, resource, id);
    const targetComponent = target.runtime.execution.components[request.component];
    const targetOperation =
      targetComponent.profile?.operations.find((candidate) => candidate.id === operation.id) ??
      operation;
    if (!targetOperation.artifact) {
      throw new Error('Target profile restore operation has no archive contract');
    }
    const network = graphNetworkName(target.applicationId);
    if (targetComponent.runtime.networkMode === 'private') {
      await this.#docker.ensureNetwork(network, {
        'deploy-sh.app-id': target.applicationId,
        'deploy-sh.deployment': target.deploymentName,
        'deploy-sh.private-network': 'true',
      });
    }
    await this.#docker.ensureVolume(targetVolume, {
      'deploy-sh.app-id': target.applicationId,
      'deploy-sh.resource': resource,
      'deploy-sh.profile-operation': id,
      'deploy-sh.staged': 'true',
    });
    const stagedContext: GraphExecutorContext = {
      ...target,
      volumeOverrides: { ...target.volumeOverrides, [resource]: targetVolume },
    };
    let providers: Map<string, string>;
    let profileValues: Map<string, Record<string, string>>;
    let image: string;
    try {
      providers = await this.ensureVolumes(stagedContext);
      profileValues = this.ensureProfileValues(target);
      image = await this.#docker.prepareImage({
        applicationId: target.applicationId,
        component: request.component,
        releaseDigest: componentReleaseDigest(target.runtime.spec, request.component),
        source: targetComponent.source,
        projectDirectory: target.projectDirectory,
        noCache: target.noCache,
      });
    } catch (error) {
      await this.#docker.removeVolume(targetVolume).catch(() => {});
      throw error;
    }
    const bootstrapName = profileBootstrapContainerName(
      target.deploymentName,
      request.component,
      id,
    );
    let bootstrapCreated = false;
    try {
      await this.#docker.createContainer({
        name: bootstrapName,
        image,
        network,
        networkMode: targetComponent.runtime.networkMode,
        networkAliases: [],
        environment: componentEnvironment(target, targetComponent, profileValues),
        command: targetComponent.command,
        mounts: [
          ...componentMounts(stagedContext, targetComponent, providers),
          ...componentConfigurationFileMounts(target, targetComponent),
        ],
        publishPorts: [],
        labels: {
          'deploy-sh.app-id': target.applicationId,
          'deploy-sh.component': request.component,
          'deploy-sh.profile-operation': id,
          'deploy-sh.staged-restore': 'true',
        },
        memoryLimit: target.memoryLimit,
        cpuLimit: target.cpuLimit,
        gpus: targetComponent.runtime.gpus,
        privileged: targetComponent.runtime.privileged,
        privilegedDocker: targetComponent.runtime.privilegedDocker,
        devices: targetComponent.runtime.devices,
        runArgs: runtimeRunArgs(target, targetComponent),
        restart: 'no',
      });
      bootstrapCreated = true;
      await this.#docker.startContainer(bootstrapName);
      if (
        !(await this.#docker.waitHealthy(
          bootstrapName,
          healthProbe(targetComponent, profileValues.get(request.component)),
          target.healthTimeoutMs ?? 30_000,
        ))
      ) {
        throw new Error('Fresh profile volume failed its pre-restore readiness gate');
      }
      await this.ensureComponentProvisioned(
        bootstrapName,
        targetComponent,
        profileValues.get(request.component),
      );
      await this.#docker.copyToContainer(
        bootstrapName,
        artifact.path,
        targetOperation.artifact.containerPath,
      );
      const variables = {
        ...profileOperationVariables(targetComponent, profileValues.get(request.component) ?? {}),
        ...(request.variables ?? {}),
        INPUT: targetOperation.artifact.containerPath,
      };
      const restore = await this.#docker.exec(
        bootstrapName,
        targetOperation.command.map((argument) => substitute(argument, variables)),
      );
      if (restore.exitCode !== 0) {
        throw new Error(`Logical restore command failed: ${restore.output}`);
      }
      // Re-grant runtime authority to objects created by the restore role, then prove readiness.
      await this.ensureComponentProvisioned(
        bootstrapName,
        targetComponent,
        profileValues.get(request.component),
      );
      if (
        !(await this.#docker.waitHealthy(
          bootstrapName,
          healthProbe(targetComponent, profileValues.get(request.component)),
          target.healthTimeoutMs ?? 30_000,
        ))
      ) {
        throw new Error('Restored profile volume failed its PostgreSQL readiness gate');
      }
    } catch (error) {
      if (bootstrapCreated) await this.#docker.removeContainer(bootstrapName).catch(() => {});
      await this.#docker.removeVolume(targetVolume).catch(() => {});
      throw error;
    }
    await this.#docker.removeContainer(bootstrapName);

    const nextBinding = {
      ...address,
      activeProviderVolume: targetVolume,
      rollbackProviderVolume: sourceVolume,
      activeOperationId: id,
      rollbackOperationId: previousBinding?.activeOperationId ?? null,
      activeSpecDigest: target.runtime.execution.specDigest,
      rollbackSpecDigest: source.runtime.execution.specDigest,
      artifactDigest: artifact.digest,
      updatedAt: Date.now(),
    };
    let materialization: GraphMaterializationResult;
    try {
      materialization = await this.convergeProfileTransition({
        id,
        source,
        target,
        request,
        resource,
        sourceVolume,
        targetVolume,
        previousBinding,
        nextBinding,
      });
    } catch (error) {
      await this.#docker.removeVolume(targetVolume).catch(() => {});
      throw error;
    }
    const verification =
      'logical-restore:artifact-digest-profile-readiness-and-application-graph-health-verified';
    this.#state.patchProfileOperation(id, {
      artifactPath: artifact.path,
      artifactDigest: artifact.digest,
      artifactMediaType: artifact.mediaType,
      sourceVolume,
      targetVolume,
      rollbackVolume: sourceVolume,
      evidence: JSON.stringify({
        workflow: operation.workflow,
        resource,
        artifactDigestVerified: true,
        profileReadiness: 'verified',
        graphHealth: 'verified',
        oldVolumePreserved: true,
        rollbackArtifactPreserved: true,
        ...(input.captureEvidence ? { logicalArchive: input.captureEvidence } : {}),
      }),
      updatedAt: Date.now(),
    });
    return {
      id,
      exitCode: 0,
      output: [
        input.captureOutput,
        'Logical restore and full application graph admission succeeded',
      ]
        .filter(Boolean)
        .join('\n'),
      artifactDigest: artifact.digest,
      verification,
      sourceVolume,
      activeVolume: targetVolume,
      rollbackVolume: sourceVolume,
      materialization,
    };
  }

  private async convergeProfileTransition(input: {
    id: string;
    source: GraphExecutorContext;
    target: GraphExecutorContext;
    request: ProfileOperationRequest;
    resource: string;
    sourceVolume: string;
    targetVolume: string;
    previousBinding: ComponentProfileVolumeBindingRow | undefined;
    nextBinding: Parameters<GraphRuntimeStateStore['commitProfileVolumeBinding']>[0];
  }): Promise<GraphMaterializationResult> {
    const address = profileVolumeBindingAddress(
      input.source,
      input.request.component,
      input.resource,
    );
    let committed = false;
    const externalCommit = () => {
      input.target.admissionCommit?.();
      input.request.activationCommit?.();
    };
    const externalRollback = () => {
      input.request.activationRollback?.();
      input.target.admissionRollback?.();
    };
    const admissionCommit = () => {
      this.#state.commitProfileVolumeBinding(input.nextBinding);
      try {
        externalCommit();
        committed = true;
      } catch (error) {
        this.#state.restoreProfileVolumeBinding(address, input.previousBinding);
        try {
          externalRollback();
        } catch {
          // Preserve the activation error; the durable provider binding is already restored.
        }
        throw error;
      }
    };
    const admissionRollback = () => {
      if (!committed) return;
      this.#state.restoreProfileVolumeBinding(address, input.previousBinding);
      externalRollback();
      committed = false;
    };
    return this.converge({
      ...input.target,
      volumeOverrides: {
        ...input.target.volumeOverrides,
        [input.resource]: input.targetVolume,
      },
      forceReplaceComponents: [
        ...new Set([...(input.target.forceReplaceComponents ?? []), input.request.component]),
      ],
      profileTransition: { component: input.request.component, operationId: input.id },
      admissionCommit,
      admissionRollback,
    });
  }

  /** Create a cold, per-volume archive and restart the exact graph before reporting success. */
  async createRecoveryPoint(
    context: GraphExecutorContext,
    destinationDirectory: string,
    options: GraphRecoveryPointOptions = {},
  ): Promise<GraphRecoveryArtifact> {
    const resources = managedRecoveryResources(context.runtime.spec);
    const root = resolve(destinationDirectory);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    await this.stop(context);
    let artifact: GraphRecoveryArtifact | undefined;
    let archiveFailure: unknown;
    try {
      const archives: RecoveryManifest['resources'] = [];
      for (const resource of resources) {
        const filename = `${createHash('sha256').update(resource).digest('hex').slice(0, 16)}.tar.gz`;
        const archivePath = resolve(root, filename);
        const result = await this.#docker.exportVolume(
          graphVolumeName(context.applicationId, resource),
          archivePath,
        );
        if (!(await this.#docker.verifyVolumeArchive(archivePath))) {
          throw new Error(
            `Recovery archive for resource ${JSON.stringify(resource)} is unreadable`,
          );
        }
        if ((await fileSha256(archivePath)) !== result.digest) {
          throw new Error(
            `Recovery archive digest changed for resource ${JSON.stringify(resource)}`,
          );
        }
        archives.push({
          resource,
          consistencyGroup: context.runtime.spec.resources[resource].consistencyGroup,
          archive: filename,
          digest: result.digest,
          bytes: result.bytes,
        });
      }
      const manifest: RecoveryManifest = {
        version: 1,
        applicationId: context.applicationId,
        siteId: context.siteId,
        specDigest: context.runtime.execution.specDigest,
        configurationDigest: context.runtime.configurationDigest,
        resources: archives,
      };
      const manifestPath = resolve(root, 'recovery-manifest.json');
      const content = `${JSON.stringify(manifest, null, 2)}\n`;
      writeFileSync(manifestPath, content, { encoding: 'utf8', mode: 0o600 });
      artifact = {
        artifactReference: manifestPath,
        artifactDigest: sha256(Buffer.from(content)),
        verification: `cold-volume-archive:${archives.length}:digest-and-tar-verified`,
      };
    } catch (error) {
      archiveFailure = error;
    }
    try {
      // A failed archive always resumes the old writer. A successful
      // single-writer handoff may deliberately leave it quiesced until the
      // destination has restored and passed its health gate.
      if (archiveFailure || options.resume !== false) await this.converge(context);
    } catch (restartError) {
      if (archiveFailure) {
        throw new Error(
          `Recovery archive failed (${(archiveFailure as Error).message}) and graph restart failed (${(restartError as Error).message})`,
          { cause: restartError },
        );
      }
      throw new Error(
        `Recovery archive completed but graph restart failed: ${(restartError as Error).message}`,
        { cause: restartError },
      );
    }
    if (archiveFailure) throw archiveFailure;
    return artifact!;
  }

  /** Verify every artifact before stopping the graph, then restore managed volumes cold. */
  async restoreRecoveryPoint(
    context: GraphExecutorContext,
    artifact: Pick<GraphRecoveryArtifact, 'artifactReference' | 'artifactDigest'>,
  ): Promise<void> {
    const manifestPath = resolve(artifact.artifactReference);
    const content = readFileSync(manifestPath);
    if (sha256(content) !== artifact.artifactDigest) {
      throw new Error('Recovery manifest digest does not match the verified recovery point');
    }
    const manifest = parseRecoveryManifest(JSON.parse(content.toString('utf8')));
    if (manifest.applicationId !== context.applicationId || manifest.siteId !== context.siteId) {
      throw new Error('Recovery artifact belongs to a different application or site');
    }
    if (manifest.specDigest !== context.runtime.execution.specDigest) {
      throw new Error('Recovery artifact does not match the rollback application revision');
    }
    if (manifest.configurationDigest !== context.runtime.configurationDigest) {
      throw new Error('Recovery artifact does not match the rollback configuration revision');
    }
    const expectedResources = managedRecoveryResources(context.runtime.spec);
    if (
      JSON.stringify(manifest.resources.map((item) => item.resource).sort()) !==
      JSON.stringify([...expectedResources].sort())
    ) {
      throw new Error('Recovery artifact resource set does not match the rollback graph');
    }
    const root = resolve(manifestPath, '..');
    const verified: Array<{ resource: string; path: string }> = [];
    for (const entry of manifest.resources) {
      const archivePath = containedRecoveryPath(root, entry.archive);
      if ((await fileSha256(archivePath)) !== entry.digest) {
        throw new Error(`Recovery archive digest mismatch for ${JSON.stringify(entry.resource)}`);
      }
      if (!(await this.#docker.verifyVolumeArchive(archivePath))) {
        throw new Error(`Recovery archive is unreadable for ${JSON.stringify(entry.resource)}`);
      }
      verified.push({ resource: entry.resource, path: archivePath });
    }
    await this.stop(context);
    for (const entry of verified) {
      const volume = graphVolumeName(context.applicationId, entry.resource);
      await this.#docker.ensureVolume(volume, {
        'deploy-sh.app-id': context.applicationId,
        'deploy-sh.resource': entry.resource,
        'deploy-sh.recovered': 'true',
      });
      await this.#docker.restoreVolume(volume, entry.path);
    }
  }

  private async ensureVolumes(context: GraphExecutorContext): Promise<Map<string, string>> {
    const providers = new Map<string, string>();
    for (const [resourceName, resource] of Object.entries(context.runtime.spec.resources)) {
      if (resource.source?.type === 'bind') {
        providers.set(resourceName, resource.source.hostPath);
      } else {
        const owner = profileManagedResourceOwner(context, resourceName);
        const binding = owner
          ? this.#state.getProfileVolumeBinding({
              appId: context.applicationId,
              siteId: context.siteId,
              componentKey: owner,
              resourceKey: resourceName,
            })
          : undefined;
        const volume =
          context.volumeOverrides?.[resourceName] ||
          binding?.activeProviderVolume ||
          graphVolumeName(context.applicationId, resourceName);
        await this.#docker.ensureVolume(volume, {
          'deploy-sh.app-id': context.applicationId,
          'deploy-sh.resource': resourceName,
          'deploy-sh.durability': resource.durability,
        });
        providers.set(resourceName, volume);
      }
    }
    return providers;
  }

  private ensureProfileValues(context: GraphExecutorContext): Map<string, Record<string, string>> {
    const values = new Map<string, Record<string, string>>();
    for (const [componentName, component] of Object.entries(context.runtime.execution.components)) {
      if (!component.profile) continue;
      const componentValues: Record<string, string> = {};
      for (const declaration of component.profile.provisionedValues) {
        componentValues[declaration.name] = this.#state.getOrCreateProfileValue({
          appId: context.applicationId,
          deploymentName: context.deploymentName,
          siteId: context.siteId,
          componentKey: componentName,
          key: declaration.name,
          secret: declaration.secret,
          create: () => generatedProfileValue(context.deploymentName, declaration.name),
        });
      }
      values.set(componentName, componentValues);
    }
    return values;
  }

  private async convergeComponent(input: {
    context: GraphExecutorContext;
    component: ComponentExecutionPlan;
    image: string;
    network: string;
    providerVolumes: ReadonlyMap<string, string>;
    profileValues: ReadonlyMap<string, Record<string, string>>;
    publishedServices: ReadonlySet<string>;
    created: ComponentInstanceRow[];
    stoppedForExclusive: ComponentInstanceRow[];
  }): Promise<ComponentInstanceRow[]> {
    const { context, component } = input;
    const releaseDigest = componentReleaseDigest(context.runtime.spec, component.name);
    const configurationDigest = componentConfigurationDigest(context.runtime, component.name);
    const existing = this.#state
      .listInstances(context.applicationId, context.siteId, component.name)
      .filter((item) => item.status !== 'removed');
    const selected: ComponentInstanceRow[] = [];
    const hasExclusiveWriter = writableSingleWriter(component, context.runtime.spec);
    const replaceComponent = context.forceReplaceComponents?.includes(component.name) === true;
    const replaceIds = new Set(context.forceReplaceInstanceIds ?? []);
    const stale = existing.filter(
      (item) =>
        context.forceReplace ||
        replaceComponent ||
        replaceIds.has(item.id) ||
        item.releaseDigest !== releaseDigest ||
        item.configurationDigest !== configurationDigest ||
        !component.slots.includes(item.slotKey),
    );
    if ((hasExclusiveWriter || component.rollout.strategy !== 'rolling') && stale.length > 0) {
      if (hasExclusiveWriter) assertProfileVersionTransitionCompatible(context, component, stale);
      for (const instance of stale) {
        await this.#docker.stopContainer(instance.containerName);
        this.#state.patchInstance(instance.id, {
          status: 'stopped',
          health: 'unknown',
          updatedAt: Date.now(),
        });
        input.stoppedForExclusive.push(instance);
      }
    }

    for (const slot of component.slots) {
      const candidates = existing.filter(
        (item) =>
          !context.forceReplace &&
          !replaceComponent &&
          !replaceIds.has(item.id) &&
          item.slotKey === slot &&
          item.releaseDigest === releaseDigest &&
          item.configurationDigest === configurationDigest,
      );
      let ready: ComponentInstanceRow | undefined;
      for (const candidate of candidates) {
        const inspection = await this.#docker.inspectContainer(candidate.containerName);
        if (!inspection.exists) {
          this.#state.patchInstance(candidate.id, { status: 'removed', updatedAt: Date.now() });
          continue;
        }
        if (!inspection.running) await this.#docker.startContainer(candidate.containerName);
        if (
          await this.#docker.waitHealthy(
            candidate.containerName,
            healthProbe(component, input.profileValues.get(component.name)),
            context.healthTimeoutMs ?? 30_000,
          )
        ) {
          await this.ensureComponentProvisioned(
            candidate.containerName,
            component,
            input.profileValues.get(component.name),
          );
          this.#state.patchInstance(candidate.id, {
            status: 'ready',
            health: 'healthy',
            containerId: inspection.id || candidate.containerId,
            readyAt: Date.now(),
            updatedAt: Date.now(),
          });
          ready = { ...candidate, status: 'ready', health: 'healthy' };
          break;
        }
      }
      if (!ready) {
        ready = await this.createInstance(input, slot, releaseDigest, stale[0]?.id);
        input.created.push(ready);
      }
      selected.push(ready);
    }
    return selected;
  }

  private async createInstance(
    input: {
      context: GraphExecutorContext;
      component: ComponentExecutionPlan;
      image: string;
      network: string;
      providerVolumes: ReadonlyMap<string, string>;
      profileValues: ReadonlyMap<string, Record<string, string>>;
      publishedServices: ReadonlySet<string>;
    },
    slot: string,
    releaseDigest: string,
    replacementFor?: string,
  ): Promise<ComponentInstanceRow> {
    const { context, component } = input;
    const id = randomUUID();
    const name = containerName(context.deploymentName, component.name, slot, releaseDigest, id);
    const environment = componentEnvironment(context, component, input.profileValues);
    const mounts = [
      ...componentMounts(context, component, input.providerVolumes),
      ...componentConfigurationFileMounts(context, component),
    ];
    const publishPorts = componentPublishedPorts(
      component,
      context.runtime.execution.services,
      input.publishedServices,
    );
    const request: GraphContainerCreateRequest = {
      name,
      image: input.image,
      network: input.network,
      networkMode: component.runtime.networkMode,
      networkAliases:
        component.runtime.networkMode === 'host'
          ? []
          : [component.name, serviceHostname(context.applicationId, component.name)],
      environment,
      command: component.command,
      mounts,
      publishPorts,
      labels: {
        'deploy-sh.app': context.deploymentName,
        'deploy-sh.app-id': context.applicationId,
        'deploy-sh.component': component.name,
        'deploy-sh.instance': id,
        'deploy-sh.slot': slot,
        'deploy-sh.release': releaseDigest,
      },
      memoryLimit: component.capacity.memoryBytes
        ? `${component.capacity.memoryBytes}b`
        : context.memoryLimit,
      cpuLimit: component.capacity.cpuMillicores
        ? String(component.capacity.cpuMillicores / 1000)
        : context.cpuLimit,
      gpus: component.runtime.gpus,
      privileged: component.runtime.privileged,
      privilegedDocker: component.runtime.privilegedDocker,
      devices: component.runtime.devices,
      runArgs: runtimeRunArgs(context, component),
    };
    const createdAt = Date.now();
    const created = await this.#docker.createContainer(request);
    const row: ComponentInstanceRow = {
      id,
      appId: context.applicationId,
      deploymentName: context.deploymentName,
      siteId: context.siteId,
      componentKey: component.name,
      slotKey: slot,
      nodeId: context.nodeId ?? null,
      releaseDigest,
      configurationDigest: componentConfigurationDigest(context.runtime, component.name),
      image: input.image,
      containerId: created.id,
      containerName: created.name,
      status: 'starting',
      health: 'starting',
      replacementFor: replacementFor ?? null,
      drainDeadline: null,
      readyAt: null,
      createdAt,
      updatedAt: createdAt,
    };
    this.#state.putInstance(row);
    this.#state.replaceVolumeAttachments(
      id,
      mounts
        .filter((mount) => Object.hasOwn(component.mounts, mount.target))
        .map((mount) => ({
          id: `${id}:${createHash('sha256').update(mount.target).digest('hex').slice(0, 16)}`,
          appId: context.applicationId,
          deploymentName: context.deploymentName,
          siteId: context.siteId,
          resourceKey: component.mounts[mount.target].resource,
          componentKey: component.name,
          instanceId: id,
          providerVolume: mount.source,
          mountPath: mount.target,
          readOnly: mount.readOnly,
          state: 'attached',
          createdAt,
          updatedAt: createdAt,
        })),
    );
    await this.#docker.startContainer(name);
    const healthy = await this.#docker.waitHealthy(
      name,
      healthProbe(component, input.profileValues.get(component.name)),
      context.healthTimeoutMs ?? 30_000,
    );
    if (!healthy) {
      this.#state.patchInstance(id, {
        status: 'failed',
        health: 'unhealthy',
        updatedAt: Date.now(),
      });
      throw new Error(
        `Component ${JSON.stringify(component.name)} instance ${JSON.stringify(slot)} failed its health gate`,
      );
    }
    await this.ensureComponentProvisioned(name, component, input.profileValues.get(component.name));
    const readyAt = Date.now();
    this.#state.patchInstance(id, {
      status: 'ready',
      health: 'healthy',
      readyAt,
      updatedAt: readyAt,
    });
    return { ...row, status: 'ready', health: 'healthy', readyAt, updatedAt: readyAt };
  }

  private async ensureComponentProvisioned(
    container: string,
    component: ComponentExecutionPlan,
    profileValues: Readonly<Record<string, string>> = {},
  ): Promise<void> {
    if (!component.profile?.provisioning) return;
    const variables = profileOperationVariables(component, profileValues);
    const command = component.profile.provisioning.command.map((argument) =>
      substitute(argument, variables),
    );
    const provisioned = await this.#docker.exec(container, command);
    if (provisioned.exitCode !== 0) {
      throw new Error(
        `Profile ${JSON.stringify(component.profile.profile)} scoped-role provisioning failed: ${provisioned.output}`,
      );
    }
    const verification = await this.#docker.exec(
      container,
      component.profile.provisioning.verificationCommand.map((argument) =>
        substitute(argument, variables),
      ),
    );
    if (verification.exitCode !== 0) {
      throw new Error(
        `Profile ${JSON.stringify(component.profile.profile)} scoped-role verification failed: ${verification.output}`,
      );
    }
  }

  private async runPendingJobs(input: {
    context: GraphExecutorContext;
    instances: readonly ComponentInstanceRow[];
    images: ReadonlyMap<string, string>;
    network: string;
    providerVolumes: ReadonlyMap<string, string>;
    profileValues: ReadonlyMap<string, Record<string, string>>;
  }): Promise<void> {
    const actual: ActualComponentInstance[] = input.instances.map((instance) => ({
      id: instance.id,
      component: instance.componentKey,
      slot: instance.slotKey,
      releaseDigest: input.context.runtime.execution.specDigest,
      configurationDigest: instance.configurationDigest,
      status: 'ready',
      endpoints: [],
    }));
    const records = this.#state
      .getJobRecords(input.context.applicationId, input.context.siteId)
      .map((record) => ({
        key: record.idempotencyKey,
        status: record.status as 'pending' | 'running' | 'succeeded' | 'failed',
        attempts: record.attempts,
      }));
    const jobs = planApplicationJobs(
      input.context.runtime.execution,
      input.context.runtime.spec,
      actual,
      {
        siteId: input.context.siteId,
        writerSiteId: input.context.writerSiteId ?? null,
        configurationDigest: input.context.runtime.configurationDigest,
        records,
        retryFailed: true,
      },
    );
    if (jobs.blocked) throw new Error(jobs.findings.map((item) => item.message).join('; '));
    for (const job of jobs.executions) {
      const component = input.context.runtime.execution.components[job.component];
      const now = Date.now();
      this.#state.startJob({
        idempotencyKey: job.key,
        appId: input.context.applicationId,
        deploymentName: input.context.deploymentName,
        siteId: input.context.siteId,
        releaseDigest: input.context.runtime.execution.specDigest,
        configurationDigest: input.context.runtime.configurationDigest,
        jobKey: job.job,
        componentKey: job.component,
        scope: job.scope,
        instanceId: job.instanceId ?? null,
        status: 'running',
        attempts: job.attempt,
        leaseOwner: `executor:${process.pid}`,
        leaseExpiresAt: now + 15 * 60_000,
        startedAt: now,
        updatedAt: now,
      });
      const environment = {
        ...componentEnvironment(input.context, component, input.profileValues, 'migration'),
        ...resolveReferences(input.context, job.environment, input.profileValues, 'migration'),
      };
      const result = await this.#docker.runOneShot({
        name: jobContainerName(input.context.deploymentName, job.job, job.key),
        image: input.images.get(job.component)!,
        network: input.network,
        networkMode: component.runtime.networkMode,
        networkAliases: [],
        environment,
        command: job.command,
        mounts: componentMounts(input.context, component, input.providerVolumes),
        publishPorts: [],
        labels: {
          'deploy-sh.app-id': input.context.applicationId,
          'deploy-sh.job': job.job,
          'deploy-sh.job-key': job.key,
        },
        memoryLimit: component.capacity.memoryBytes
          ? `${component.capacity.memoryBytes}b`
          : input.context.memoryLimit,
        cpuLimit: component.capacity.cpuMillicores
          ? String(component.capacity.cpuMillicores / 1000)
          : input.context.cpuLimit,
        gpus: component.runtime.gpus,
        privileged: component.runtime.privileged,
        privilegedDocker: component.runtime.privilegedDocker,
        devices: component.runtime.devices,
        runArgs: runtimeRunArgs(input.context, component),
        restart: 'no',
      });
      this.#state.finishJob(
        job.key,
        result.exitCode === 0 ? 'succeeded' : 'failed',
        result.exitCode,
        result.output,
      );
      if (result.exitCode !== 0) {
        throw new Error(`Lifecycle job ${JSON.stringify(job.job)} failed: ${result.output}`);
      }
    }
  }

  private async publishEndpoints(
    context: GraphExecutorContext,
    instances: readonly ComponentInstanceRow[],
    publishedServices: ReadonlySet<string>,
  ): Promise<void> {
    const deadline = Date.now() + (context.drainTimeoutMs ?? 30_000);
    for (const service of Object.values(context.runtime.execution.services)) {
      const componentInstances = instances.filter(
        (instance) => instance.componentKey === service.component,
      );
      const endpoints = [];
      for (const instance of componentInstances) {
        const inspection = await this.#docker.inspectContainer(instance.containerName);
        const hostNetwork =
          context.runtime.execution.components[service.component].runtime.networkMode === 'host';
        const publishedPort = hostNetwork
          ? service.containerPort
          : inspection.hostPorts[service.containerPort];
        if (publishedServices.has(service.id) && !publishedPort) {
          throw new Error(
            `Ready instance ${JSON.stringify(instance.containerName)} has no published port for ${service.id}`,
          );
        }
        endpoints.push({
          id: `${service.id}/${instance.id}`,
          instanceId: instance.id,
          siteId: context.siteId,
          host: publishedPort
            ? '127.0.0.1'
            : serviceHostname(context.applicationId, service.component),
          port: publishedPort ?? service.containerPort,
          releaseDigest: instance.releaseDigest,
          configurationDigest: instance.configurationDigest,
        });
      }
      this.#state.replaceReadyEndpoints(context.deploymentName, service.id, endpoints, deadline);
    }
  }

  private async retireStaleInstances(
    context: GraphExecutorContext,
    selected: readonly ComponentInstanceRow[],
  ): Promise<void> {
    const selectedIds = new Set(selected.map((item) => item.id));
    const stale = this.#state
      .listInstances(context.applicationId, context.siteId)
      .filter((item) => item.status !== 'removed' && !selectedIds.has(item.id));
    if (stale.length === 0) return;
    const deadline = Date.now() + (context.drainTimeoutMs ?? 30_000);
    for (const instance of stale) {
      this.#state.patchInstance(instance.id, {
        status: 'draining',
        health: 'unknown',
        drainDeadline: deadline,
        updatedAt: Date.now(),
      });
    }
    const waitMs = Math.max(0, deadline - Date.now());
    if (waitMs > 0) await delay(waitMs);
    for (const instance of stale) {
      await this.#docker.stopContainer(instance.containerName);
      await this.#docker.removeContainer(instance.containerName);
      this.#state.patchInstance(instance.id, {
        status: 'removed',
        health: 'unknown',
        updatedAt: Date.now(),
      });
    }
  }
}

export function offlineBuildProofInputDigest(
  context: GraphExecutorContext,
  sourceArtifactDigest: `sha256:${string}`,
): `sha256:${string}` {
  if (!/^sha256:[a-f0-9]{64}$/.test(sourceArtifactDigest)) {
    throw new Error('Offline build proof requires an immutable source artifact digest');
  }
  const builds = context.runtime.execution.componentOrder.flatMap((component) => {
    const source = context.runtime.execution.components[component].source;
    return source.kind === 'build' ? [{ component, source }] : [];
  });
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        applicationId: context.applicationId,
        specDigest: context.runtime.execution.specDigest,
        sourceArtifactDigest,
        builds,
      }),
    )
    .digest('hex')}`;
}

function componentReleaseDigest(spec: ApplicationSpec, component: string): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(spec.components[component])).digest('hex')}`;
}

function runtimeRunArgs(
  context: GraphExecutorContext,
  component: ComponentExecutionPlan,
): readonly string[] {
  return context.validation?.enforceReadOnlyRoot
    ? [
        ...component.runtime.runArgs,
        '--read-only',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=64m',
        '--tmpfs',
        '/run:rw,noexec,nosuid,size=16m',
      ]
    : component.runtime.runArgs;
}

function componentPublishedPorts(
  component: ComponentExecutionPlan,
  services: Readonly<Record<string, StableComponentService>>,
  publishedServices: ReadonlySet<string>,
): number[] {
  if (component.runtime.networkMode === 'host') return [];
  const ports = Object.values(services)
    .filter((service) => service.component === component.name && publishedServices.has(service.id))
    .map((service) => service.containerPort);
  if (component.health) {
    ports.push(component.interfaces[component.health.interface].port);
  } else if (!component.profile) {
    const first = Object.values(component.interfaces)[0];
    if (first) ports.push(first.port);
  }
  return [...new Set(ports)];
}

function healthProbe(
  component: ComponentExecutionPlan,
  profileValues: Readonly<Record<string, string>> = {},
): GraphHealthProbe {
  if (component.profile?.health) {
    return {
      kind: 'command',
      command: component.profile.health.command.map((argument) =>
        substitute(argument, profileOperationVariables(component, profileValues)),
      ),
    };
  }
  if (component.health) {
    const endpoint = component.interfaces[component.health.interface];
    if (endpoint.protocol === 'http' || endpoint.protocol === 'https') {
      return {
        kind: 'http',
        containerPort: endpoint.port,
        path: component.health.path ?? '/',
        hostNetwork: component.runtime.networkMode === 'host',
      };
    }
    return {
      kind: 'tcp',
      containerPort: endpoint.port,
      hostNetwork: component.runtime.networkMode === 'host',
    };
  }
  const first = Object.values(component.interfaces)[0];
  return first
    ? {
        kind: 'tcp',
        containerPort: first.port,
        hostNetwork: component.runtime.networkMode === 'host',
      }
    : { kind: 'running' };
}

function componentMounts(
  context: GraphExecutorContext,
  component: ComponentExecutionPlan,
  providers: ReadonlyMap<string, string>,
): GraphContainerMount[] {
  const declared: GraphContainerMount[] = Object.entries(component.mounts).map(
    ([target, mount]) => {
      const resource = context.runtime.spec.resources[mount.resource];
      const source = providers.get(mount.resource);
      if (!resource || !source)
        throw new Error(`Volume provider for ${mount.resource} is unavailable`);
      return {
        source,
        target,
        type: resource.source?.type === 'bind' ? 'bind' : 'volume',
        readOnly: mount.readOnly,
      };
    },
  );
  const componentNames = Object.keys(context.runtime.execution.components);
  const runtime = (context.runtimeVolumes || [])
    .filter((mount) => {
      const selected = mount.component || (componentNames.length === 1 ? componentNames[0] : '');
      if (!selected) {
        throw new Error(
          `Runtime mount ${JSON.stringify(mount.containerPath)} must select a component`,
        );
      }
      return selected === component.name;
    })
    .map((mount) => ({
      source: mount.hostPath,
      target: mount.containerPath,
      type: 'bind' as const,
      readOnly: mount.readOnly ?? false,
    }));
  const declaredTargets = new Set(declared.map((mount) => mount.target));
  const collision = runtime.find((mount) => declaredTargets.has(mount.target));
  if (collision) {
    throw new Error(
      `Runtime mount target ${JSON.stringify(collision.target)} is already owned by deploy.yaml`,
    );
  }
  return [...declared, ...runtime];
}

function componentConfigurationFileMounts(
  context: GraphExecutorContext,
  component: ComponentExecutionPlan,
): GraphContainerMount[] {
  const digest = componentConfigurationDigest(context.runtime, component.name);
  return Object.entries(component.configurationFiles).map(([target, reference]) => {
    const key = reference.from.slice('configuration.'.length);
    const value = context.runtime.configurationValues[key];
    if (value === undefined || value === null) {
      throw new Error(`Configuration file ${JSON.stringify(key)} is unresolved`);
    }
    const content = typeof value === 'string' ? value : JSON.stringify(value);
    const filename = `${createHash('sha256').update(`${target}\0${digest}`).digest('hex')}.value`;
    const directory = deployDataPath(
      'runtime-configuration',
      safeIdentifier(context.applicationId),
      safeIdentifier(context.siteId),
      safeIdentifier(component.name),
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const source = resolve(directory, filename);
    writeFileSync(source, content, { encoding: 'utf8', mode: 0o600 });
    return { source, target, type: 'bind', readOnly: true };
  });
}

function profileManagedResourceOwner(
  context: GraphExecutorContext,
  resourceName: string,
): string | undefined {
  return Object.values(context.runtime.execution.components).find((component) => {
    if (!component.profile?.managedData) return false;
    const mount = component.mounts[component.profile.managedData.mountPath];
    return mount?.resource === resourceName;
  })?.name;
}

function profileManagedDataResource(
  context: GraphExecutorContext,
  componentName: string,
): { resource: string; mountPath: string } {
  const component = context.runtime.execution.components[componentName];
  const managed = component?.profile?.managedData;
  if (!component?.profile || !managed) {
    throw new Error(
      `Component ${JSON.stringify(componentName)} has no profile-owned managed data boundary`,
    );
  }
  const mount = component.mounts[managed.mountPath];
  if (!mount) {
    throw new Error(
      `Profile ${JSON.stringify(component.profile.profile)} managed data mount ${JSON.stringify(managed.mountPath)} is missing`,
    );
  }
  const resource = context.runtime.spec.resources[mount.resource];
  if (!resource || resource.dataRole !== managed.resourceRole) {
    throw new Error(
      `Profile managed data resource ${JSON.stringify(mount.resource)} does not satisfy role ${JSON.stringify(managed.resourceRole)}`,
    );
  }
  if (resource.source?.type === 'bind') {
    throw new Error('Profile logical restore requires a managed volume, not a host bind mount');
  }
  if (mount.readOnly) throw new Error('Profile managed data mount cannot be read-only');
  return { resource: mount.resource, mountPath: managed.mountPath };
}

function profileVolumeBindingAddress(
  context: GraphExecutorContext,
  componentKey: string,
  resourceKey: string,
): { appId: string; siteId: string; componentKey: string; resourceKey: string } {
  return {
    appId: context.applicationId,
    siteId: context.siteId,
    componentKey,
    resourceKey,
  };
}

function profileStagingVolumeName(applicationId: string, resource: string, id: string): string {
  return boundedDockerName(
    `deploy-sh-${applicationId}-${resource}-profile-${id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}`,
  );
}

function profileArtifactType(context: GraphExecutorContext, componentName: string): string {
  return `profile-logical-archive/${safeIdentifier(context.applicationId)}/${safeIdentifier(context.siteId)}/${safeIdentifier(componentName)}`;
}

function profileBootstrapContainerName(
  deploymentName: string,
  componentName: string,
  id: string,
): string {
  return boundedDockerName(
    `deploy-sh-${deploymentName}-${componentName}-restore-${id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}`,
  );
}

function assertSameProfileOperationTarget(
  source: GraphExecutorContext,
  target: GraphExecutorContext,
  componentName: string,
): void {
  if (source.applicationId !== target.applicationId || source.siteId !== target.siteId) {
    throw new Error('Profile transitions must target the same application and site');
  }
  if (!target.runtime.ready || target.runtime.execution.blocked) {
    const reasons = target.runtime.execution.findings
      .filter((finding) => finding.severity === 'error')
      .map((finding) => finding.message)
      .join('; ');
    throw new Error(`Profile transition target is blocked: ${reasons}`);
  }
  const sourceProfile = source.runtime.execution.components[componentName]?.profile;
  const targetProfile = target.runtime.execution.components[componentName]?.profile;
  if (!sourceProfile || !targetProfile || sourceProfile.profile !== targetProfile.profile) {
    throw new Error('Profile transition target does not preserve the component lifecycle profile');
  }
}

function assertNoImplicitProfileMajorTransition(
  source: GraphExecutorContext,
  target: GraphExecutorContext,
  componentName: string,
): void {
  const sourceIdentity =
    source.runtime.execution.components[componentName]?.profile?.versionIdentity?.value;
  const targetIdentity =
    target.runtime.execution.components[componentName]?.profile?.versionIdentity?.value;
  if (sourceIdentity && targetIdentity && sourceIdentity !== targetIdentity) {
    throw new Error('A profile major-version change requires the explicit major-upgrade operation');
  }
}

function assertExplicitProfileMajorTransition(
  source: GraphExecutorContext,
  target: GraphExecutorContext,
  componentName: string,
): void {
  const sourceIdentity =
    source.runtime.execution.components[componentName]?.profile?.versionIdentity?.value;
  const targetIdentity =
    target.runtime.execution.components[componentName]?.profile?.versionIdentity?.value;
  if (!sourceIdentity || !targetIdentity) {
    throw new Error('Major profile upgrade requires immutable source and target version evidence');
  }
  if (sourceIdentity === targetIdentity) {
    throw new Error('Major profile upgrade requires a different target major version');
  }
}

function componentEnvironment(
  context: GraphExecutorContext,
  component: ComponentExecutionPlan,
  profileValues: ReadonlyMap<string, Record<string, string>>,
  scope: 'runtime' | 'migration' | 'backup-restore' = 'runtime',
): Record<string, string> {
  const environment = {
    ...(context.runtime.componentEnvironment[component.name] ?? {}),
  };
  for (const binding of component.environment) {
    if (binding.kind === 'service' && binding.requiredService) {
      environment[binding.variable] = bindingValue(
        context,
        binding.requiredService,
        profileValues,
        scope,
      );
    }
  }
  if (component.profile) {
    const values = profileValues.get(component.name) ?? {};
    for (const declaration of component.profile.provisionedValues) {
      environment[declaration.environment] = values[declaration.name];
    }
  }
  if (!Object.hasOwn(environment, 'PORT')) {
    const httpInterface = Object.values(component.interfaces).find(
      (item) => item.protocol === 'http' || item.protocol === 'https',
    );
    if (httpInterface) environment.PORT = String(httpInterface.port);
  }
  return environment;
}

function resolveReferences(
  context: GraphExecutorContext,
  references: Readonly<Record<string, { from: string }>>,
  profileValues: ReadonlyMap<string, Record<string, string>>,
  scope: 'runtime' | 'migration' | 'backup-restore' = 'runtime',
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [variable, reference] of Object.entries(references)) {
    if (reference.from.startsWith('configuration.')) {
      const key = reference.from.slice('configuration.'.length);
      const value = context.runtime.configurationValues[key];
      if (value !== undefined && value !== null) environment[variable] = String(value);
    } else {
      const [component, interfaceName] = reference.from.split('.');
      const service = context.runtime.execution.services[`${component}.${interfaceName}`];
      if (service) environment[variable] = bindingValue(context, service.id, profileValues, scope);
    }
  }
  return environment;
}

function bindingValue(
  context: GraphExecutorContext,
  serviceId: string,
  profileValues: ReadonlyMap<string, Record<string, string>>,
  scope: 'runtime' | 'migration' | 'backup-restore' = 'runtime',
): string {
  const service = Object.values(context.runtime.execution.services).find(
    (candidate) => candidate.id === serviceId,
  );
  if (!service) throw new Error(`Unknown service binding ${JSON.stringify(serviceId)}`);
  const host = serviceHostname(context.applicationId, service.component);
  const target = context.runtime.execution.components[service.component];
  const connection = target.profile?.generatedBindings.find(
    (binding) => binding.interface === service.interface && (binding.scope ?? 'runtime') === scope,
  )?.connection;
  if (connection) {
    const values = profileValues.get(service.component) ?? {};
    return `${connection.scheme}://${encodeURIComponent(values[connection.usernameValue])}:${encodeURIComponent(values[connection.passwordValue])}@${host}:${service.containerPort}/${encodeURIComponent(values[connection.databaseValue])}`;
  }
  if (service.protocol === 'http' || service.protocol === 'https') {
    return `${service.protocol}://${host}:${service.containerPort}`;
  }
  return `${host}:${service.containerPort}`;
}

function serviceHostname(applicationId: string, component: string): string {
  return `${component}.${applicationId}.internal`.toLowerCase().replace(/[^a-z0-9.-]/g, '-');
}

function writableSingleWriter(component: ComponentExecutionPlan, spec: ApplicationSpec): boolean {
  return Object.values(component.mounts).some(
    (mount) => !mount.readOnly && spec.resources[mount.resource]?.access === 'singleWriter',
  );
}

/**
 * Instance identity tracks only configuration projected into that component.
 * A secret rotation therefore rolls its consumers while unrelated siblings keep
 * their healthy fixed-slot identities. Raw values never leave this hash input.
 */
export function componentConfigurationDigest(
  runtime: ResolvedApplicationGraphRuntime,
  componentName: string,
): `sha256:${string}` {
  const component = runtime.spec.components[componentName];
  if (!component) throw new Error(`Unknown application component ${componentName}`);
  const references = [
    ...Object.entries(component.environment)
      .filter(([, reference]) => reference.from.startsWith('configuration.'))
      .map(([target, reference]) => [`environment:${target}`, reference] as const),
    ...Object.entries(component.configurationFiles ?? {}).map(
      ([target, reference]) => [`file:${target}`, reference] as const,
    ),
  ];
  const projected = references
    .map(([target, reference]) => {
      const key = reference.from.slice('configuration.'.length);
      return [
        target,
        key,
        Object.hasOwn(runtime.configurationValues, key)
          ? runtime.configurationValues[key]
          : '__missing__',
      ];
    })
    .sort(([left], [right]) => String(left).localeCompare(String(right)));
  return `sha256:${createHash('sha256').update(JSON.stringify(projected)).digest('hex')}`;
}

function assertProfileVersionTransitionCompatible(
  context: GraphExecutorContext,
  component: ComponentExecutionPlan,
  stale: readonly ComponentInstanceRow[],
): void {
  const identity = component.profile?.versionIdentity;
  if (!identity) return;
  const pattern = new RegExp(identity.imagePattern, 'i');
  for (const instance of stale) {
    const previous = instance.image.match(pattern)?.[1];
    if (previous && previous !== identity.value) {
      if (context.profileTransition?.component === component.name) continue;
      throw new Error(
        `Profile ${component.profile!.profile} version transition ${previous} -> ${identity.value} requires an explicit ${component.profile!.versionTransitions?.major || 'profile-owned'} workflow`,
      );
    }
  }
}

interface RecoveryManifest {
  version: 1;
  applicationId: string;
  siteId: string;
  specDigest: string;
  configurationDigest: string;
  resources: Array<{
    resource: string;
    consistencyGroup: string;
    archive: string;
    digest: `sha256:${string}`;
    bytes: number;
  }>;
}

function managedRecoveryResources(spec: ApplicationSpec): string[] {
  const selected = Object.entries(spec.resources).filter(
    ([, resource]) => resource.backup.policy !== 'exclude',
  );
  const bind = selected.find(([, resource]) => resource.source?.type === 'bind');
  if (bind) {
    throw new Error(
      `Recovery points cannot safely archive bind resource ${JSON.stringify(bind[0])}; use a managed volume`,
    );
  }
  return selected
    .map(([resource]) => resource)
    .sort((left, right) => {
      const groupOrder = spec.resources[left].consistencyGroup.localeCompare(
        spec.resources[right].consistencyGroup,
      );
      return groupOrder || left.localeCompare(right);
    });
}

function parseRecoveryManifest(value: unknown): RecoveryManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Recovery manifest must be an object');
  }
  const input = value as Partial<RecoveryManifest>;
  if (
    input.version !== 1 ||
    typeof input.applicationId !== 'string' ||
    typeof input.siteId !== 'string' ||
    typeof input.specDigest !== 'string' ||
    typeof input.configurationDigest !== 'string' ||
    !Array.isArray(input.resources)
  ) {
    throw new Error('Recovery manifest header is invalid');
  }
  const resources = input.resources.map((entry) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof entry.resource !== 'string' ||
      typeof entry.consistencyGroup !== 'string' ||
      typeof entry.archive !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(entry.digest) ||
      typeof entry.bytes !== 'number' ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0
    ) {
      throw new Error('Recovery manifest resource entry is invalid');
    }
    return entry as RecoveryManifest['resources'][number];
  });
  if (new Set(resources.map((entry) => entry.resource)).size !== resources.length) {
    throw new Error('Recovery manifest contains duplicate resources');
  }
  return { ...input, resources } as RecoveryManifest;
}

function containedRecoveryPath(root: string, child: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(child)) {
    throw new Error(`Recovery archive path ${JSON.stringify(child)} is invalid`);
  }
  const path = resolve(root, child);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error('Recovery archive path escapes its recovery point directory');
  }
  return path;
}

async function fileSha256(path: string): Promise<`sha256:${string}`> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return `sha256:${digest.digest('hex')}`;
}

function sha256(value: Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function containerName(
  deployment: string,
  component: string,
  slot: string,
  releaseDigest: string,
  id: string,
): string {
  const ordinal = slot.split('/').at(-1) ?? '1';
  return boundedDockerName(
    `deploy-sh-${deployment}-${component}-${ordinal}-${releaseDigest.replace(/^sha256:/, '').slice(0, 8)}-${id.slice(0, 8)}`,
  );
}

function jobContainerName(deployment: string, job: string, key: string): string {
  return boundedDockerName(`deploy-sh-${deployment}-job-${job}-${key.slice(-12)}`);
}

function boundedDockerName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
  return normalized.length <= 63 ? normalized : normalized.slice(0, 63);
}

function safeIdentifier(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^([^a-z_])/, '_$1');
  return (normalized || 'app').slice(0, 63);
}

function generatedProfileValue(deploymentName: string, key: string): string {
  if (key === 'database') return safeIdentifier(deploymentName);
  if (key.endsWith('Username')) {
    const scope = key.slice(0, -'Username'.length) || 'app';
    return safeIdentifier(`${deploymentName}_${scope}`);
  }
  return randomBytes(32).toString('base64url');
}

function substitute(value: string, variables: Readonly<Record<string, string>>): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key: string) => {
    const replacement = variables[key];
    if (replacement === undefined) throw new Error(`Profile operation variable ${key} is required`);
    return replacement;
  });
}

function profileOperationVariables(
  component: ComponentExecutionPlan,
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const declaration of component.profile?.provisionedValues ?? []) {
    const value = values[declaration.name];
    if (value !== undefined) variables[declaration.environment] = value;
  }
  return variables;
}
