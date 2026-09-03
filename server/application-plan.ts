import type { ApplicationSpec } from './application-spec.ts';

type MetadataSpec = ApplicationSpec['metadata'];
type ConfigurationSpec = ApplicationSpec['configuration'][string];
type ComponentSpec = ApplicationSpec['components'][string];
type ComponentRolloutSpec = ComponentSpec['rollout'];
type ComponentSiteOverridesSpec = ComponentSpec['siteOverrides'];
type ComponentCapacitySpec = ComponentSpec['capacity'];
type ComponentPlacementSpec = ComponentSpec['placement'];
type BuildSpec = NonNullable<ComponentSpec['build']>;
type InterfaceSpec = ComponentSpec['interfaces'][string];
type ValueReferenceSpec = ComponentSpec['environment'][string];
type MountSpec = ComponentSpec['mounts'][string];
type HealthSpec = NonNullable<ComponentSpec['health']>;
type RuntimeSpec = ComponentSpec['runtime'];
type NetworkSpec = RuntimeSpec['networks'][number];
type ResourceSpec = ApplicationSpec['resources'][string];
type ResourceSourceSpec = NonNullable<ResourceSpec['source']>;
type ResourceReconciliationSpec = NonNullable<ResourceSpec['reconciliation']>;
type ResourceBackupSpec = ResourceSpec['backup'];
type ResourceSuitcaseSpec = ResourceSpec['suitcase'];
type RouteSpec = ApplicationSpec['routes'][string];
type RouteCacheSpec = NonNullable<RouteSpec['cache']>;
type JobSpec = ApplicationSpec['jobs'][string];

export type ApplicationChangeClassification =
  | 'no-op'
  | 'metadata-update'
  | 'configuration-declaration-change'
  | 'component-create'
  | 'component-remove'
  | 'component-recreate'
  | 'component-rolling-restart'
  | 'component-scale'
  | 'route-update'
  | 'job-update'
  | 'resource-create'
  | 'resource-remove'
  | 'resource-recreate'
  | 'resource-incompatible-change'
  | 'unsupported-change';

export type ApplicationChangeEffect =
  | 'none'
  | 'configuration'
  | 'in-place'
  | 'restart'
  | 'rolling'
  | 'creation'
  | 'migration'
  | 'retention'
  | 'quarantine'
  | 'destructive'
  | 'unsupported';

export interface ApplicationChangePlanningContext {
  source?: 'yaml' | 'repository' | 'ui' | 'catalog' | 'compose-import' | 'offline-candidate';
  targetSiteId?: string;
  targetSiteKind?: 'coordinator' | 'node' | 'suitcase';
  /** Undefined means replica inventory was unavailable; [] proves there are no suitcase replicas. */
  suitcaseSiteIds?: readonly string[];
  verifiedBackup?: boolean;
  /** Explicit runtime disposition for removed resources; public graph edits default to delete. */
  resourceRemovalPolicy?: 'delete' | 'retain' | 'quarantine';
}

export interface ApplicationChangeAction {
  classification: ApplicationChangeClassification;
  effect: ApplicationChangeEffect;
  /** JSON Pointer to the stable graph identity affected by this action. */
  address: string;
  /** Exact changed graph fields, also expressed as JSON Pointers. */
  changedAddresses: string[];
  reason: string;
  requiresApproval: boolean;
  destructive: boolean;
  restartRequired: boolean;
  /** A blocked action cannot be applied even if an administrator approves other actions. */
  blocked: boolean;
}

export interface ApplicationChangePlan {
  actions: ApplicationChangeAction[];
  source: NonNullable<ApplicationChangePlanningContext['source']>;
  requiresApproval: boolean;
  destructive: boolean;
  restartRequired: boolean;
  blocked: boolean;
  impacts: {
    capacity: {
      currentInstances: number;
      desiredInstances: number;
      addedInstances: number;
      removedInstances: number;
      rollingSurgeInstances: number;
      peakInstances: number;
      revalidationRequired: boolean;
    };
    downtime: {
      expectation: 'none' | 'rolling' | 'required';
      components: string[];
      reason: string;
    };
    backup: {
      disposition: 'not-required' | 'recommended' | 'required';
      resources: string[];
      verified: boolean | null;
    };
    data: {
      effect: 'none' | 'create' | 'preserve' | 'retain' | 'quarantine' | 'destructive';
      preservedResources: string[];
      createdResources: string[];
      removedResources: string[];
      recreatedResources: string[];
    };
    suitcase: {
      disposition: 'none' | 'unknown' | 'revalidation-required';
      sites: string[];
      reasons: string[];
    };
  };
}

/**
 * Compare two normalized ApplicationSpec revisions without reading or mutating runtime state.
 *
 * Logical map keys are stable identities. In particular, a resource rename is intentionally
 * represented as remove + create until the public manifest has an explicit move declaration.
 */
export function planApplicationChange(
  current: ApplicationSpec,
  desired: ApplicationSpec,
  context: ApplicationChangePlanningContext = {},
): ApplicationChangePlan {
  const actions: ApplicationChangeAction[] = [];

  actions.push(...unsupportedShapeActions(current, desired));

  if (current.apiVersion !== desired.apiVersion) {
    actions.push(
      action({
        classification: 'unsupported-change',
        address: '/apiVersion',
        changedAddresses: ['/apiVersion'],
        reason: `Changing apiVersion from ${JSON.stringify(current.apiVersion)} to ${JSON.stringify(desired.apiVersion)} is not supported by this planner`,
        requiresApproval: true,
        blocked: true,
      }),
    );
  }
  if (current.kind !== desired.kind) {
    actions.push(
      action({
        classification: 'unsupported-change',
        address: '/kind',
        changedAddresses: ['/kind'],
        reason: `Changing kind from ${JSON.stringify(current.kind)} to ${JSON.stringify(desired.kind)} is not supported by this planner`,
        requiresApproval: true,
        blocked: true,
      }),
    );
  }

  const metadataChanges = diffAddresses(current.metadata, desired.metadata, ['metadata']);
  if (metadataChanges.length > 0) {
    actions.push(
      action({
        classification: 'metadata-update',
        address: '/metadata',
        changedAddresses: metadataChanges,
        reason: `Update application metadata at ${formatAddresses(metadataChanges)}`,
      }),
    );
  }

  for (const key of unionKeys(current.configuration, desired.configuration)) {
    const before = current.configuration[key];
    const after = desired.configuration[key];
    if (semanticEqual(before, after)) continue;
    const address = pointer(['configuration', key]);
    const changes = diffAddresses(before, after, ['configuration', key]);
    const reason = !before
      ? `Add configuration declaration ${JSON.stringify(key)}`
      : !after
        ? `Remove configuration declaration ${JSON.stringify(key)}`
        : `Update configuration declaration ${JSON.stringify(key)} at ${formatAddresses(changes)}`;
    actions.push(
      action({
        classification: 'configuration-declaration-change',
        effect: 'configuration',
        address,
        changedAddresses: changes,
        reason,
      }),
    );
  }

  for (const key of unionKeys(current.components, desired.components)) {
    const before = current.components[key];
    const after = desired.components[key];
    const address = pointer(['components', key]);
    if (!before && after) {
      actions.push(
        action({
          classification: 'component-create',
          effect: 'creation',
          address,
          changedAddresses: [address],
          reason: `Create component ${JSON.stringify(key)} with ${after.instances} desired instance${after.instances === 1 ? '' : 's'}`,
        }),
      );
      continue;
    }
    if (before && !after) {
      actions.push(
        action({
          classification: 'component-remove',
          effect: 'restart',
          address,
          changedAddresses: [address],
          reason: `Remove component ${JSON.stringify(key)} and stop its ${before.instances} desired instance${before.instances === 1 ? '' : 's'}`,
        }),
      );
      continue;
    }
    if (!before || !after || semanticEqual(before, after)) continue;

    const changedFields = changedTopLevelFields(before, after);
    if (before.instances !== after.instances) {
      actions.push(
        action({
          classification: 'component-scale',
          address,
          changedAddresses: [pointer(['components', key, 'instances'])],
          reason: `Scale component ${JSON.stringify(key)} from ${before.instances} to ${after.instances} desired instances`,
        }),
      );
    }

    const nonScaleFields = changedFields.filter((field) => field !== 'instances');
    if (nonScaleFields.length === 0) continue;
    const allChanges = diffAddresses(before, after, ['components', key]).filter(
      (changedAddress) => changedAddress !== pointer(['components', key, 'instances']),
    );
    const passiveFields: ReadonlySet<keyof ComponentSpec> = new Set([
      'displayName',
      'minimumReady',
      'rollout',
      'siteOverrides',
    ]);
    const passive = nonScaleFields.filter((field) => passiveFields.has(field));
    if (passive.length > 0) {
      const changes = allChanges.filter((changedAddress) =>
        passive.some((field) => changedAddress.startsWith(pointer(['components', key, field]))),
      );
      actions.push(
        action({
          classification: 'metadata-update',
          address,
          changedAddresses: changes,
          reason: `Update component presentation or rollout policy for ${JSON.stringify(key)} at ${formatAddresses(changes)}`,
        }),
      );
    }
    const executableFields = nonScaleFields.filter((field) => !passiveFields.has(field));
    if (executableFields.length === 0) continue;
    const changes = allChanges.filter((changedAddress) =>
      executableFields.some((field) =>
        changedAddress.startsWith(pointer(['components', key, field])),
      ),
    );
    const recreateFields: ReadonlySet<keyof ComponentSpec> = new Set([
      'role',
      'profile',
      'interfaces',
      'configurationFiles',
      'mounts',
      'runtime',
      'capacity',
      'placement',
    ]);
    const recreate =
      after.rollout.strategy !== 'rolling' ||
      executableFields.some((field) => recreateFields.has(field));
    actions.push(
      action({
        classification: recreate ? 'component-recreate' : 'component-rolling-restart',
        effect: recreate ? 'restart' : 'rolling',
        address,
        changedAddresses: changes,
        reason: recreate
          ? `${after.rollout.strategy === 'maintenance' ? 'Enter maintenance and recreate' : 'Recreate'} component ${JSON.stringify(key)} because its executable or placement contract changed at ${formatAddresses(changes)}`
          : `Roll component ${JSON.stringify(key)} because its executable configuration changed at ${formatAddresses(changes)}`,
        restartRequired: true,
      }),
    );
  }

  for (const key of unionKeys(current.routes, desired.routes)) {
    const before = current.routes[key];
    const after = desired.routes[key];
    if (semanticEqual(before, after)) continue;
    const address = pointer(['routes', key]);
    const changes = diffAddresses(before, after, ['routes', key]);
    const reason = !before
      ? `Publish route ${JSON.stringify(key)}`
      : !after
        ? `Withdraw route ${JSON.stringify(key)}`
        : `Update route ${JSON.stringify(key)} at ${formatAddresses(changes)}`;
    actions.push(
      action({
        classification: 'route-update',
        address,
        changedAddresses: changes,
        reason,
      }),
    );
  }

  for (const key of unionKeys(current.jobs, desired.jobs)) {
    const before = current.jobs[key];
    const after = desired.jobs[key];
    if (semanticEqual(before, after)) continue;
    const address = pointer(['jobs', key]);
    const changes = diffAddresses(before, after, ['jobs', key]);
    const reason = !before
      ? `Add lifecycle job ${JSON.stringify(key)}`
      : !after
        ? `Remove lifecycle job ${JSON.stringify(key)}`
        : `Update lifecycle job ${JSON.stringify(key)} at ${formatAddresses(changes)}`;
    actions.push(
      action({
        classification: 'job-update',
        effect: before?.beforeTraffic || after?.beforeTraffic ? 'migration' : 'in-place',
        address,
        changedAddresses: changes,
        reason,
      }),
    );
  }

  for (const key of unionKeys(current.resources, desired.resources)) {
    const before = current.resources[key];
    const after = desired.resources[key];
    const address = pointer(['resources', key]);
    if (!before && after) {
      actions.push(
        action({
          classification: 'resource-create',
          effect: 'creation',
          address,
          changedAddresses: [address],
          reason: `Create ${after.durability} volume resource ${JSON.stringify(key)}. Logical keys are stable identities; this does not preserve data from a removed resource`,
        }),
      );
      continue;
    }
    if (before && !after) {
      const removalPolicy = context.resourceRemovalPolicy ?? 'delete';
      actions.push(
        action({
          classification: 'resource-remove',
          effect:
            removalPolicy === 'retain'
              ? 'retention'
              : removalPolicy === 'quarantine'
                ? 'quarantine'
                : 'destructive',
          address,
          changedAddresses: [address],
          reason:
            removalPolicy === 'delete'
              ? `Remove ${before.durability} volume resource ${JSON.stringify(key)}. An explicit future move declaration is required to preserve state when changing a resource key`
              : `${removalPolicy === 'retain' ? 'Retain' : 'Quarantine'} ${before.durability} volume resource ${JSON.stringify(key)} after withdrawing it from the active graph`,
          requiresApproval: true,
          destructive: removalPolicy === 'delete',
        }),
      );
      continue;
    }
    if (!before || !after || semanticEqual(before, after)) continue;

    const changes = diffAddresses(before, after, ['resources', key]);
    const durable = before.durability === 'durable' || after.durability === 'durable';
    actions.push(
      action({
        classification: durable ? 'resource-incompatible-change' : 'resource-recreate',
        effect: durable ? 'destructive' : 'restart',
        address,
        changedAddresses: changes,
        reason: durable
          ? `Durable volume resource ${JSON.stringify(key)} changed incompatibly at ${formatAddresses(changes)}; state preservation must be planned and verified explicitly`
          : `Recreate non-durable volume resource ${JSON.stringify(key)} because it changed at ${formatAddresses(changes)}`,
        requiresApproval: durable,
        destructive: durable,
        restartRequired: true,
      }),
    );
  }

  const sortedActions = deduplicateAndSort(actions);
  if (sortedActions.length === 0) {
    sortedActions.push(
      action({
        classification: 'no-op',
        address: '/',
        changedAddresses: [],
        reason: 'Current and desired application specifications are semantically identical',
      }),
    );
  }

  return {
    actions: sortedActions,
    source: context.source ?? 'yaml',
    requiresApproval: sortedActions.some((item) => item.requiresApproval),
    destructive: sortedActions.some((item) => item.destructive),
    restartRequired: sortedActions.some((item) => item.restartRequired),
    blocked: sortedActions.some((item) => item.blocked),
    impacts: applicationChangeImpacts(current, desired, sortedActions, context),
  };
}

function action(
  input: Pick<
    ApplicationChangeAction,
    'classification' | 'address' | 'changedAddresses' | 'reason'
  > &
    Partial<
      Pick<
        ApplicationChangeAction,
        'effect' | 'requiresApproval' | 'destructive' | 'restartRequired' | 'blocked'
      >
    >,
): ApplicationChangeAction {
  return {
    ...input,
    effect: input.effect ?? effectForClassification(input.classification),
    changedAddresses: [...input.changedAddresses].sort(),
    requiresApproval: input.requiresApproval ?? false,
    destructive: input.destructive ?? false,
    restartRequired: input.restartRequired ?? false,
    blocked: input.blocked ?? false,
  };
}

function effectForClassification(
  classification: ApplicationChangeClassification,
): ApplicationChangeEffect {
  if (classification === 'no-op') return 'none';
  if (classification === 'configuration-declaration-change') return 'configuration';
  if (classification === 'component-create' || classification === 'resource-create') {
    return 'creation';
  }
  if (classification === 'component-rolling-restart') return 'rolling';
  if (classification === 'component-recreate' || classification === 'resource-recreate') {
    return 'restart';
  }
  if (classification === 'resource-remove' || classification === 'resource-incompatible-change') {
    return 'destructive';
  }
  if (classification === 'unsupported-change') return 'unsupported';
  return 'in-place';
}

function applicationChangeImpacts(
  current: ApplicationSpec,
  desired: ApplicationSpec,
  actions: readonly ApplicationChangeAction[],
  context: ApplicationChangePlanningContext,
): ApplicationChangePlan['impacts'] {
  const currentInstances = totalInstances(current);
  const desiredInstances = totalInstances(desired);
  const rollingComponents = actions
    .filter(
      (item) =>
        item.classification === 'component-rolling-restart' ||
        item.classification === 'component-recreate',
    )
    .map((item) => pointerKey(item.address, 'components'))
    .filter((item): item is string => Boolean(item));
  const rollingSurgeInstances = rollingComponents.reduce(
    (total, component) =>
      total +
      (desired.components[component]?.rollout.strategy === 'rolling'
        ? desired.components[component]!.rollout.maxSurge
        : 0),
    0,
  );
  const capacityActions = actions.filter((item) =>
    ['component-create', 'component-remove', 'component-scale'].includes(item.classification),
  );

  const createdResources = resourceKeys(actions, 'resource-create');
  const removedResources = resourceKeys(actions, 'resource-remove');
  const recreatedResources = resourceKeys(actions, [
    'resource-recreate',
    'resource-incompatible-change',
  ]);
  const preservedResources = Object.keys(current.resources)
    .filter(
      (resource) =>
        Boolean(desired.resources[resource]) &&
        !removedResources.includes(resource) &&
        !recreatedResources.includes(resource),
    )
    .sort();
  const destructiveResources = [...removedResources, ...recreatedResources].filter(
    (resource) =>
      current.resources[resource]?.durability === 'durable' ||
      desired.resources[resource]?.durability === 'durable',
  );
  const removalPolicy = context.resourceRemovalPolicy ?? 'delete';
  const dataEffect =
    removalPolicy === 'retain' &&
    (removedResources.length > 0 ||
      (preservedResources.length > 0 && actions.some((item) => item.effect !== 'none')))
      ? 'retain'
      : removalPolicy === 'quarantine' &&
          (removedResources.length > 0 ||
            (preservedResources.length > 0 && actions.some((item) => item.effect !== 'none')))
        ? 'quarantine'
        : destructiveResources.length > 0
          ? 'destructive'
          : createdResources.length > 0
            ? 'create'
            : preservedResources.length > 0 && actions.some((item) => item.effect !== 'none')
              ? 'preserve'
              : 'none';

  const downtimeComponents = actions
    .filter((item) =>
      ['component-remove', 'component-recreate', 'component-rolling-restart'].includes(
        item.classification,
      ),
    )
    .map((item) => pointerKey(item.address, 'components'))
    .filter((item): item is string => Boolean(item))
    .sort();
  const requiredDowntime =
    destructiveResources.length > 0 ||
    actions.some((item) => {
      const component = pointerKey(item.address, 'components');
      if (!component) return false;
      return (
        item.classification === 'component-remove' ||
        (item.classification === 'component-recreate' &&
          (desired.components[component]?.rollout.strategy !== 'rolling' ||
            Math.max(
              current.components[component]?.instances ?? 0,
              desired.components[component]?.instances ?? 0,
            ) <= 1))
      );
    });
  const rollingDowntime = downtimeComponents.length > 0 && !requiredDowntime;
  const downtimeExpectation = requiredDowntime ? 'required' : rollingDowntime ? 'rolling' : 'none';

  const durableResources = Object.entries(current.resources)
    .filter(([, resource]) => resource.durability === 'durable')
    .map(([resource]) => resource)
    .sort();
  const backupDisposition =
    destructiveResources.length > 0 && removalPolicy === 'delete'
      ? 'required'
      : durableResources.length > 0 &&
          actions.some((item) => item.restartRequired || item.effect === 'migration')
        ? 'recommended'
        : 'not-required';
  const backupResources =
    backupDisposition === 'required'
      ? destructiveResources.sort()
      : backupDisposition === 'recommended'
        ? durableResources
        : [];

  const suitcaseRelevant = actions.some(
    (item) => item.effect !== 'none' && item.classification !== 'metadata-update',
  );
  const knownSuitcaseSites = [
    ...(context.suitcaseSiteIds ?? []),
    ...(context.targetSiteKind === 'suitcase' && context.targetSiteId
      ? [context.targetSiteId]
      : []),
  ].filter((site, index, sites) => sites.indexOf(site) === index);
  const suitcaseDisposition = !suitcaseRelevant
    ? 'none'
    : knownSuitcaseSites.length > 0
      ? 'revalidation-required'
      : context.suitcaseSiteIds
        ? 'none'
        : 'unknown';

  return {
    capacity: {
      currentInstances,
      desiredInstances,
      addedInstances: Math.max(0, desiredInstances - currentInstances),
      removedInstances: Math.max(0, currentInstances - desiredInstances),
      rollingSurgeInstances,
      peakInstances: Math.max(currentInstances, desiredInstances) + rollingSurgeInstances,
      revalidationRequired: capacityActions.length > 0 || rollingSurgeInstances > 0,
    },
    downtime: {
      expectation: downtimeExpectation,
      components: downtimeComponents,
      reason:
        downtimeExpectation === 'required'
          ? 'A singleton runtime or durable data boundary must be withdrawn during this change.'
          : downtimeExpectation === 'rolling'
            ? 'Affected replicated components can rotate behind their stable service identities.'
            : 'No runtime withdrawal is implied by this graph change.',
    },
    backup: {
      disposition: backupDisposition,
      resources: backupResources,
      verified: backupDisposition === 'not-required' ? null : (context.verifiedBackup ?? null),
    },
    data: {
      effect: dataEffect,
      preservedResources,
      createdResources,
      removedResources,
      recreatedResources,
    },
    suitcase: {
      disposition: suitcaseDisposition,
      sites: knownSuitcaseSites.sort(),
      reasons:
        suitcaseDisposition === 'revalidation-required'
          ? [
              'Revalidate runtime, build, capacity, data, and access readiness on affected suitcases.',
            ]
          : suitcaseDisposition === 'unknown'
            ? ['Suitcase replica inventory was not supplied to this preview.']
            : [],
    },
  };
}

function totalInstances(spec: ApplicationSpec): number {
  return Object.values(spec.components).reduce(
    (total, component) => total + component.instances,
    0,
  );
}

function resourceKeys(
  actions: readonly ApplicationChangeAction[],
  classifications: ApplicationChangeClassification | readonly ApplicationChangeClassification[],
): string[] {
  const accepted = new Set(Array.isArray(classifications) ? classifications : [classifications]);
  return actions
    .filter((item) => accepted.has(item.classification))
    .map((item) => pointerKey(item.address, 'resources'))
    .filter((item): item is string => Boolean(item))
    .sort();
}

function pointerKey(address: string, collection: 'components' | 'resources'): string | undefined {
  const prefix = `/${collection}/`;
  if (!address.startsWith(prefix)) return undefined;
  const encoded = address.slice(prefix.length).split('/')[0];
  return encoded.replaceAll('~1', '/').replaceAll('~0', '~');
}

export function emptyApplicationSpec(name: string): ApplicationSpec {
  return {
    apiVersion: 'deploy.local/v1',
    kind: 'Application',
    metadata: { name, labels: {} },
    configuration: {},
    components: {},
    resources: {},
    routes: {},
    jobs: {},
  };
}

function deduplicateAndSort(actions: ApplicationChangeAction[]): ApplicationChangeAction[] {
  const byIdentity = new Map<string, ApplicationChangeAction>();
  for (const item of actions) {
    const identity = `${item.address}\0${item.classification}\0${item.reason}`;
    if (!byIdentity.has(identity)) byIdentity.set(identity, item);
  }
  return [...byIdentity.values()].sort(
    (left, right) =>
      compareStrings(left.address, right.address) ||
      compareStrings(left.classification, right.classification) ||
      compareStrings(left.reason, right.reason),
  );
}

function compareStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unionKeys<T>(left: Record<string, T>, right: Record<string, T>): string[] {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
}

function changedTopLevelFields<T extends object>(left: T, right: T): Array<keyof T> {
  return unionKeys(left as Record<string, unknown>, right as Record<string, unknown>).filter(
    (key) => !semanticEqual(left[key as keyof T], right[key as keyof T]),
  ) as Array<keyof T>;
}

function diffAddresses(left: unknown, right: unknown, path: Array<string | number>): string[] {
  if (semanticEqual(left, right)) return [];
  if (isRecord(left) && isRecord(right)) {
    const changes: string[] = [];
    for (const key of unionKeys(left, right)) {
      if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) {
        changes.push(pointer([...path, key]));
      } else {
        changes.push(...diffAddresses(left[key], right[key], [...path, key]));
      }
    }
    return changes.sort();
  }
  return [pointer(path)];
}

function formatAddresses(addresses: string[]): string {
  return addresses.join(', ');
}

function pointer(path: Array<string | number>): string {
  if (path.length === 0) return '/';
  return `/${path.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}

function semanticEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'undefined';
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ROOT_FIELDS: Record<keyof ApplicationSpec, true> = {
  apiVersion: true,
  kind: true,
  metadata: true,
  configuration: true,
  components: true,
  resources: true,
  routes: true,
  jobs: true,
};
const METADATA_FIELDS: Record<keyof MetadataSpec, true> = {
  name: true,
  description: true,
  labels: true,
};
const CONFIGURATION_FIELDS: Record<keyof ConfigurationSpec, true> = {
  type: true,
  required: true,
  description: true,
  default: true,
  allowedValues: true,
  scope: true,
};
const COMPONENT_FIELDS: Record<keyof ComponentSpec, true> = {
  displayName: true,
  image: true,
  build: true,
  role: true,
  instances: true,
  minimumReady: true,
  rollout: true,
  siteOverrides: true,
  capacity: true,
  placement: true,
  profile: true,
  command: true,
  interfaces: true,
  environment: true,
  configurationFiles: true,
  mounts: true,
  dependsOn: true,
  health: true,
  runtime: true,
};
const COMPONENT_ROLLOUT_FIELDS: Record<keyof ComponentRolloutSpec, true> = {
  strategy: true,
  maxSurge: true,
  maxUnavailable: true,
  schemaOverlap: true,
};
const COMPONENT_SITE_OVERRIDE_FIELDS: Record<keyof ComponentSiteOverridesSpec, true> = {
  allowed: true,
  minimum: true,
  maximum: true,
};
const COMPONENT_CAPACITY_FIELDS: Record<keyof ComponentCapacitySpec, true> = {
  memoryBytes: true,
  cpuMillicores: true,
  ephemeralStorageBytes: true,
  buildMemoryBytes: true,
};
const COMPONENT_PLACEMENT_FIELDS: Record<keyof ComponentPlacementSpec, true> = {
  intent: true,
  requiredLabels: true,
};
const BUILD_FIELDS: Record<keyof BuildSpec, true> = {
  context: true,
  dockerfile: true,
  target: true,
  ignore: true,
};
const INTERFACE_FIELDS: Record<keyof InterfaceSpec, true> = { port: true, protocol: true };
const VALUE_REFERENCE_FIELDS: Record<keyof ValueReferenceSpec, true> = { from: true };
const MOUNT_FIELDS: Record<keyof MountSpec, true> = { resource: true, readOnly: true };
const HEALTH_FIELDS: Record<keyof HealthSpec, true> = { interface: true, path: true };
const RUNTIME_FIELDS: Record<keyof RuntimeSpec, true> = {
  gpus: true,
  privileged: true,
  privilegedDocker: true,
  networkMode: true,
  devices: true,
  runArgs: true,
  networks: true,
};
const NETWORK_FIELDS: Record<keyof NetworkSpec, true> = {
  name: true,
  driver: true,
  subnet: true,
  labels: true,
};
const RESOURCE_FIELDS: Record<keyof ResourceSpec, true> = {
  type: true,
  displayName: true,
  durability: true,
  dataRole: true,
  access: true,
  consistencyGroup: true,
  ownership: true,
  backup: true,
  suitcase: true,
  source: true,
  reconciliation: true,
};
const RESOURCE_SOURCE_FIELDS: Record<keyof ResourceSourceSpec, true> = {
  type: true,
  hostPath: true,
};
const RESOURCE_RECONCILIATION_FIELDS: Record<keyof ResourceReconciliationSpec, true> = {
  excludeTables: true,
  excludePaths: true,
  conflictPolicy: true,
};
const RESOURCE_BACKUP_FIELDS: Record<keyof ResourceBackupSpec, true> = {
  policy: true,
  retentionCopies: true,
};
const RESOURCE_SUITCASE_FIELDS: Record<keyof ResourceSuitcaseSpec, true> = {
  allowedDataModes: true,
};
const ROUTE_FIELDS: Record<keyof RouteSpec, true> = {
  to: true,
  hostname: true,
  path: true,
  discoverable: true,
  cache: true,
};
const ROUTE_CACHE_FIELDS: Record<keyof RouteCacheSpec, true> = {
  enabled: true,
  maxAge: true,
  paths: true,
  maxObjectBytes: true,
};
const JOB_FIELDS: Record<keyof JobSpec, true> = {
  component: true,
  command: true,
  environment: true,
  execution: true,
  beforeTraffic: true,
};

interface UnsupportedShapeFinding {
  address: string;
  detail: string;
}

function unsupportedShapeActions(
  current: ApplicationSpec,
  desired: ApplicationSpec,
): ApplicationChangeAction[] {
  const findings = new Map<string, Set<string>>();
  for (const [side, spec] of [
    ['current', current],
    ['desired', desired],
  ] as const) {
    for (const finding of collectUnsupportedShape(spec)) {
      const details = findings.get(finding.address) ?? new Set<string>();
      details.add(`${side}: ${finding.detail}`);
      findings.set(finding.address, details);
    }
  }
  return [...findings.entries()].map(([address, details]) =>
    action({
      classification: 'unsupported-change',
      address,
      changedAddresses: [address],
      reason: `The planner cannot safely classify ${address} (${[...details].sort().join('; ')}); planning is blocked until this field is supported`,
      requiresApproval: true,
      blocked: true,
    }),
  );
}

function collectUnsupportedShape(spec: ApplicationSpec): UnsupportedShapeFinding[] {
  const findings: UnsupportedShapeFinding[] = [];
  checkFields(spec, ROOT_FIELDS, [], findings);
  checkFields(spec.metadata, METADATA_FIELDS, ['metadata'], findings);

  for (const [key, declaration] of sortedEntries(spec.configuration)) {
    checkFields(declaration, CONFIGURATION_FIELDS, ['configuration', key], findings);
  }
  for (const [key, component] of sortedEntries(spec.components)) {
    const base = ['components', key];
    checkFields(component, COMPONENT_FIELDS, base, findings);
    checkFields(component.rollout, COMPONENT_ROLLOUT_FIELDS, [...base, 'rollout'], findings);
    checkFields(
      component.siteOverrides,
      COMPONENT_SITE_OVERRIDE_FIELDS,
      [...base, 'siteOverrides'],
      findings,
    );
    checkFields(component.capacity, COMPONENT_CAPACITY_FIELDS, [...base, 'capacity'], findings);
    checkFields(component.placement, COMPONENT_PLACEMENT_FIELDS, [...base, 'placement'], findings);
    if (component.build) checkFields(component.build, BUILD_FIELDS, [...base, 'build'], findings);
    for (const [name, value] of sortedEntries(component.interfaces)) {
      checkFields(value, INTERFACE_FIELDS, [...base, 'interfaces', name], findings);
    }
    for (const [name, value] of sortedEntries(component.environment)) {
      checkFields(value, VALUE_REFERENCE_FIELDS, [...base, 'environment', name], findings);
    }
    for (const [name, value] of sortedEntries(component.mounts)) {
      checkFields(value, MOUNT_FIELDS, [...base, 'mounts', name], findings);
    }
    if (component.health) {
      checkFields(component.health, HEALTH_FIELDS, [...base, 'health'], findings);
    }
    checkFields(component.runtime, RUNTIME_FIELDS, [...base, 'runtime'], findings);
    component.runtime.networks.forEach((network, index) => {
      checkFields(network, NETWORK_FIELDS, [...base, 'runtime', 'networks', index], findings);
    });
  }
  for (const [key, resource] of sortedEntries(spec.resources)) {
    const base = ['resources', key];
    checkFields(resource, RESOURCE_FIELDS, base, findings);
    checkFields(resource.backup, RESOURCE_BACKUP_FIELDS, [...base, 'backup'], findings);
    checkFields(resource.suitcase, RESOURCE_SUITCASE_FIELDS, [...base, 'suitcase'], findings);
    if (resource.source) {
      checkFields(resource.source, RESOURCE_SOURCE_FIELDS, [...base, 'source'], findings);
    }
    if (resource.reconciliation) {
      checkFields(
        resource.reconciliation,
        RESOURCE_RECONCILIATION_FIELDS,
        [...base, 'reconciliation'],
        findings,
      );
    }
  }
  for (const [key, route] of sortedEntries(spec.routes)) {
    const base = ['routes', key];
    checkFields(route, ROUTE_FIELDS, base, findings);
    if (route.cache) checkFields(route.cache, ROUTE_CACHE_FIELDS, [...base, 'cache'], findings);
  }
  for (const [key, job] of sortedEntries(spec.jobs)) {
    const base = ['jobs', key];
    checkFields(job, JOB_FIELDS, base, findings);
    for (const [name, value] of sortedEntries(job.environment)) {
      checkFields(value, VALUE_REFERENCE_FIELDS, [...base, 'environment', name], findings);
    }
  }
  return findings;
}

function checkFields<T extends object>(
  value: T,
  supportedFields: Record<keyof T, true>,
  path: Array<string | number>,
  findings: UnsupportedShapeFinding[],
): void {
  for (const key of Object.keys(value).sort()) {
    if (!Object.hasOwn(supportedFields, key)) {
      findings.push({
        address: pointer([...path, key]),
        detail: `unknown field ${JSON.stringify(key)}`,
      });
    }
  }
}

function sortedEntries<T>(value: Record<string, T>): Array<[string, T]> {
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
}
