import type { ApplicationSpec, ValueReference } from './application-spec.ts';
import { applicationSpecDigest } from './application-spec.ts';
import { postgresComponentProfile } from './component-profile-postgres.ts';
import {
  evaluateApplicationPlacement,
  type ComponentPlacementEvidence,
  type PlacementTargetEvidence,
} from './application-placement.ts';
import {
  ComponentProfileRegistry,
  type ComponentProfilePlan,
  type RuntimeAdmissionFinding,
} from './component-profiles.ts';
import {
  planVolumeAttachments,
  type VolumeAttachment,
  type VolumeAttachmentCapabilities,
} from './volume-attachments.ts';

export type ComponentExecutableSource =
  | { kind: 'image'; reference: string }
  | {
      kind: 'build';
      context: string;
      dockerfile?: string;
      target?: string;
      ignore: readonly string[];
    };

export interface ComponentEnvironmentBindingPlan {
  variable: string;
  reference: string;
  kind: 'configuration' | 'service';
  requiredService?: string;
}

export interface ComponentExecutionPlan {
  name: string;
  displayName: string;
  source: ComponentExecutableSource;
  role: ApplicationSpec['components'][string]['role'];
  desiredInstances: number;
  defaultInstances: number;
  minimumReady: number;
  rollout: ApplicationSpec['components'][string]['rollout'];
  siteOverrides: ApplicationSpec['components'][string]['siteOverrides'];
  capacity: ApplicationSpec['components'][string]['capacity'];
  placement: ApplicationSpec['components'][string]['placement'];
  slots: readonly string[];
  dependencies: readonly string[];
  explicitDependencies: readonly string[];
  command?: readonly string[];
  environment: readonly ComponentEnvironmentBindingPlan[];
  configurationFiles: NonNullable<ApplicationSpec['components'][string]['configurationFiles']>;
  interfaces: ApplicationSpec['components'][string]['interfaces'];
  mounts: ApplicationSpec['components'][string]['mounts'];
  health?: ApplicationSpec['components'][string]['health'];
  runtime: ApplicationSpec['components'][string]['runtime'];
  profile?: ComponentProfilePlan;
  blocked: boolean;
  findings: readonly RuntimeAdmissionFinding[];
}

export interface StableComponentService {
  id: string;
  applicationId: string;
  component: string;
  interface: string;
  protocol: ApplicationSpec['components'][string]['interfaces'][string]['protocol'];
  containerPort: number;
}

export interface ApplicationRoutePlan {
  name: string;
  serviceId: string;
  hostname?: string;
  path: string;
  discoverable: boolean;
  cache?: ApplicationSpec['routes'][string]['cache'];
}

export interface ApplicationExecutionPlan {
  applicationId: string;
  specDigest: string;
  componentOrder: readonly string[];
  components: Readonly<Record<string, ComponentExecutionPlan>>;
  services: Readonly<Record<string, StableComponentService>>;
  routes: Readonly<Record<string, ApplicationRoutePlan>>;
  volumeAttachments: readonly VolumeAttachment[];
  placementEvidence: readonly ComponentPlacementEvidence[];
  findings: readonly RuntimeAdmissionFinding[];
  blocked: boolean;
}

export interface ApplicationExecutionOptions {
  specDigest?: string;
  profiles?: ComponentProfileRegistry;
  profileEvidence?: Readonly<Record<string, Readonly<Record<string, string | number | boolean>>>>;
  volumeCapabilities?: VolumeAttachmentCapabilities;
  /** Missing server-side declarations, after application/site scope resolution. */
  unresolvedConfiguration?: ReadonlySet<string>;
  targetSiteId?: string;
  /** Operational fixed-count overrides; these are deliberately not revision identity. */
  siteInstanceOverrides?: Readonly<Record<string, number>>;
  /** Authenticated facts for the exact node selected by this node-local materialization. */
  placementTarget?: PlacementTargetEvidence | null;
}

export function createDefaultProfileRegistry(): ComponentProfileRegistry {
  return new ComponentProfileRegistry([postgresComponentProfile]);
}

/** Compile an immutable ApplicationSpec into a complete, deterministic component executor plan. */
export function planApplicationExecution(
  applicationId: string,
  spec: ApplicationSpec,
  options: ApplicationExecutionOptions = {},
): ApplicationExecutionPlan {
  const profiles = options.profiles ?? createDefaultProfileRegistry();
  const allFindings: RuntimeAdmissionFinding[] = [];
  const desiredInstances = resolveSiteInstanceCounts(spec, options, allFindings);
  const placement = evaluateApplicationPlacement({
    spec,
    desiredInstances,
    target: options.placementTarget,
  });
  allFindings.push(...placement.findings);
  const dependencies = inferDependencies(spec, allFindings);
  const componentOrder = topologicalOrder(spec, dependencies, allFindings);
  const volumes = planVolumeAttachments(spec, {
    ...options.volumeCapabilities,
    desiredInstances,
  });
  allFindings.push(...volumes.findings);
  const hostNetworkComponents = Object.entries(spec.components).filter(
    ([, component]) => component.runtime.networkMode === 'host',
  );
  for (const [componentName] of hostNetworkComponents) {
    if (desiredInstances[componentName] !== 1) {
      allFindings.push({
        code: 'HOST_NETWORK_REQUIRES_SINGLE_INSTANCE',
        severity: 'error',
        path: `/components/${componentName}/instances`,
        message: `Host-network component ${JSON.stringify(componentName)} must have exactly one instance because its ports cannot be isolated per replica`,
      });
    }
  }
  for (const [componentName, component] of Object.entries(spec.components)) {
    if (
      component.rollout.strategy === 'rolling' &&
      component.rollout.schemaOverlap !== 'compatible'
    ) {
      allFindings.push({
        code: 'ROLLING_SCHEMA_OVERLAP_UNSAFE',
        severity: 'error',
        path: `/components/${componentName}/rollout/schemaOverlap`,
        message: `Rolling component ${JSON.stringify(componentName)} must declare that old and new releases can safely overlap their shared schema`,
      });
    }
    if (component.minimumReady > (desiredInstances[componentName] ?? component.instances)) {
      allFindings.push({
        code: 'MINIMUM_READY_EXCEEDS_SITE_COUNT',
        severity: 'error',
        path: `/components/${componentName}/minimumReady`,
        message: `Component ${JSON.stringify(componentName)} minimumReady exceeds its target-site fixed count`,
      });
    }
  }
  if (hostNetworkComponents.length > 0 && Object.keys(spec.components).length > 1) {
    allFindings.push({
      code: 'HOST_NETWORK_GRAPH_MIXED_UNSUPPORTED',
      severity: 'error',
      path: '/components',
      message:
        'Host networking is supported only for a standalone component in v1; mixed private/host graphs do not share private service discovery safely',
    });
  }
  const graphFindings = [...allFindings];

  const services: Record<string, StableComponentService> = {};
  for (const [componentName, component] of Object.entries(spec.components)) {
    for (const [interfaceName, endpoint] of Object.entries(component.interfaces)) {
      const key = `${componentName}.${interfaceName}`;
      services[key] = {
        id: stableServiceId(applicationId, componentName, interfaceName),
        applicationId,
        component: componentName,
        interface: interfaceName,
        protocol: endpoint.protocol,
        containerPort: endpoint.port,
      };
    }
  }

  const components: Record<string, ComponentExecutionPlan> = {};
  for (const componentName of Object.keys(spec.components).sort()) {
    const component = spec.components[componentName];
    const findings = componentGraphFindings(componentName, graphFindings, volumes.attachments);
    const inheritedFindingCount = findings.length;
    let profile: ComponentProfilePlan | undefined;

    if (component.profile) {
      const handler = profiles.get(component.profile);
      if (!handler) {
        findings.push({
          code: 'COMPONENT_PROFILE_UNKNOWN',
          severity: 'error',
          path: `/components/${componentName}/profile`,
          message: `Lifecycle profile ${JSON.stringify(component.profile)} is not installed; available profiles: ${profiles.ids().join(', ') || 'none'}`,
        });
      } else {
        const result = handler.plan({
          applicationId,
          componentName,
          component,
          spec,
          evidence: options.profileEvidence?.[componentName],
        });
        profile = result.plan;
        findings.push(...result.findings);
      }
    }

    const environment = Object.entries(component.environment)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([variable, reference]) => environmentBinding(variable, reference, applicationId));
    for (const binding of environment) {
      if (
        binding.kind === 'configuration' &&
        options.unresolvedConfiguration?.has(binding.reference.slice('configuration.'.length))
      ) {
        findings.push({
          code: 'COMPONENT_CONFIGURATION_UNRESOLVED',
          severity: 'error',
          path: `/components/${componentName}/environment/${binding.variable}`,
          message: `Required server-side value ${JSON.stringify(binding.reference)} is unresolved for this site`,
        });
      }
    }
    for (const [target, reference] of Object.entries(component.configurationFiles ?? {})) {
      const key = reference.from.slice('configuration.'.length);
      if (options.unresolvedConfiguration?.has(key)) {
        findings.push({
          code: 'COMPONENT_CONFIGURATION_FILE_UNRESOLVED',
          severity: 'error',
          path: `/components/${componentName}/configurationFiles/${target}`,
          message: `Required server-side file value ${JSON.stringify(reference.from)} is unresolved for this site`,
        });
      }
    }

    const source: ComponentExecutableSource = component.image
      ? { kind: 'image', reference: component.image }
      : {
          kind: 'build',
          context: component.build!.context,
          dockerfile: component.build!.dockerfile,
          target: component.build!.target,
          ignore: component.build!.ignore,
        };
    allFindings.push(...findings.slice(inheritedFindingCount));
    components[componentName] = {
      name: componentName,
      displayName: component.displayName ?? componentName,
      source,
      role: component.role,
      desiredInstances: desiredInstances[componentName] ?? component.instances,
      defaultInstances: component.instances,
      minimumReady: Math.min(
        component.minimumReady,
        desiredInstances[componentName] ?? component.instances,
      ),
      rollout: component.rollout,
      siteOverrides: component.siteOverrides,
      capacity: component.capacity,
      placement: component.placement,
      slots: Array.from(
        { length: desiredInstances[componentName] ?? component.instances },
        (_, index) => `${applicationId}/${componentName}/${index + 1}`,
      ),
      dependencies: dependencies[componentName] ?? [],
      explicitDependencies: component.dependsOn,
      command: component.command,
      environment,
      configurationFiles: component.configurationFiles ?? {},
      interfaces: component.interfaces,
      mounts: component.mounts,
      health: component.health,
      runtime: component.runtime,
      profile,
      blocked: findings.some((item) => item.severity === 'error'),
      findings,
    };
  }

  const routes: Record<string, ApplicationRoutePlan> = {};
  for (const [routeName, route] of Object.entries(spec.routes)) {
    const service = services[route.to];
    if (!service) {
      allFindings.push({
        code: 'ROUTE_SERVICE_UNKNOWN',
        severity: 'error',
        path: `/routes/${routeName}/to`,
        message: `Route references unknown component interface ${JSON.stringify(route.to)}`,
      });
      continue;
    }
    routes[routeName] = {
      name: routeName,
      serviceId: service.id,
      hostname: route.hostname,
      path: route.path,
      discoverable: route.discoverable,
      cache: route.cache,
    };
  }

  return {
    applicationId,
    specDigest: options.specDigest ?? applicationSpecDigest(spec),
    componentOrder,
    components,
    services,
    routes,
    volumeAttachments: volumes.attachments,
    placementEvidence: placement.evidence,
    findings: allFindings,
    blocked: allFindings.some((item) => item.severity === 'error'),
  };
}

function resolveSiteInstanceCounts(
  spec: ApplicationSpec,
  options: ApplicationExecutionOptions,
  findings: RuntimeAdmissionFinding[],
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [componentName, component] of Object.entries(spec.components)) {
    const override = options.siteInstanceOverrides?.[componentName];
    if (override === undefined) {
      result[componentName] = component.instances;
      continue;
    }
    if (!options.targetSiteId) {
      findings.push({
        code: 'SITE_OVERRIDE_TARGET_REQUIRED',
        severity: 'error',
        path: `/components/${componentName}/siteOverrides`,
        message: `Component ${JSON.stringify(componentName)} has an instance override without an explicit target site`,
      });
    }
    if (!component.siteOverrides.allowed) {
      findings.push({
        code: 'SITE_OVERRIDE_NOT_ALLOWED',
        severity: 'error',
        path: `/components/${componentName}/siteOverrides/allowed`,
        message: `Component ${JSON.stringify(componentName)} does not allow site-specific instance counts`,
      });
    }
    if (
      !Number.isSafeInteger(override) ||
      override < component.siteOverrides.minimum ||
      override > component.siteOverrides.maximum
    ) {
      findings.push({
        code: 'SITE_OVERRIDE_OUT_OF_BOUNDS',
        severity: 'error',
        path: `/components/${componentName}/siteOverrides`,
        message: `Component ${JSON.stringify(componentName)} site count must be between ${component.siteOverrides.minimum} and ${component.siteOverrides.maximum}`,
      });
      result[componentName] = component.instances;
    } else {
      result[componentName] = override;
    }
  }
  for (const componentName of Object.keys(options.siteInstanceOverrides ?? {})) {
    if (spec.components[componentName]) continue;
    findings.push({
      code: 'SITE_OVERRIDE_COMPONENT_UNKNOWN',
      severity: 'error',
      path: `/components/${componentName}`,
      message: `Site instance override references unknown component ${JSON.stringify(componentName)}`,
    });
  }
  return result;
}

export function stableServiceId(
  applicationId: string,
  componentName: string,
  interfaceName: string,
): string {
  return `${applicationId}/${componentName}/${interfaceName}`;
}

function environmentBinding(
  variable: string,
  reference: ValueReference,
  applicationId: string,
): ComponentEnvironmentBindingPlan {
  if (reference.from.startsWith('configuration.')) {
    return { variable, reference: reference.from, kind: 'configuration' };
  }
  const [component, interfaceName] = reference.from.split('.');
  return {
    variable,
    reference: reference.from,
    kind: 'service',
    requiredService: stableServiceId(applicationId, component, interfaceName),
  };
}

function inferDependencies(
  spec: ApplicationSpec,
  findings: RuntimeAdmissionFinding[],
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [componentName, component] of Object.entries(spec.components)) {
    const inferred = new Set(component.dependsOn);
    for (const reference of Object.values(component.environment)) {
      if (reference.from.startsWith('configuration.')) continue;
      const dependency = reference.from.split('.')[0];
      if (dependency === componentName) continue;
      if (spec.components[dependency]) {
        if (!inferred.has(dependency)) {
          findings.push({
            code: 'IMPLICIT_SERVICE_DEPENDENCY',
            severity: 'warning',
            path: `/components/${componentName}/environment`,
            message: `Binding ${JSON.stringify(reference.from)} adds an implicit dependency on component ${JSON.stringify(dependency)}`,
          });
        }
        inferred.add(dependency);
      }
    }
    result[componentName] = [...inferred].sort();
  }
  return result;
}

function topologicalOrder(
  spec: ApplicationSpec,
  dependencies: Readonly<Record<string, readonly string[]>>,
  findings: RuntimeAdmissionFinding[],
): string[] {
  const remaining = new Map<string, Set<string>>();
  for (const name of Object.keys(spec.components)) {
    const known = new Set<string>();
    for (const dependency of dependencies[name] ?? []) {
      if (!spec.components[dependency]) {
        findings.push({
          code: 'COMPONENT_DEPENDENCY_UNKNOWN',
          severity: 'error',
          path: `/components/${name}/dependsOn`,
          message: `Component ${JSON.stringify(name)} depends on unknown component ${JSON.stringify(dependency)}`,
        });
      } else {
        known.add(dependency);
      }
    }
    remaining.set(name, known);
  }

  const ordered: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(([, pending]) => pending.size === 0)
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) {
      const cycle = [...remaining.keys()].sort();
      findings.push({
        code: 'COMPONENT_DEPENDENCY_CYCLE',
        severity: 'error',
        path: '/components',
        message: `Component dependency graph contains a cycle involving: ${cycle.join(', ')}`,
      });
      return [...ordered, ...cycle];
    }
    for (const name of ready) {
      ordered.push(name);
      remaining.delete(name);
      for (const pending of remaining.values()) pending.delete(name);
    }
  }
  return ordered;
}

function componentGraphFindings(
  componentName: string,
  findings: readonly RuntimeAdmissionFinding[],
  attachments: readonly VolumeAttachment[],
): RuntimeAdmissionFinding[] {
  const componentPrefix = `/components/${componentName}`;
  const resources = new Set(
    attachments.filter((item) => item.component === componentName).map((item) => item.resource),
  );
  return findings.filter((finding) => {
    if (finding.path === '/components') return true;
    if (finding.path === componentPrefix || finding.path.startsWith(`${componentPrefix}/`)) {
      return true;
    }
    for (const resource of resources) {
      const resourcePrefix = `/resources/${resource}`;
      if (finding.path === resourcePrefix || finding.path.startsWith(`${resourcePrefix}/`)) {
        return true;
      }
    }
    return false;
  });
}
