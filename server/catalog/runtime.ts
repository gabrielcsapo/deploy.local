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

import { DurableGraphRuntimeStore } from '../graph-runtime-store.ts';

import { registerApplicationIdentity } from '../local-site.ts';
import {
  getApplicationSpecRevision,
  getDeployment,
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
    if (!this.#stageOnly && request.installation.siteId !== 'coordinator') {
      throw new Error('Catalog execution requires the coordinator');
    }
    if (request.operation.operation === 'uninstall') {
      return this.#stageUninstall(request);
    }
    return this.#stageRevision(request);
  }

  async createRecoveryPoint(request: CatalogRecoveryRuntimeRequest) {
    const { installation, recoveryPoint } = request;
    if (installation.siteId !== 'coordinator')
      throw new Error('Catalog recovery requires the coordinator');
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
      writerSiteId: applicationWriterSiteId(applicationId, installation.siteId),
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
}
