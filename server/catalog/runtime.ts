import { compileApplicationManifest, renderDeployYaml } from '../application-spec.ts';
import { ApplicationGraphExecutor } from '../application-graph-executor.ts';
import { applicationWriterSiteId } from '../application-authority.ts';
import {
  carryForwardCompatibleConfiguration,
  resolveApplicationConfiguration,
  setDeclaredConfigurationValue,
} from '../application-configuration.ts';
import { planApplicationExecution } from '../application-execution.ts';
import { resolvePlacementTarget } from '../application-placement-target.ts';
import { buildApplicationGraphRuntime } from '../application-runtime.ts';
import { deployDataDirectory, deployDataPath } from '../data-directory.ts';
import { publishActivatedApplicationRevision } from '../distributed-application-events.ts';
import { DurableGraphRuntimeStore } from '../graph-runtime-store.ts';
import { keepApplicationOnSuitcase } from '../fleet-replicas.ts';
import {
  applicationDeleteMutationFingerprint,
  assertFleetMutationReady,
  destructiveGraphMutationFingerprint,
  requiresFleetAcknowledgement,
} from '../fleet-mutation-guard.ts';
import {
  appendLocalFleetEvent,
  ensureFleetIdentity,
  registerApplicationIdentity,
} from '../multisite.ts';
import {
  getApplicationSpecRevision,
  getDeployment,
  getSqlite,
  activateDesiredApplicationSpec,
  deleteDeployment,
  recordContainerStart,
  saveDeployment,
  saveDesiredApplicationSpec,
  updateDeploymentConfigurationDigest,
  updateDeploymentSettings,
  updateDeploymentStatus,
} from '../store.ts';
import type {
  CatalogRecoveryRuntimeRequest,
  CatalogRuntimeAdapter,
  CatalogRuntimeRequest,
  CatalogRuntimeResult,
} from './service.ts';

/**
 * Bridges catalog intent to the ordinary immutable-spec and graph-executor projections.
 * Production execution completes only after a local graph is healthy; unsupported remote sites
 * fail closed until the site-agent completion protocol is available.
 */
export class DeployLocalCatalogRuntime implements CatalogRuntimeAdapter {
  readonly #graph = new DurableGraphRuntimeStore();
  readonly #executor: Pick<ApplicationGraphExecutor, 'converge' | 'remove'> &
    Partial<Pick<ApplicationGraphExecutor, 'createRecoveryPoint' | 'restoreRecoveryPoint'>>;
  readonly #stageOnly: boolean;

  constructor(
    options: {
      executor?: Pick<ApplicationGraphExecutor, 'converge' | 'remove'> &
        Partial<Pick<ApplicationGraphExecutor, 'createRecoveryPoint' | 'restoreRecoveryPoint'>>;
      stageOnly?: boolean;
    } = {},
  ) {
    this.#executor = options.executor ?? new ApplicationGraphExecutor();
    this.#stageOnly = options.stageOnly ?? process.env.DEPLOY_CATALOG_STAGE_ONLY === '1';
  }

  async execute(request: CatalogRuntimeRequest): Promise<CatalogRuntimeResult> {
    if (request.operation.operation === 'uninstall') {
      return this.#stageUninstall(request);
    }
    return this.#stageRevision(request);
  }

  async completion(request: CatalogRuntimeRequest) {
    if (request.installation.siteId === 'coordinator') {
      return { state: 'pending' as const };
    }
    const row = getSqlite()!
      .prepare(
        `SELECT payload FROM fleet_events
          WHERE origin_site_id = ? AND operation = 'catalog.operation.materialized'
            AND json_extract(payload, '$.catalogOperationId') = ?
            AND COALESCE(json_extract(payload, '$.catalogOperationAttempt'), 1) = ?
          ORDER BY origin_sequence DESC LIMIT 1`,
      )
      .get(request.installation.siteId, request.operation.id, request.operation.attempt) as
      | { payload: string }
      | undefined;
    if (!row) return { state: 'pending' as const };
    const payload = JSON.parse(row.payload) as {
      siteId?: unknown;
      status?: unknown;
      specDigest?: unknown;
      blockers?: unknown;
    };
    if (payload.siteId !== request.installation.siteId) {
      return { state: 'failed' as const, error: 'Remote completion site does not match target' };
    }
    const expectedDigest = compileApplicationManifest(request.operation.plan.normalizedSpec).digest;
    if (request.operation.operation !== 'uninstall' && payload.specDigest !== expectedDigest) {
      return {
        state: 'failed' as const,
        error: 'Remote completion revision does not match the catalog operation',
      };
    }
    const expectedStatus = request.operation.operation === 'uninstall' ? 'removed' : 'ready';
    if (payload.status === expectedStatus) {
      this.#commitRemoteCompletion(request, expectedDigest);
      return { state: 'healthy' as const };
    }
    const blockers = Array.isArray(payload.blockers)
      ? payload.blockers.filter((value): value is string => typeof value === 'string')
      : [];
    updateDeploymentStatus(request.installation.applicationName, 'failed');
    return {
      state: 'failed' as const,
      error: blockers.join('; ') || `Remote materialization reported ${String(payload.status)}`,
    };
  }

  async recoveryCompletion(request: CatalogRecoveryRuntimeRequest) {
    const { installation, recoveryPoint } = request;
    if (installation.siteId === 'coordinator') return { state: 'pending' as const };
    const row = getSqlite()!
      .prepare(
        `SELECT payload FROM fleet_events
          WHERE origin_site_id = ? AND operation = 'catalog.recovery.materialized'
            AND json_extract(payload, '$.recoveryPointId') = ?
          ORDER BY origin_sequence DESC LIMIT 1`,
      )
      .get(installation.siteId, recoveryPoint.id) as { payload: string } | undefined;
    if (!row) return { state: 'pending' as const };
    const payload = JSON.parse(row.payload) as {
      siteId?: unknown;
      recoveryPointId?: unknown;
      status?: unknown;
      specDigest?: unknown;
      artifactReference?: unknown;
      artifactDigest?: unknown;
      verification?: unknown;
      blockers?: unknown;
    };
    if (
      payload.siteId !== installation.siteId ||
      payload.recoveryPointId !== recoveryPoint.id ||
      payload.specDigest !== recoveryPoint.specDigest
    ) {
      return {
        state: 'failed' as const,
        error: 'Remote recovery completion does not match its requested site and revision',
      };
    }
    if (payload.status !== 'verified') {
      const blockers = Array.isArray(payload.blockers)
        ? payload.blockers.filter((value): value is string => typeof value === 'string')
        : [];
      return {
        state: 'failed' as const,
        error: blockers.join('; ') || `Remote recovery reported ${String(payload.status)}`,
      };
    }
    if (
      typeof payload.artifactReference !== 'string' ||
      typeof payload.artifactDigest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(payload.artifactDigest) ||
      typeof payload.verification !== 'string' ||
      !payload.verification
    ) {
      return { state: 'failed' as const, error: 'Remote recovery verification is incomplete' };
    }
    return {
      state: 'verified' as const,
      artifactReference: payload.artifactReference,
      artifactDigest: payload.artifactDigest as `sha256:${string}`,
      verification: payload.verification,
    };
  }

  async createRecoveryPoint(request: CatalogRecoveryRuntimeRequest) {
    const { installation, recoveryPoint } = request;
    if (this.#stageOnly) {
      throw new Error('Physical recovery points are unavailable in stage-only catalog mode');
    }
    const deployment = getDeployment(installation.applicationName);
    const revision = deployment?.activeSpecDigest
      ? getApplicationSpecRevision(installation.applicationName, deployment.activeSpecDigest)
      : undefined;
    if (!deployment?.appId || !revision || revision.digest !== installation.currentSpecDigest) {
      throw new Error('Healthy active application revision is unavailable for recovery');
    }
    if (installation.siteId !== 'coordinator') {
      const fleet = ensureFleetIdentity();
      appendLocalFleetEvent({
        originSiteId: fleet.homeSiteId,
        appId: deployment.appId,
        actor: recoveryPoint.createdBy,
        operation: 'catalog.recovery.requested',
        authorityEpoch: deployment.releaseAuthorityEpoch || 1,
        generation: deployment.releaseGeneration || 1,
        payload: {
          siteId: installation.siteId,
          applicationName: installation.applicationName,
          recoveryPointId: recoveryPoint.id,
          specDigest: recoveryPoint.specDigest,
        },
      });
      return { state: 'pending' as const };
    }
    if (!this.#executor.createRecoveryPoint) {
      throw new Error('Graph executor does not support physical recovery archives');
    }
    const compiled = compileApplicationManifest(JSON.parse(revision.normalizedSpec));
    const configuration = resolveApplicationConfiguration({
      deploymentName: installation.applicationName,
      specDigest: compiled.digest,
      declarations: compiled.spec.configuration,
      siteId: installation.siteId,
    });
    if (configuration.missing.length > 0) {
      throw new Error(`Recovery configuration is incomplete: ${configuration.missing.join(', ')}`);
    }
    const graphRuntime = buildApplicationGraphRuntime({
      applicationId: deployment.appId,
      specDigest: compiled.digest,
      spec: compiled.spec,
      configuration,
      siteId: installation.siteId,
    });
    return this.#executor.createRecoveryPoint(
      {
        deploymentName: installation.applicationName,
        applicationId: deployment.appId,
        siteId: installation.siteId,
        nodeId: installation.siteId,
        projectDirectory: deployment.directory || deployDataDirectory(),
        runtime: graphRuntime,
      },
      deployDataPath('catalog-recovery', installation.id, recoveryPoint.id),
    );
  }

  async #stageRevision(request: CatalogRuntimeRequest): Promise<CatalogRuntimeResult> {
    const { installation, operation } = request;
    const compiled = compileApplicationManifest(operation.plan.normalizedSpec);
    const existing = getDeployment(installation.applicationName);
    if (!existing) {
      saveDeployment({
        name: installation.applicationName,
        type: 'catalog',
        username: operation.actor,
        desiredNodeId: installation.siteId,
      });
    } else if (operation.operation === 'install' && existing.specSource !== 'catalog') {
      throw new Error(
        `Application ${JSON.stringify(installation.applicationName)} already exists outside the catalog`,
      );
    }

    const deployment = getDeployment(installation.applicationName);
    if (!deployment) throw new Error('Catalog deployment could not be created');
    const applicationId = registerApplicationIdentity(installation.applicationName);
    const parentDigest = deployment.desiredSpecDigest || deployment.activeSpecDigest || null;
    const priorRevision = parentDigest
      ? getApplicationSpecRevision(installation.applicationName, parentDigest)
      : undefined;
    if (
      priorRevision &&
      (operation.operation === 'rollback' ||
        requiresFleetAcknowledgement(operation.plan.changePlan, compiled.spec))
    ) {
      assertFleetMutationReady({
        appId: applicationId,
        applicationName: installation.applicationName,
        kind: 'destructive-graph-change',
        mutationFingerprint: destructiveGraphMutationFingerprint(applicationId, compiled.digest),
        consequence:
          operation.operation === 'rollback'
            ? 'This catalog rollback restores durable data and an earlier graph. Every selected suitcase must sync and acknowledge this exact rollback revision before catalog state changes.'
            : 'This catalog upgrade removes or incompatibly changes graph or schema state. Every selected suitcase must sync and acknowledge this exact revision before catalog state changes.',
        actor: operation.actor,
      });
    }
    saveDesiredApplicationSpec({
      digest: compiled.digest,
      deploymentName: installation.applicationName,
      parentDigest,
      apiVersion: compiled.spec.apiVersion,
      source: 'catalog',
      manifestFormat: 'generated',
      normalizedSpec: compiled.canonicalJson,
      originalSource: renderDeployYaml(compiled.spec),
      createdBy: operation.actor,
    });

    if (priorRevision && priorRevision.digest !== compiled.digest) {
      carryForwardCompatibleConfiguration({
        deploymentName: installation.applicationName,
        fromSpec: JSON.parse(priorRevision.normalizedSpec),
        fromDigest: priorRevision.digest,
        toSpec: compiled.spec,
        toDigest: compiled.digest,
        updatedBy: operation.actor,
      });
    }
    for (const [key, value] of Object.entries(request.answers ?? {})) {
      setDeclaredConfigurationValue({
        deploymentName: installation.applicationName,
        specDigest: compiled.digest,
        declarations: compiled.spec.configuration,
        key,
        value,
        siteId:
          compiled.spec.configuration[key]?.scope === 'site' ? installation.siteId : undefined,
        updatedBy: operation.actor,
      });
    }
    const configuration = resolveApplicationConfiguration({
      deploymentName: installation.applicationName,
      specDigest: compiled.digest,
      declarations: compiled.spec.configuration,
      siteId: installation.siteId,
    });
    const execution = planApplicationExecution(applicationId, compiled.spec, {
      specDigest: compiled.digest,
      unresolvedConfiguration: new Set(configuration.missing),
      targetSiteId: installation.siteId,
      placementTarget: resolvePlacementTarget(installation.siteId),
    });
    if (execution.blocked) {
      const blockers = execution.findings
        .filter((finding) => finding.severity === 'error')
        .map((finding) => finding.message);
      throw new Error(`Catalog graph executor plan is blocked: ${blockers.join('; ')}`);
    }

    const now = new Date().toISOString();
    for (const component of Object.values(execution.components)) {
      this.#graph.upsertPlacement({
        appId: execution.applicationId,
        deploymentName: installation.applicationName,
        siteId: installation.siteId,
        componentKey: component.name,
        desiredInstances: component.desiredInstances,
        releaseDigest: execution.specDigest,
        configurationDigest: configuration.digest,
        generation: operation.attempt,
        state: 'pending',
        profile: component.profile?.profile ?? null,
        updatedAt: now,
      });
    }
    const publishedServices = new Set(
      Object.values(execution.routes).map((route) => route.serviceId),
    );
    for (const service of Object.values(execution.services)) {
      this.#graph.upsertService({
        id: service.id,
        appId: execution.applicationId,
        deploymentName: installation.applicationName,
        componentKey: service.component,
        interfaceKey: service.interface,
        protocol: service.protocol,
        containerPort: service.containerPort,
        published: publishedServices.has(service.id),
        membershipGeneration: 0,
        updatedAt: Date.now(),
      });
    }
    updateDeploymentConfigurationDigest(installation.applicationName, configuration.digest);
    updateDeploymentStatus(installation.applicationName, 'starting');

    if (this.#stageOnly) return { state: 'accepted' };
    if (installation.siteId !== 'coordinator') {
      await this.#queueRemoteRevision(
        request,
        compiled.canonicalJson,
        compiled.digest,
        applicationId,
      );
      return { state: 'accepted' };
    }

    const graphRuntime = buildApplicationGraphRuntime({
      applicationId,
      specDigest: compiled.digest,
      spec: compiled.spec,
      configuration,
      siteId: installation.siteId,
    });
    const graphContext = {
      deploymentName: installation.applicationName,
      applicationId,
      siteId: installation.siteId,
      nodeId: installation.siteId,
      projectDirectory: deployDataDirectory(),
      runtime: graphRuntime,
      writerSiteId: applicationWriterSiteId(applicationId),
    };
    if (operation.operation === 'rollback') {
      if (
        !request.recoveryPoint?.artifactReference ||
        !request.recoveryPoint.artifactDigest ||
        !this.#executor.restoreRecoveryPoint
      ) {
        throw new Error('Rollback requires a restorable physical recovery artifact');
      }
      await this.#executor.restoreRecoveryPoint(graphContext, {
        artifactReference: request.recoveryPoint.artifactReference,
        artifactDigest: request.recoveryPoint.artifactDigest as `sha256:${string}`,
      });
    }
    const result = await this.#executor.converge(graphContext);
    saveDeployment({
      name: installation.applicationName,
      type: deployment.type || 'catalog',
      username: deployment.username,
      port: result.primaryPort ?? undefined,
      containerId: result.primaryContainerId ?? undefined,
      containerName: result.primaryContainerName ?? undefined,
      directory: deployDataDirectory(),
      desiredNodeId: installation.siteId,
      activeNodeId: installation.siteId,
      createdAt: deployment.createdAt || undefined,
    });
    activateDesiredApplicationSpec(
      installation.applicationName,
      compiled.digest,
      configuration.digest,
    );
    publishActivatedApplicationRevision(installation.applicationName, operation.actor);
    updateDeploymentSettings(installation.applicationName, {
      discoverable: Object.values(compiled.spec.routes).some((route) => route.discoverable),
    });
    recordContainerStart(installation.applicationName);
    updateDeploymentStatus(installation.applicationName, 'running');
    return { state: 'healthy' };
  }

  async #stageUninstall(request: CatalogRuntimeRequest): Promise<CatalogRuntimeResult> {
    const { installation, operation } = request;
    const deployment = getDeployment(installation.applicationName);
    const activeRevision = deployment?.activeSpecDigest
      ? getApplicationSpecRevision(installation.applicationName, deployment.activeSpecDigest)
      : undefined;
    const compiled = compileApplicationManifest(
      activeRevision ? JSON.parse(activeRevision.normalizedSpec) : operation.plan.normalizedSpec,
    );
    const applicationId = deployment
      ? deployment.appId || registerApplicationIdentity(installation.applicationName)
      : installation.applicationName;
    if (!operation.retainData && deployment) {
      assertFleetMutationReady({
        appId: applicationId,
        applicationName: installation.applicationName,
        kind: 'application-delete',
        mutationFingerprint: applicationDeleteMutationFingerprint(applicationId),
        consequence:
          'Deleting this catalog application removes its Home runtime, graph record, and managed data. Every selected suitcase must sync and acknowledge before uninstall continues.',
        actor: operation.actor,
      });
    }
    const configuration = resolveApplicationConfiguration({
      deploymentName: installation.applicationName,
      specDigest: installation.currentSpecDigest,
      declarations: compiled.spec.configuration,
      siteId: installation.siteId,
    });
    const execution = planApplicationExecution(applicationId, compiled.spec, {
      specDigest: installation.currentSpecDigest,
      unresolvedConfiguration: new Set(configuration.missing),
      targetSiteId: installation.siteId,
      placementTarget: resolvePlacementTarget(installation.siteId),
    });
    const now = new Date().toISOString();
    for (const component of Object.values(execution.components)) {
      this.#graph.upsertPlacement({
        appId: execution.applicationId,
        deploymentName: installation.applicationName,
        siteId: installation.siteId,
        componentKey: component.name,
        desiredInstances: 0,
        releaseDigest: execution.specDigest,
        configurationDigest: configuration.digest,
        generation: operation.attempt,
        state: operation.retainData ? 'removing-runtime' : 'removing-runtime-and-data',
        profile: component.profile?.profile ?? null,
        updatedAt: now,
      });
    }
    updateDeploymentStatus(installation.applicationName, 'stopping');
    if (this.#stageOnly) return { state: 'accepted' };
    if (installation.siteId !== 'coordinator') {
      const fleet = ensureFleetIdentity();
      appendLocalFleetEvent({
        originSiteId: fleet.homeSiteId,
        appId: applicationId,
        actor: operation.actor,
        operation: 'application.replica.removed',
        generation: deployment?.releaseGeneration || 0,
        payload: {
          siteId: installation.siteId,
          applicationName: installation.applicationName,
          catalogOperationId: operation.id,
          catalogOperationAttempt: operation.attempt,
          retainData: operation.retainData === true,
          managedVolumeResources: Object.entries(compiled.spec.resources)
            .filter(([, resource]) => resource.source?.type !== 'bind')
            .map(([resource]) => resource),
        },
      });
      return { state: 'accepted' };
    }
    await this.#executor.remove({
      applicationId,
      siteId: installation.siteId,
      managedVolumeResources: Object.entries(compiled.spec.resources)
        .filter(([, resource]) => resource.source?.type !== 'bind')
        .map(([resource]) => resource),
      removeInfrastructure: operation.retainData !== true,
    });
    if (operation.retainData) {
      updateDeploymentStatus(installation.applicationName, 'stopped');
    } else {
      deleteDeployment(installation.applicationName);
    }
    return { state: 'healthy' };
  }

  async #queueRemoteRevision(
    request: CatalogRuntimeRequest,
    normalizedSpec: string,
    specDigest: string,
    applicationId: string,
  ): Promise<void> {
    const { installation, operation } = request;
    const fleet = ensureFleetIdentity();
    const deployment = getDeployment(installation.applicationName);
    appendLocalFleetEvent({
      originSiteId: fleet.homeSiteId,
      appId: applicationId,
      actor: operation.actor,
      operation: 'application.revision.desired',
      authorityEpoch: deployment?.releaseAuthorityEpoch || 1,
      generation: (deployment?.releaseGeneration || 0) + 1,
      payload: {
        name: installation.applicationName,
        specDigest,
        parentDigest: deployment?.activeSpecDigest || null,
        apiVersion: 'deploy.local/v1',
        manifestFormat: 'generated',
        normalizedSpec,
        configurationDigest: deployment?.configurationDigest || null,
        source: 'catalog',
        siteId: installation.siteId,
        catalogOperationId: operation.id,
        catalogOperationAttempt: operation.attempt,
        ...(operation.operation === 'rollback' && request.recoveryPoint
          ? {
              recoveryPointId: request.recoveryPoint.id,
              recoveryArtifactReference: request.recoveryPoint.artifactReference,
              recoveryArtifactDigest: request.recoveryPoint.artifactDigest,
            }
          : {}),
      },
    });
    await keepApplicationOnSuitcase({
      appId: applicationId,
      siteId: installation.siteId,
      policy: 'none',
      actor: operation.actor,
    });
  }

  #commitRemoteCompletion(request: CatalogRuntimeRequest, specDigest: string): void {
    const { installation, operation } = request;
    const deployment = getDeployment(installation.applicationName);
    if (!deployment) throw new Error('Remote catalog deployment disappeared before completion');
    if (operation.operation === 'uninstall') {
      if (operation.retainData) updateDeploymentStatus(installation.applicationName, 'stopped');
      else deleteDeployment(installation.applicationName);
      return;
    }
    activateDesiredApplicationSpec(
      installation.applicationName,
      specDigest,
      deployment.configurationDigest,
    );
    saveDeployment({
      name: installation.applicationName,
      type: deployment.type || 'catalog',
      username: deployment.username,
      desiredNodeId: installation.siteId,
      activeNodeId: installation.siteId,
      createdAt: deployment.createdAt || undefined,
    });
    updateDeploymentSettings(installation.applicationName, {
      discoverable: Object.values(operation.plan.normalizedSpec.routes).some(
        (route) => route.discoverable,
      ),
    });
    updateDeploymentStatus(installation.applicationName, 'running');
  }
}
