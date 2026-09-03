import type { ResolvedApplicationGraphRuntime } from './application-runtime.ts';
import type { AgentGraphExecutionResult, AgentGraphInstanceResult } from './agent-graph-runtime.ts';
import { DurableGraphRuntimeStore, type GraphRuntimeStateStore } from './graph-runtime-store.ts';

export interface RecordAgentGraphInput {
  deploymentName: string;
  applicationId: string;
  siteId: string;
  nodeId: string;
  nodeAddress: string;
  relayPort: number | null;
  runtime: ResolvedApplicationGraphRuntime;
  result: AgentGraphExecutionResult;
}

/** Project an agent's authenticated health-gated result into the coordinator's actual-state view. */
export function recordAgentGraphMaterialization(
  input: RecordAgentGraphInput,
  state: GraphRuntimeStateStore = new DurableGraphRuntimeStore(),
): void {
  if (
    input.result.applicationId !== input.applicationId ||
    input.result.specDigest !== input.runtime.execution.specDigest ||
    input.result.configurationDigest !== input.runtime.configurationDigest
  ) {
    throw new Error('Connected agent returned graph metadata for a different revision');
  }
  const now = Date.now();
  const currentIds = new Set(input.result.instances.map((instance) => instance.id));
  for (const [componentName, component] of Object.entries(input.runtime.execution.components)) {
    const instances = input.result.instances.filter(
      (instance) => instance.component === componentName,
    );
    if (instances.length !== component.desiredInstances) {
      throw new Error(
        `Connected agent returned ${instances.length} of ${component.desiredInstances} required ${componentName} instances`,
      );
    }
    state.upsertPlacement({
      appId: input.applicationId,
      deploymentName: input.deploymentName,
      siteId: input.siteId,
      componentKey: componentName,
      desiredInstances: component.desiredInstances,
      defaultInstances: component.defaultInstances,
      minimumReady: component.minimumReady,
      rolloutStrategy: component.rollout.strategy,
      maxSurge: component.rollout.maxSurge,
      maxUnavailable: component.rollout.maxUnavailable,
      placementIntent: component.placement.intent,
      capacity: JSON.stringify(component.capacity),
      releaseDigest: instances[0]?.releaseDigest || input.result.specDigest,
      configurationDigest: instances[0]?.configurationDigest || input.result.configurationDigest,
      generation: 1,
      state: 'ready',
      profile: component.profile?.profile ?? null,
      updatedAt: new Date(now).toISOString(),
    });
  }
  for (const instance of input.result.instances) {
    assertAgentInstance(instance, input.runtime);
    state.putInstance({
      id: instance.id,
      appId: input.applicationId,
      deploymentName: input.deploymentName,
      siteId: input.siteId,
      componentKey: instance.component,
      slotKey: instance.slot,
      nodeId: input.nodeId,
      releaseDigest: instance.releaseDigest,
      configurationDigest: instance.configurationDigest,
      image: instance.image,
      containerId: instance.containerId,
      containerName: instance.containerName,
      status: 'ready',
      health: 'healthy',
      replacementFor: null,
      drainDeadline: null,
      readyAt: now,
      createdAt: now,
      updatedAt: now,
    });
    state.replaceVolumeAttachments(instance.id, []);
  }
  for (const previous of state.listInstances(input.applicationId, input.siteId)) {
    if (!currentIds.has(previous.id) && previous.status !== 'removed') {
      state.patchInstance(previous.id, {
        status: 'removed',
        health: 'unknown',
        updatedAt: now,
      });
    }
  }
  const recordedJobs = new Set(
    state.getJobRecords(input.applicationId, input.siteId).map((record) => record.idempotencyKey),
  );
  for (const job of input.result.jobs) {
    if (recordedJobs.has(job.key)) continue;
    const instance = job.instanceId
      ? input.result.instances.find((candidate) => candidate.id === job.instanceId)
      : undefined;
    state.startJob({
      idempotencyKey: job.key,
      appId: input.applicationId,
      deploymentName: input.deploymentName,
      siteId: input.siteId,
      releaseDigest: input.result.specDigest,
      configurationDigest: input.result.configurationDigest,
      jobKey: job.job,
      componentKey: job.component,
      scope: job.scope,
      instanceId: job.instanceId,
      status: 'running',
      attempts: 1,
      containerId: instance?.containerId ?? null,
      leaseOwner: `agent:${input.nodeId}`,
      leaseExpiresAt: now,
      startedAt: now,
      updatedAt: now,
    });
    state.finishJob(job.key, 'succeeded', 0, 'Completed on connected execution agent');
  }

  const published = new Set(
    Object.values(input.runtime.execution.routes).map((route) => route.serviceId),
  );
  for (const service of Object.values(input.runtime.execution.services)) {
    state.upsertService({
      id: service.id,
      appId: input.applicationId,
      deploymentName: input.deploymentName,
      componentKey: service.component,
      interfaceKey: service.interface,
      protocol: service.protocol,
      containerPort: service.containerPort,
      published: published.has(service.id),
      updatedAt: now,
    });
    const primary =
      input.result.primaryRoute?.component === service.component &&
      input.result.primaryRoute.interface === service.interface;
    const endpoints = input.result.instances
      .filter(
        (instance) =>
          instance.component === service.component &&
          (!primary || instance.id === input.result.primaryRoute?.endpoints[0]?.instanceId),
      )
      .flatMap((instance) => {
        const port = primary
          ? input.relayPort
          : published.has(service.id)
            ? null
            : service.containerPort;
        if (!port) return [];
        return [
          {
            id: `${service.id}/${instance.id}`,
            instanceId: instance.id,
            siteId: input.siteId,
            host: primary
              ? input.nodeAddress
              : `${service.component}.${input.applicationId}.internal`,
            port,
            releaseDigest: instance.releaseDigest,
            configurationDigest: instance.configurationDigest,
          },
        ];
      });
    state.replaceReadyEndpoints(input.deploymentName, service.id, endpoints, now);
  }
}

function assertAgentInstance(
  instance: AgentGraphInstanceResult,
  runtime: ResolvedApplicationGraphRuntime,
): void {
  const component = runtime.execution.components[instance.component];
  if (
    !component ||
    !component.slots.includes(instance.slot) ||
    !instance.id ||
    !instance.containerId ||
    !/^deploy-sh-[a-z0-9_.-]+$/.test(instance.containerName) ||
    !instance.image
  ) {
    throw new Error('Connected agent returned invalid component instance metadata');
  }
}
