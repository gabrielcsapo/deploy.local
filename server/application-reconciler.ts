import type { ApplicationExecutionPlan } from './application-execution.ts';

export type ComponentInstanceStatus =
  | 'starting'
  | 'ready'
  | 'unready'
  | 'failed'
  | 'draining'
  | 'stopped';

export interface ActualInstanceEndpoint {
  id: string;
  serviceId: string;
  host: string;
  port: number;
}

export interface ActualComponentInstance {
  id: string;
  component: string;
  slot: string;
  releaseDigest: string;
  configurationDigest: string;
  status: ComponentInstanceStatus;
  endpoints: readonly ActualInstanceEndpoint[];
  drainDeadline?: number | null;
  inFlight?: number;
}

export type ReconciliationAction =
  | {
      type: 'create-instance';
      component: string;
      slot: string;
      releaseDigest: string;
      configurationDigest: string;
      replaces?: string;
      reason: string;
    }
  | { type: 'probe-instance'; component: string; instanceId: string }
  | {
      type: 'admit-endpoint';
      component: string;
      instanceId: string;
      endpoint: ActualInstanceEndpoint;
    }
  | {
      type: 'withdraw-endpoint';
      component: string;
      instanceId: string;
      endpointId: string;
      serviceId: string;
      reason: string;
    }
  | { type: 'begin-drain'; component: string; instanceId: string; deadline: number; reason: string }
  | { type: 'remove-instance'; component: string; instanceId: string; reason: string };

export interface ComponentReconciliationStatus {
  component: string;
  desired: number;
  ready: number;
  state: 'blocked' | 'waiting' | 'progressing' | 'degraded' | 'ready';
  reason?: string;
}

export interface ApplicationReconciliationPlan {
  actions: readonly ReconciliationAction[];
  components: Readonly<Record<string, ComponentReconciliationStatus>>;
  state: 'blocked' | 'progressing' | 'degraded' | 'ready';
}

export interface ReconciliationOptions {
  configurationDigest: string;
  now?: number;
  drainTimeoutMs?: number;
  /** The desired release is always accepted; add the prior release during a health-gated roll. */
  acceptedReleaseDigests?: ReadonlySet<string>;
  /** The desired configuration is always accepted; add the prior digest during a safe overlap. */
  acceptedConfigurationDigests?: ReadonlySet<string>;
  /** Current atomic endpoint membership projection. */
  admittedEndpointIds?: ReadonlySet<string>;
  /** A false component gate keeps ready instances out of traffic until beforeTraffic jobs finish. */
  trafficGates?: Readonly<Record<string, boolean>>;
}

/**
 * Produce idempotent actions which converge ephemeral instances on fixed desired slots. It never
 * mutates Docker or routing state directly, so the same plan can be driven by the coordinator,
 * a remote node agent, or a suitcase supervisor.
 */
export function reconcileApplication(
  desired: ApplicationExecutionPlan,
  actual: readonly ActualComponentInstance[],
  options: ReconciliationOptions,
): ApplicationReconciliationPlan {
  const now = options.now ?? Date.now();
  const drainTimeoutMs = options.drainTimeoutMs ?? 30_000;
  const admitted = options.admittedEndpointIds ?? new Set<string>();
  const acceptedReleases = new Set(options.acceptedReleaseDigests ?? []);
  acceptedReleases.add(desired.specDigest);
  const acceptedConfigurations = new Set(options.acceptedConfigurationDigests ?? []);
  acceptedConfigurations.add(options.configurationDigest);
  const actions: ReconciliationAction[] = [];
  const statuses: Record<string, ComponentReconciliationStatus> = {};

  for (const componentName of desired.componentOrder) {
    const component = desired.components[componentName];
    const instances = actual.filter(
      (item) => item.component === componentName && item.status !== 'stopped',
    );
    const desiredSlots = new Set(component.slots);
    const retiring = new Set<string>();
    let rollingCreatesRemaining = Math.max(
      0,
      component.rollout.maxSurge - Math.max(0, instances.length - component.desiredInstances),
    );
    const dependenciesReady = component.dependencies.every(
      (dependency) =>
        statuses[dependency]?.ready === desired.components[dependency].desiredInstances,
    );
    const blockedDependency = component.dependencies.find(
      (dependency) => statuses[dependency]?.state === 'blocked',
    );

    if (component.blocked || blockedDependency) {
      const reason = component.blocked
        ? component.findings.find((item) => item.severity === 'error')?.message
        : `Required component ${JSON.stringify(blockedDependency)} is blocked`;
      for (const instance of instances) {
        retire(instance, reason || 'Component admission is blocked');
      }
      statuses[componentName] = {
        component: componentName,
        desired: component.desiredInstances,
        ready: 0,
        state: 'blocked',
        reason,
      };
      continue;
    }

    for (const instance of instances.filter((item) => !desiredSlots.has(item.slot))) {
      retire(instance, 'Instance exceeds the fixed desired count');
    }

    for (const slot of component.slots) {
      const occupants = instances.filter((item) => item.slot === slot);
      const desiredOccupants = occupants.filter(
        (item) =>
          item.releaseDigest === desired.specDigest &&
          item.configurationDigest === options.configurationDigest,
      );
      const healthyDesired = desiredOccupants.find((item) => item.status === 'ready');
      const pendingDesired = desiredOccupants.find((item) => item.status === 'starting');
      const staleOccupants = occupants.filter(
        (item) =>
          item.releaseDigest !== desired.specDigest ||
          item.configurationDigest !== options.configurationDigest,
      );

      if (
        component.rollout.strategy !== 'rolling' &&
        staleOccupants.some((item) => item.status !== 'stopped')
      ) {
        for (const stale of staleOccupants) {
          retire(
            stale,
            component.rollout.strategy === 'maintenance'
              ? 'Maintenance rollout withdraws the old release before replacement'
              : 'Recreate rollout stops the old release before replacement',
          );
        }
        continue;
      }

      if (!healthyDesired && !pendingDesired && dependenciesReady) {
        const replacing = occupants.find(
          (item) => item.status !== 'failed' && item.status !== 'stopped',
        );
        if (component.rollout.strategy !== 'rolling' || !replacing || rollingCreatesRemaining > 0) {
          actions.push({
            type: 'create-instance',
            component: componentName,
            slot,
            releaseDigest: desired.specDigest,
            configurationDigest: options.configurationDigest,
            replaces: replacing?.id,
            reason: replacing
              ? 'Create a health-gated replacement before draining the previous instance'
              : 'Desired instance is absent',
          });
          if (component.rollout.strategy === 'rolling' && replacing) rollingCreatesRemaining--;
        } else if (
          replacing &&
          component.rollout.maxUnavailable > 0 &&
          instances.filter((item) => item.status === 'ready' && !retiring.has(item.id)).length >
            component.minimumReady
        ) {
          retire(replacing, 'Rolling replacement uses declared unavailable capacity before create');
        }
      }

      for (const instance of desiredOccupants) {
        if (instance.status === 'starting') {
          actions.push({
            type: 'probe-instance',
            component: componentName,
            instanceId: instance.id,
          });
        } else if (instance.status === 'failed' || instance.status === 'unready') {
          withdraw(instance, 'Instance is not ready');
          if (instance.status === 'failed') {
            actions.push({
              type: 'remove-instance',
              component: componentName,
              instanceId: instance.id,
              reason: 'Failed desired instance will be replaced',
            });
          }
        }
      }

      if (healthyDesired) {
        for (const stale of occupants.filter((item) => item.id !== healthyDesired.id)) {
          retire(stale, 'A healthy desired-release replacement is ready');
        }
      }
    }

    const trafficGate = options.trafficGates?.[componentName] !== false;
    for (const instance of instances) {
      const accepted =
        acceptedReleases.has(instance.releaseDigest) &&
        acceptedConfigurations.has(instance.configurationDigest);
      const routable =
        instance.status === 'ready' && accepted && trafficGate && !retiring.has(instance.id);
      for (const endpoint of instance.endpoints) {
        if (routable && !admitted.has(endpoint.id)) {
          actions.push({
            type: 'admit-endpoint',
            component: componentName,
            instanceId: instance.id,
            endpoint,
          });
        } else if (!routable && admitted.has(endpoint.id)) {
          actions.push({
            type: 'withdraw-endpoint',
            component: componentName,
            instanceId: instance.id,
            endpointId: endpoint.id,
            serviceId: endpoint.serviceId,
            reason: !trafficGate
              ? 'A before-traffic lifecycle job has not completed'
              : !accepted
                ? 'Instance release or configuration is not accepted for traffic'
                : 'Instance is not ready',
          });
        }
      }
    }

    const ready = instances.filter(
      (item) =>
        item.status === 'ready' &&
        item.releaseDigest === desired.specDigest &&
        item.configurationDigest === options.configurationDigest,
    ).length;
    const hasServingFallback = instances.some(
      (item) =>
        item.status === 'ready' &&
        acceptedReleases.has(item.releaseDigest) &&
        acceptedConfigurations.has(item.configurationDigest),
    );
    statuses[componentName] = {
      component: componentName,
      desired: component.desiredInstances,
      ready,
      state: !dependenciesReady
        ? 'waiting'
        : ready === component.desiredInstances
          ? 'ready'
          : hasServingFallback || ready >= component.minimumReady
            ? 'degraded'
            : 'progressing',
      reason: !dependenciesReady ? 'Waiting for required components to become ready' : undefined,
    };

    function withdraw(instance: ActualComponentInstance, reason: string) {
      for (const endpoint of instance.endpoints) {
        if (!admitted.has(endpoint.id)) continue;
        actions.push({
          type: 'withdraw-endpoint',
          component: componentName,
          instanceId: instance.id,
          endpointId: endpoint.id,
          serviceId: endpoint.serviceId,
          reason,
        });
      }
    }

    function retire(instance: ActualComponentInstance, reason: string) {
      retiring.add(instance.id);
      withdraw(instance, reason);
      if (instance.status === 'draining') {
        if (
          (instance.inFlight ?? 0) === 0 ||
          (instance.drainDeadline !== null &&
            instance.drainDeadline !== undefined &&
            now >= instance.drainDeadline)
        ) {
          actions.push({
            type: 'remove-instance',
            component: componentName,
            instanceId: instance.id,
            reason: 'Connection drain completed or reached its deadline',
          });
        }
      } else if (
        instance.status === 'starting' ||
        instance.status === 'failed' ||
        instance.status === 'unready'
      ) {
        actions.push({
          type: 'remove-instance',
          component: componentName,
          instanceId: instance.id,
          reason,
        });
      } else {
        actions.push({
          type: 'begin-drain',
          component: componentName,
          instanceId: instance.id,
          deadline: now + drainTimeoutMs,
          reason,
        });
      }
    }
  }

  const componentStates = Object.values(statuses).map((item) => item.state);
  const state =
    desired.blocked || componentStates.includes('blocked')
      ? 'blocked'
      : componentStates.every((item) => item === 'ready')
        ? 'ready'
        : componentStates.some((item) => item === 'degraded' || item === 'ready')
          ? 'degraded'
          : 'progressing';
  return { actions: deduplicateActions(actions), components: statuses, state };
}

function deduplicateActions(actions: ReconciliationAction[]): ReconciliationAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = JSON.stringify(action);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
