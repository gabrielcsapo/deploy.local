import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  compileDeployYaml,
  type ApplicationSpec,
  type CompiledApplicationSpec,
  type ValueReference,
} from './application-spec.ts';

export interface PortMapping {
  container: number;
  protocol?: string;
}

export interface VolumeMountConfig {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

export interface DeployConfig {
  port?: number;
  ports?: PortMapping[];
  discoverable?: boolean;
  gpus?: boolean;
  volumes?: VolumeMountConfig[];
  privilegedDocker?: boolean;
  ignore?: string[];
  cache?: {
    enabled: boolean;
    maxAge: number;
    paths: string[];
    maxObjectBytes: number;
  };
  docker?: {
    runArgs: string[];
    networks: Array<{
      name: string;
      driver?: string;
      subnet?: string;
      labels: Record<string, string>;
    }>;
  };
}

export type DeploymentDefinitionFormat = 'deploy.yaml';

export interface LegacyRuntimeAdapter {
  componentName: string;
  deployConfig: DeployConfig;
  environment: Record<string, ValueReference>;
}

export interface DeploymentDefinition {
  format: DeploymentDefinitionFormat;
  /** Original manifest text. Null means the v1 graph was generated from zero-config defaults. */
  source: string | null;
  compiled: CompiledApplicationSpec;
  /** Present only when the graph can also be executed by the compatibility one-container path. */
  legacyRuntime: LegacyRuntimeAdapter | null;
}

interface DiscoveredManifest {
  path: string;
}
const SAFE_DOCKER_RUN_ARGS = new Map<string, 0 | 1>([
  ['--dns', 1],
  ['--dns-search', 1],
  ['--dns-option', 1],
  ['--label', 1],
  ['-l', 1],
  ['--read-only', 0],
  ['--init', 0],
  ['--stop-signal', 1],
  ['--stop-timeout', 1],
]);

export function validateSafeDockerRunArgs(args: string[], path: string): void {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const separator = argument.indexOf('=');
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const arity = SAFE_DOCKER_RUN_ARGS.get(flag);
    if (arity === undefined) {
      throw new Error(
        `${path} cannot use Docker argument "${flag}"; declare ports, mounts, networks, environment, devices, privileges, GPU, and resource limits through their typed fields`,
      );
    }
    if (arity === 0) {
      if (separator !== -1) throw new Error(`${path} argument "${flag}" does not accept a value`);
      continue;
    }
    if (separator !== -1) {
      const value = argument.slice(separator + 1);
      if (value.length === 0) {
        throw new Error(`${path} argument "${flag}" requires a value`);
      }
      validateReservedDockerLabel(flag, value, path);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('-')) {
      throw new Error(`${path} argument "${flag}" requires a value`);
    }
    validateReservedDockerLabel(flag, value, path);
    index++;
  }
}

function validateReservedDockerLabel(flag: string, value: string, path: string): void {
  if (flag !== '--label' && flag !== '-l') return;
  const key = value.split('=', 1)[0].toLowerCase();
  if (key.startsWith('deploy-sh.')) {
    throw new Error(`${path} cannot override reserved Docker label "${key}"`);
  }
}

export function readDeployConfig(dir: string): DeployConfig {
  const manifest = discoverDeploymentManifest(dir);
  if (!manifest) return {};
  const definition = readDeploymentDefinition(dir);
  return (
    definition.legacyRuntime?.deployConfig ?? graphCompatibilityConfig(definition.compiled.spec)
  );
}

export function readDeploymentDefinition(dir: string): DeploymentDefinition {
  const manifest = discoverDeploymentManifest(dir);
  if (!manifest) throw new Error('deploy.yaml is required');
  const source = readFileSync(manifest.path, 'utf-8');
  const compiled = compileDeployYaml(source);
  for (const [componentName, component] of Object.entries(compiled.spec.components)) {
    validateSafeDockerRunArgs(
      component.runtime.runArgs,
      `deploy.yaml.components.${componentName}.runtime.runArgs`,
    );
  }
  return {
    format: 'deploy.yaml',
    source,
    compiled,
    legacyRuntime: tryAdaptApplicationSpecToLegacyRuntime(compiled.spec),
  };
}

function tryAdaptApplicationSpecToLegacyRuntime(
  spec: ApplicationSpec,
): LegacyRuntimeAdapter | null {
  try {
    return adaptApplicationSpecToLegacyRuntime(spec);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith(
        'deploy.yaml cannot be materialized by the current single-container executor:',
      )
    ) {
      return null;
    }
    throw error;
  }
}

/** Compatibility projection used by edge cache discovery; graph execution ignores this object. */
function graphCompatibilityConfig(spec: ApplicationSpec): DeployConfig {
  const publicRoute = spec.routes.public ?? Object.values(spec.routes)[0];
  const components = Object.values(spec.components);
  const config: DeployConfig = {
    discoverable: publicRoute?.discoverable,
    gpus: components.some((component) => component.runtime.gpus),
    privilegedDocker: components.some((component) => component.runtime.privilegedDocker),
  };
  if (publicRoute?.cache)
    config.cache = { ...publicRoute.cache, paths: [...publicRoute.cache.paths] };
  return config;
}

function discoverDeploymentManifest(dir: string): DiscoveredManifest | null {
  const yamlPath = resolve(dir, 'deploy.yaml');
  return existsSync(yamlPath) ? { path: yamlPath } : null;
}

export function adaptApplicationSpecToLegacyRuntime(spec: ApplicationSpec): LegacyRuntimeAdapter {
  const unsupported: string[] = [];
  const componentEntries = Object.entries(spec.components);

  if (componentEntries.length !== 1) {
    unsupported.push(
      `the single-container executor requires exactly one component (found ${componentEntries.length})`,
    );
  }
  if (Object.keys(spec.jobs).length > 0) {
    unsupported.push('jobs require the graph executor');
  }
  if (componentEntries.length !== 1) throwUnsupportedGraph(unsupported);

  const [componentName, component] = componentEntries[0];
  if (!component.build) unsupported.push(`component "${componentName}" must use a local build`);
  if (component.image) unsupported.push(`image-only component "${componentName}" is not supported`);
  if (component.profile)
    unsupported.push(`component profile "${component.profile}" is not supported`);
  if (component.instances !== 1) {
    unsupported.push(
      `component "${componentName}" requests ${component.instances} instances; only one is supported`,
    );
  }
  if (component.command) unsupported.push('component command overrides require the graph executor');
  if (component.health) unsupported.push('component health checks require the graph executor');
  if (component.dependsOn.length > 0) {
    unsupported.push('component dependencies require the graph executor');
  }
  if (component.build) {
    if (component.build.context !== '.') unsupported.push('build.context must be "."');
    if (component.build.dockerfile) unsupported.push('custom build.dockerfile is not supported');
    if (component.build.target) unsupported.push('build.target is not supported');
  }
  try {
    validateSafeDockerRunArgs(component.runtime.runArgs, 'runtime.runArgs');
  } catch (error) {
    unsupported.push((error as Error).message);
  }

  for (const [variable, reference] of Object.entries(component.environment)) {
    if (!reference.from.startsWith('configuration.')) {
      unsupported.push(
        `environment variable "${variable}" uses component binding "${reference.from}"; only configuration references are supported`,
      );
    }
  }

  const routeEntries = Object.entries(spec.routes);
  if (routeEntries.length !== 1) {
    unsupported.push(`exactly one HTTP route is required (found ${routeEntries.length})`);
  }

  const publicRoute = spec.routes.public;
  if (routeEntries.length === 1 && !publicRoute) {
    unsupported.push(`the single supported route must be named "public"`);
  }

  let primaryInterfaceName: string | undefined;
  if (publicRoute) {
    const [targetComponent, targetInterface, ...rest] = publicRoute.to.split('.');
    if (rest.length > 0 || targetComponent !== componentName || !targetInterface) {
      unsupported.push(`route "public" must target an interface on component "${componentName}"`);
    } else {
      primaryInterfaceName = targetInterface;
      const primaryInterface = component.interfaces[targetInterface];
      if (!primaryInterface) {
        unsupported.push(`route "public" targets unknown interface "${publicRoute.to}"`);
      } else if (primaryInterface.protocol !== 'http') {
        unsupported.push(`route "public" must target an HTTP interface`);
      }
    }
    if (publicRoute.hostname) unsupported.push('custom route hostnames require the graph executor');
    if (publicRoute.path !== '/') unsupported.push('route paths require the graph executor');
  }

  const volumes: VolumeMountConfig[] = [];
  const mountedResources = new Set<string>();
  for (const [containerPath, mount] of Object.entries(component.mounts)) {
    const resource = spec.resources[mount.resource];
    mountedResources.add(mount.resource);
    if (!resource?.source || resource.source.type !== 'bind') {
      unsupported.push(
        `volume resource "${mount.resource}" must use a bind source for the single-container executor`,
      );
      continue;
    }
    volumes.push({
      hostPath: resource.source.hostPath,
      containerPath,
      readOnly: mount.readOnly || undefined,
    });
  }
  for (const resourceName of Object.keys(spec.resources)) {
    if (!mountedResources.has(resourceName)) {
      unsupported.push(`unused volume resource "${resourceName}" cannot be materialized safely`);
    }
  }

  const primaryInterface = primaryInterfaceName
    ? component.interfaces[primaryInterfaceName]
    : undefined;
  const ports: PortMapping[] = [];
  const seenPorts = new Set<number>();
  if (primaryInterface) seenPorts.add(primaryInterface.port);
  for (const [interfaceName, providedInterface] of Object.entries(component.interfaces)) {
    if (interfaceName === primaryInterfaceName) continue;
    if (seenPorts.has(providedInterface.port)) {
      unsupported.push(
        `interface "${interfaceName}" duplicates container port ${providedInterface.port}`,
      );
      continue;
    }
    seenPorts.add(providedInterface.port);
    ports.push({
      container: providedInterface.port,
      protocol: providedInterface.protocol === 'udp' ? 'udp' : 'tcp',
    });
  }

  if (unsupported.length > 0) throwUnsupportedGraph(unsupported);

  const deployConfig: DeployConfig = {
    port: primaryInterface!.port,
    discoverable: publicRoute!.discoverable,
    gpus: component.runtime.gpus,
    privilegedDocker: component.runtime.privilegedDocker,
  };
  if (ports.length > 0) deployConfig.ports = ports;
  if (volumes.length > 0) deployConfig.volumes = volumes;
  if (component.build!.ignore.length > 0) deployConfig.ignore = [...component.build!.ignore];
  if (publicRoute!.cache) {
    deployConfig.cache = { ...publicRoute!.cache, paths: [...publicRoute!.cache.paths] };
  }
  if (component.runtime.runArgs.length > 0 || component.runtime.networks.length > 0) {
    deployConfig.docker = {
      runArgs: [...component.runtime.runArgs],
      networks: component.runtime.networks.map((network) => ({
        ...network,
        labels: { ...network.labels },
      })),
    };
  }

  return {
    componentName,
    deployConfig,
    environment: Object.fromEntries(
      Object.entries(component.environment).map(([key, value]) => [key, { ...value }]),
    ),
  };
}

function throwUnsupportedGraph(issues: string[]): never {
  throw new Error(
    `deploy.yaml cannot be materialized by the current single-container executor:\n- ${issues.join('\n- ')}`,
  );
}
