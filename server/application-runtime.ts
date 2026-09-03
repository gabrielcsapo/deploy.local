import {
  adaptApplicationSpecToLegacyRuntime,
  readDeployConfig,
  type DeployConfig,
} from './deploy-config.ts';
import { parseStoredApplicationSpec, type ApplicationSpec } from './application-spec.ts';
import {
  planApplicationExecution,
  type ApplicationExecutionOptions,
  type ApplicationExecutionPlan,
} from './application-execution.ts';
import { resolvePlacementTarget } from './application-placement-target.ts';
import {
  resolveApplicationConfiguration,
  resolveComponentEnvironment,
} from './application-configuration.ts';
import {
  getApplicationSpecRevision,
  getComponentSiteOverrides,
  getDeploymentEnvVars,
  getDeploymentVolumes,
  type VolumeMount,
} from './store.ts';

interface RuntimeDeployment {
  name: string;
  appId?: string | null;
  directory?: string | null;
  activeNodeId?: string | null;
  desiredNodeId?: string | null;
  activeSpecDigest?: string | null;
  gpuEnabled?: boolean | null;
  privilegedDocker?: boolean | null;
}

export interface ResolvedDeploymentRuntime {
  format: 'deploy.yaml' | 'legacy';
  spec: ApplicationSpec | null;
  config: DeployConfig;
  environment: Record<string, string>;
  volumes: VolumeMount[];
  gpuEnabled: boolean;
  privilegedDocker: boolean;
  configurationDigest: string | null;
  ready: boolean;
  missing: string[];
}

export interface ResolvedApplicationGraphRuntime {
  format: 'application-spec';
  spec: ApplicationSpec;
  execution: ApplicationExecutionPlan;
  configurationDigest: string;
  /** Internal executor input. API projections must always redact this object. */
  configurationValues: Readonly<Record<string, string | number | boolean | null>>;
  /** Concrete values are internal executor inputs and are never part of the normalized spec. */
  componentEnvironment: Readonly<Record<string, Readonly<Record<string, string>>>>;
  ready: boolean;
  missing: readonly string[];
}

export interface ApplicationGraphRuntimeInput {
  applicationId: string;
  specDigest: string;
  spec: ApplicationSpec;
  configuration: {
    digest: string;
    values: Readonly<Record<string, string | number | boolean | null>>;
    missing: readonly string[];
  };
  siteId?: string;
  options?: Omit<ApplicationExecutionOptions, 'specDigest' | 'unresolvedConfiguration'>;
}

/** Resolve runtime inputs from the immutable active release, never the desired working tree. */
export function resolveDeploymentRuntime(deployment: RuntimeDeployment): ResolvedDeploymentRuntime {
  const revision = deployment.activeSpecDigest
    ? getApplicationSpecRevision(deployment.name, deployment.activeSpecDigest)
    : null;

  if (revision?.manifestFormat === 'deploy.yaml') {
    const spec = parseStoredApplicationSpec(revision.normalizedSpec);
    const adapter = adaptApplicationSpecToLegacyRuntime(spec);
    const siteId = deployment.activeNodeId || deployment.desiredNodeId || 'coordinator';
    const configuration = resolveApplicationConfiguration({
      deploymentName: deployment.name,
      specDigest: revision.digest,
      declarations: spec.configuration,
      siteId,
    });
    if (!configuration.ready) {
      return {
        format: 'deploy.yaml',
        spec,
        config: adapter.deployConfig,
        environment: {},
        volumes: [],
        gpuEnabled: adapter.deployConfig.gpus ?? false,
        privilegedDocker: adapter.deployConfig.privilegedDocker ?? false,
        configurationDigest: configuration.digest,
        ready: false,
        missing: configuration.missing,
      };
    }

    const componentEnvironment = resolveComponentEnvironment({
      spec,
      component: adapter.componentName,
      configuration: configuration.values,
    });
    if (componentEnvironment.unresolvedBindings.length > 0) {
      throw new Error(
        `Active application bindings are unresolved: ${componentEnvironment.unresolvedBindings.join(', ')}`,
      );
    }

    return {
      format: 'deploy.yaml',
      spec,
      config: adapter.deployConfig,
      environment: componentEnvironment.environment,
      volumes: (adapter.deployConfig.volumes || []).map((volume) => ({ ...volume })),
      gpuEnabled: adapter.deployConfig.gpus ?? false,
      privilegedDocker: adapter.deployConfig.privilegedDocker ?? false,
      configurationDigest: configuration.digest,
      ready: true,
      missing: [],
    };
  }

  const config = deployment.directory ? readDeployConfig(deployment.directory) : {};
  return {
    format: 'legacy',
    spec: null,
    config,
    environment: getDeploymentEnvVars(deployment.name),
    volumes: getDeploymentVolumes(deployment.name),
    gpuEnabled: config.gpus ?? deployment.gpuEnabled ?? false,
    privilegedDocker: config.privilegedDocker ?? deployment.privilegedDocker ?? false,
    configurationDigest: null,
    ready: true,
    missing: [],
  };
}

/**
 * Resolve the general graph executor contract from an immutable active revision. Unlike the legacy
 * compatibility resolver above, this path has no one-component, local-build, or single-instance
 * boundary. Physical node executors consume the returned plan and report actual instance state to
 * the reconciler.
 */
export function resolveApplicationGraphRuntime(
  deployment: RuntimeDeployment,
  options: Omit<ApplicationExecutionOptions, 'specDigest' | 'unresolvedConfiguration'> = {},
): ResolvedApplicationGraphRuntime {
  if (!deployment.activeSpecDigest) {
    throw new Error(
      `Deployment ${JSON.stringify(deployment.name)} has no active application revision`,
    );
  }
  const revision = getApplicationSpecRevision(deployment.name, deployment.activeSpecDigest);
  if (!revision) {
    throw new Error(
      `Active application revision ${JSON.stringify(deployment.activeSpecDigest)} was not found for ${JSON.stringify(deployment.name)}`,
    );
  }
  const spec = parseStoredApplicationSpec(revision.normalizedSpec);
  const applicationId = deployment.appId || deployment.name;
  const siteId = deployment.activeNodeId || deployment.desiredNodeId || 'coordinator';
  const configuration = resolveApplicationConfiguration({
    deploymentName: deployment.name,
    specDigest: revision.digest,
    declarations: spec.configuration,
    siteId,
  });
  return buildApplicationGraphRuntime({
    applicationId,
    specDigest: revision.digest,
    spec,
    configuration,
    siteId,
    options: {
      ...options,
      targetSiteId: siteId,
      siteInstanceOverrides: getComponentSiteOverrides(applicationId, siteId),
    },
  });
}

/** Build the executor contract for a validated desired revision before it is promoted active. */
export function buildApplicationGraphRuntime(
  input: ApplicationGraphRuntimeInput,
): ResolvedApplicationGraphRuntime {
  const { applicationId, specDigest, spec, configuration } = input;
  const targetSiteId = input.siteId ?? input.options?.targetSiteId;
  const execution = planApplicationExecution(applicationId, spec, {
    ...input.options,
    specDigest,
    unresolvedConfiguration: new Set(configuration.missing),
    placementTarget:
      input.options?.placementTarget ??
      (targetSiteId ? resolvePlacementTarget(targetSiteId) : undefined),
    ...(input.siteId
      ? {
          targetSiteId: input.siteId,
          siteInstanceOverrides:
            input.options?.siteInstanceOverrides ??
            getComponentSiteOverrides(applicationId, input.siteId),
        }
      : {}),
  });
  const bindings = Object.fromEntries(
    Object.entries(execution.services).map(([reference, service]) => [
      reference,
      serviceBindingValue(
        applicationId,
        service.component,
        service.containerPort,
        service.protocol,
      ),
    ]),
  );
  const componentEnvironment: Record<string, Record<string, string>> = {};
  for (const componentName of execution.componentOrder) {
    const component = spec.components[componentName];
    const environment: Record<string, string> = {};
    for (const [variable, reference] of Object.entries(component.environment)) {
      const [owner, member] = reference.from.split('.');
      if (owner === 'configuration') {
        if (Object.hasOwn(configuration.values, member)) {
          environment[variable] = String(configuration.values[member]);
        }
      } else {
        environment[variable] = bindings[reference.from];
      }
    }
    componentEnvironment[componentName] = environment;
  }

  return {
    format: 'application-spec',
    spec,
    execution,
    configurationDigest: configuration.digest,
    configurationValues: configuration.values,
    componentEnvironment,
    ready: !execution.blocked,
    missing: configuration.missing,
  };
}

function serviceBindingValue(
  applicationId: string,
  component: string,
  port: number,
  protocol: string,
): string {
  const host = `${component}.${applicationId}.internal`;
  if (protocol === 'http' || protocol === 'https') return `${protocol}://${host}:${port}`;
  return `${host}:${port}`;
}
