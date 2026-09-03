import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { resolve, sep } from 'node:path';
import type { ApplicationExecutionPlan, ComponentExecutionPlan } from './application-execution.ts';
import type { ApplicationSpec } from './application-spec.ts';

/** Authenticated coordinator-to-agent contract for one admitted node-local graph revision. */
export interface AgentApplicationGraphPayload {
  version: 1;
  applicationId: string;
  siteId: string;
  writerSiteId: string | null;
  specDigest: string;
  configurationDigest: string;
  spec: ApplicationSpec;
  execution: ApplicationExecutionPlan;
  configurationValues: Readonly<Record<string, string | number | boolean | null>>;
  componentEnvironment: Readonly<Record<string, Readonly<Record<string, string>>>>;
  profileValues: Readonly<Record<string, Readonly<Record<string, string>>>>;
  runtimeVolumeMounts?: readonly {
    component: string;
    hostPath: string;
    containerPath: string;
    readOnly?: boolean;
  }[];
}

export interface AgentGraphCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface AgentGraphDocker {
  run(
    args: readonly string[],
    options?: { onOutput?: (output: string) => void },
  ): Promise<AgentGraphCommandResult>;
}

export interface AgentGraphExecutionInput {
  deploymentName: string;
  jobId: string;
  sourceDirectory: string;
  volumeDirectory: string;
  statePath: string;
  artifactSpecDigest: string;
  artifactSpec: ApplicationSpec;
  graph: AgentApplicationGraphPayload;
  memoryLimit?: string;
  cpuLimit?: string;
  noCache?: boolean;
  healthTimeoutMs?: number;
  onBuildOutput?: (output: string) => void;
  onProgress?: (stage: string, message: string) => void | Promise<void>;
  /** Deterministic health transport used by tests; production probes the target-local port. */
  probePort?: (port: number, protocol: string, path: string) => Promise<boolean>;
}

export interface AgentGraphInstanceResult {
  id: string;
  component: string;
  slot: string;
  containerId: string;
  containerName: string;
  image: string;
  hostPorts: Readonly<Record<number, number>>;
  releaseDigest: string;
  configurationDigest: string;
}

export interface AgentGraphRouteResult {
  name: string;
  component: string;
  interface: string;
  protocol: string;
  path: string;
  hostname?: string;
  discoverable: boolean;
  containerPort: number;
  endpoints: readonly {
    instanceId: string;
    containerName: string;
    dockerPort: number;
  }[];
}

export interface AgentGraphJobResult {
  key: string;
  job: string;
  component: string;
  scope: ApplicationSpec['jobs'][string]['execution'];
  instanceId: string | null;
  executed: boolean;
}

export interface AgentGraphExecutionResult {
  type: 'application-graph';
  applicationId: string;
  specDigest: string;
  configurationDigest: string;
  network: string;
  primaryContainerId: string | null;
  primaryContainerName: string | null;
  primaryDockerPort: number | null;
  primaryRoute: AgentGraphRouteResult | null;
  instances: readonly AgentGraphInstanceResult[];
  routes: readonly AgentGraphRouteResult[];
  jobs: readonly AgentGraphJobResult[];
}

interface AgentGraphState {
  version: 1;
  completedJobs: string[];
}

interface PreparedComponent {
  plan: ComponentExecutionPlan;
  image: string;
  releaseDigest: string;
}

/**
 * Materialize one authenticated application graph on a connected execution agent. The executor is
 * deliberately node-local: all siblings share one private Docker network and managed resources
 * live under the agent volume root so the existing encrypted backup/restore jobs carry them too.
 */
export async function executeAgentApplicationGraph(
  input: AgentGraphExecutionInput,
  docker: AgentGraphDocker,
): Promise<AgentGraphExecutionResult> {
  validateAgentGraphPayload(input.graph, input.artifactSpecDigest, input.artifactSpec);
  const graph = input.graph;
  const network = graphNetworkName(graph.applicationId);
  const privateGraph = Object.values(graph.execution.components).some(
    (component) => component.runtime.networkMode === 'private',
  );
  if (privateGraph) {
    await ensureDockerObject(docker, 'network', network, [
      'network',
      'create',
      '--label',
      `deploy-sh.app=${input.deploymentName}`,
      '--label',
      `deploy-sh.app-id=${graph.applicationId}`,
      '--label',
      'deploy-sh.private-network=true',
      network,
    ]);
  }

  const providers = new Map<string, { source: string; type: 'bind' | 'volume' }>();
  for (const [resourceName, resource] of Object.entries(graph.spec.resources)) {
    if (resource.source?.type === 'bind') {
      providers.set(resourceName, { source: resource.source.hostPath, type: 'bind' });
      continue;
    }
    // Legacy repository deployments have always persisted their two platform-managed
    // mounts directly beneath the deployment volume root. Keep those stable identities
    // when the application is migrated to a graph so adopting the graph does not attach
    // an empty replacement directory in front of existing data.
    const source =
      resourceName === 'data' || resourceName === 'uploads'
        ? resolve(input.volumeDirectory, resourceName)
        : resolve(input.volumeDirectory, 'graph', safeIdentifier(resourceName));
    mkdirSync(source, { recursive: true, mode: 0o700 });
    providers.set(resourceName, { source, type: 'bind' });
  }

  const prepared = new Map<string, PreparedComponent>();
  for (const componentName of graph.execution.componentOrder) {
    const component = graph.execution.components[componentName];
    await input.onProgress?.('building graph', `Preparing ${component.displayName}`);
    const releaseDigest = componentReleaseDigest(graph.spec, componentName);
    const image = await prepareComponentImage(input, docker, component, releaseDigest);
    prepared.set(componentName, { plan: component, image, releaseDigest });
  }

  const previous = await listGraphContainers(docker, input.deploymentName);
  const stoppedPrevious: string[] = [];
  const created: AgentGraphInstanceResult[] = [];
  try {
    for (const componentName of graph.execution.componentOrder) {
      const preparedComponent = prepared.get(componentName)!;
      const component = preparedComponent.plan;
      if (requiresExclusiveReplacement(component, graph.spec)) {
        for (const name of previous.filter((item) => item.component === componentName)) {
          await docker.run(['stop', name.name]);
          stoppedPrevious.push(name.name);
        }
      }
      for (let index = 0; index < component.desiredInstances; index += 1) {
        const slot =
          component.slots[index] ?? `${graph.applicationId}/${componentName}/${index + 1}`;
        const instance = await createGraphInstance({
          input,
          docker,
          component,
          image: preparedComponent.image,
          releaseDigest: preparedComponent.releaseDigest,
          slot,
          index,
          network,
          providers,
        });
        created.push(instance);
      }
    }

    const completedJobs = await runGraphJobs(input, docker, created, prepared, network, providers);
    const routes = graphRoutes(graph, created);
    const primaryRoute = routes[0] ?? null;
    const primaryEndpoint = primaryRoute?.endpoints[0];
    const primaryInstance = primaryEndpoint
      ? created.find((item) => item.id === primaryEndpoint.instanceId)
      : (created[0] ?? null);

    for (const old of previous) {
      await docker.run(['rm', '-f', old.name]);
    }

    return {
      type: 'application-graph',
      applicationId: graph.applicationId,
      specDigest: graph.specDigest,
      configurationDigest: graph.configurationDigest,
      network,
      primaryContainerId: primaryInstance?.containerId ?? null,
      primaryContainerName: primaryInstance?.containerName ?? null,
      primaryDockerPort: primaryEndpoint?.dockerPort ?? null,
      primaryRoute,
      instances: created,
      routes,
      jobs: completedJobs,
    };
  } catch (error) {
    for (const instance of created) await docker.run(['rm', '-f', instance.containerName]);
    for (const name of stoppedPrevious) await docker.run(['start', name]);
    throw error;
  }
}

export function validateAgentGraphPayload(
  graph: AgentApplicationGraphPayload,
  artifactSpecDigest: string,
  artifactSpec?: ApplicationSpec,
): void {
  if (!graph || graph.version !== 1) throw new Error('Agent graph payload version is invalid');
  if (!/^sha256:[a-f0-9]{64}$/.test(graph.specDigest)) {
    throw new Error('Agent graph payload has no immutable spec digest');
  }
  if (graph.specDigest !== artifactSpecDigest) {
    throw new Error('Agent graph payload does not match the downloaded deploy.yaml revision');
  }
  if (artifactSpec && canonicalJson(graph.spec) !== canonicalJson(artifactSpec)) {
    throw new Error('Agent graph specification does not match the downloaded deploy.yaml revision');
  }
  if (graph.execution.specDigest !== graph.specDigest || graph.execution.blocked) {
    throw new Error('Agent graph payload was not admitted by the coordinator');
  }
  const names = Object.keys(graph.spec.components).sort();
  const order = [...graph.execution.componentOrder];
  if (order.length !== names.length || [...order].sort().join('\0') !== names.join('\0')) {
    throw new Error('Agent graph component order is incomplete');
  }
  const visited = new Set<string>();
  for (const name of order) {
    const component = graph.execution.components[name];
    if (!component || component.blocked || !Number.isInteger(component.desiredInstances)) {
      throw new Error(`Agent graph component ${JSON.stringify(name)} is not admitted`);
    }
    if (
      component.desiredInstances < component.siteOverrides.minimum ||
      component.desiredInstances > component.siteOverrides.maximum
    ) {
      throw new Error(`Agent graph component ${JSON.stringify(name)} has an invalid site count`);
    }
    if (component.dependencies.some((dependency) => !visited.has(dependency))) {
      throw new Error(
        `Agent graph component ${JSON.stringify(name)} is ordered before a dependency`,
      );
    }
    visited.add(name);
  }
}

async function prepareComponentImage(
  input: AgentGraphExecutionInput,
  docker: AgentGraphDocker,
  component: ComponentExecutionPlan,
  releaseDigest: string,
): Promise<string> {
  if (component.source.kind === 'image') {
    const inspected = await docker.run(['image', 'inspect', component.source.reference]);
    if (inspected.exitCode !== 0) {
      const pulled = await docker.run(['pull', component.source.reference], {
        onOutput: input.onBuildOutput,
      });
      assertCommand(pulled, `Pulling ${component.source.reference}`);
    }
    return component.source.reference;
  }
  const image = graphImageTag(input.graph.applicationId, component.name, releaseDigest);
  const context = containedPath(input.sourceDirectory, component.source.context);
  const args = ['build', '--tag', image];
  if (input.noCache) args.push('--no-cache');
  if (component.source.dockerfile) {
    args.push('--file', containedPath(context, component.source.dockerfile));
  }
  if (component.source.target) args.push('--target', component.source.target);
  args.push(context);
  const result = await docker.run(args, { onOutput: input.onBuildOutput });
  assertCommand(result, `Building ${component.name}`);
  return image;
}

async function createGraphInstance(input: {
  input: AgentGraphExecutionInput;
  docker: AgentGraphDocker;
  component: ComponentExecutionPlan;
  image: string;
  releaseDigest: string;
  slot: string;
  index: number;
  network: string;
  providers: ReadonlyMap<string, { source: string; type: 'bind' | 'volume' }>;
}): Promise<AgentGraphInstanceResult> {
  const { graph } = input.input;
  const jobSuffix = createHash('sha256').update(input.input.jobId).digest('hex').slice(0, 12);
  const instanceId = `${input.component.name}/${input.index + 1}/${jobSuffix}`;
  const containerName = boundedDockerName(
    `deploy-sh-${input.input.deploymentName}-${input.component.name}-${input.index + 1}-${jobSuffix.slice(0, 8)}`,
  );
  const environment = componentEnvironment(graph, input.component, 'runtime');
  const configurationMounts = writeConfigurationFiles(input.input, input.component);
  const publishedPorts = componentPublishedPorts(graph, input.component);
  const args = [
    'create',
    '--name',
    containerName,
    '--network',
    input.component.runtime.networkMode === 'host' ? 'host' : input.network,
  ];
  if (input.component.runtime.networkMode === 'private') {
    args.push('--network-alias', input.component.name);
    args.push(
      '--network-alias',
      `${input.component.name}.${graph.applicationId}.internal`
        .toLowerCase()
        .replace(/[^a-z0-9.-]/g, '-'),
    );
    for (const port of publishedPorts) args.push('--publish', `127.0.0.1::${port}`);
  }
  args.push('--restart', 'unless-stopped');
  const memory = input.component.capacity.memoryBytes
    ? `${input.component.capacity.memoryBytes}b`
    : input.input.memoryLimit;
  const cpu = input.component.capacity.cpuMillicores
    ? String(input.component.capacity.cpuMillicores / 1000)
    : input.input.cpuLimit;
  if (memory) args.push('--memory', memory);
  if (cpu) args.push('--cpus', cpu);
  if (input.component.runtime.gpus) args.push('--gpus', 'all');
  if (input.component.runtime.privileged) args.push('--privileged');
  if (input.component.runtime.privilegedDocker) {
    args.push('--volume', '/var/run/docker.sock:/var/run/docker.sock');
  }
  for (const device of input.component.runtime.devices) {
    args.push('--device', `${device.hostPath}:${device.containerPath}:${device.permissions}`);
  }
  for (const [key, value] of Object.entries(environment)) args.push('--env', `${key}=${value}`);
  for (const [target, mount] of Object.entries(input.component.mounts)) {
    const provider = input.providers.get(mount.resource);
    if (!provider) throw new Error(`Graph volume ${JSON.stringify(mount.resource)} is unavailable`);
    args.push(
      '--mount',
      `type=${provider.type},src=${provider.source},dst=${target}${mount.readOnly ? ',readonly' : ''}`,
    );
  }
  for (const mount of graph.runtimeVolumeMounts ?? []) {
    if (mount.component !== input.component.name) continue;
    if (input.component.mounts[mount.containerPath]) {
      throw new Error(
        `Runtime mount ${JSON.stringify(mount.containerPath)} conflicts with an application-owned resource`,
      );
    }
    args.push(
      '--mount',
      `type=bind,src=${mount.hostPath},dst=${mount.containerPath}${mount.readOnly ? ',readonly' : ''}`,
    );
  }
  for (const mount of configurationMounts) {
    args.push('--mount', `type=bind,src=${mount.source},dst=${mount.target},readonly`);
  }
  args.push(
    '--label',
    `deploy-sh.app=${input.input.deploymentName}`,
    '--label',
    `deploy-sh.app-id=${graph.applicationId}`,
    '--label',
    `deploy-sh.component=${input.component.name}`,
    '--label',
    `deploy-sh.instance=${instanceId}`,
    '--label',
    `deploy-sh.slot=${input.slot}`,
    '--label',
    `deploy-sh.release=${input.releaseDigest}`,
  );
  args.push(...input.component.runtime.runArgs, input.image, ...(input.component.command ?? []));
  const created = await input.docker.run(args);
  assertCommand(created, `Creating ${input.component.name} instance ${input.index + 1}`);
  const containerId = created.stdout.trim();
  const started = await input.docker.run(['start', containerName]);
  assertCommand(started, `Starting ${containerName}`);
  const hostPorts = await waitForGraphHealth(
    input.docker,
    containerName,
    input.component,
    graph.profileValues[input.component.name] ?? {},
    input.input.healthTimeoutMs ?? 30_000,
    input.input.probePort,
  );
  await provisionProfile(input.docker, containerName, input.component, graph.profileValues);
  return {
    id: instanceId,
    component: input.component.name,
    slot: input.slot,
    containerId,
    containerName,
    image: input.image,
    hostPorts,
    releaseDigest: input.releaseDigest,
    configurationDigest: componentConfigurationDigest(graph, input.component.name),
  };
}

async function runGraphJobs(
  input: AgentGraphExecutionInput,
  docker: AgentGraphDocker,
  instances: readonly AgentGraphInstanceResult[],
  prepared: ReadonlyMap<string, PreparedComponent>,
  network: string,
  providers: ReadonlyMap<string, { source: string; type: 'bind' | 'volume' }>,
): Promise<AgentGraphJobResult[]> {
  const state = readGraphState(input.statePath);
  const completed = new Set(state.completedJobs);
  const results: AgentGraphJobResult[] = [];
  const orderedJobs = Object.entries(input.graph.spec.jobs).sort(
    ([leftName, left], [rightName, right]) => {
      const order =
        input.graph.execution.componentOrder.indexOf(left.component) -
        input.graph.execution.componentOrder.indexOf(right.component);
      return order || leftName.localeCompare(rightName);
    },
  );
  for (const [jobName, job] of orderedJobs) {
    if (job.execution === 'writerSite' && input.graph.writerSiteId !== input.graph.siteId) continue;
    const targets =
      job.execution === 'perInstance'
        ? instances.filter((instance) => instance.component === job.component)
        : [undefined];
    for (const target of targets) {
      const key = jobExecutionKey({
        applicationId: input.graph.applicationId,
        releaseDigest: input.graph.specDigest,
        configurationDigest: input.graph.configurationDigest,
        jobName,
        siteId: input.graph.siteId,
        instanceId: target?.id,
      });
      if (completed.has(key)) {
        results.push({
          key,
          job: jobName,
          component: job.component,
          scope: job.execution,
          instanceId: target?.id ?? null,
          executed: false,
        });
        continue;
      }
      const component = prepared.get(job.component);
      if (!component) throw new Error(`Job ${JSON.stringify(jobName)} has no component image`);
      await input.onProgress?.('running graph jobs', `Running ${jobName}`);
      const args = [
        'run',
        '--rm',
        '--name',
        boundedDockerName(`deploy-sh-${input.deploymentName}-job-${jobName}-${key.slice(-8)}`),
        '--network',
        component.plan.runtime.networkMode === 'host' ? 'host' : network,
      ];
      const environment = {
        ...componentEnvironment(input.graph, component.plan, 'migration'),
        ...resolveEnvironmentReferences(input.graph, job.environment, 'migration'),
      };
      for (const [name, value] of Object.entries(environment))
        args.push('--env', `${name}=${value}`);
      for (const [targetPath, mount] of Object.entries(component.plan.mounts)) {
        const provider = providers.get(mount.resource);
        if (!provider)
          throw new Error(`Graph volume ${JSON.stringify(mount.resource)} is unavailable`);
        args.push(
          '--mount',
          `type=${provider.type},src=${provider.source},dst=${targetPath}${mount.readOnly ? ',readonly' : ''}`,
        );
      }
      args.push(
        '--label',
        `deploy-sh.app=${input.deploymentName}`,
        '--label',
        `deploy-sh.app-id=${input.graph.applicationId}`,
        '--label',
        `deploy-sh.job=${jobName}`,
        component.image,
        ...job.command,
      );
      const result = await docker.run(args);
      assertCommand(result, `Graph job ${jobName}`);
      completed.add(key);
      results.push({
        key,
        job: jobName,
        component: job.component,
        scope: job.execution,
        instanceId: target?.id ?? null,
        executed: true,
      });
      writeGraphState(input.statePath, { version: 1, completedJobs: [...completed].sort() });
    }
  }
  return results;
}

function graphRoutes(
  graph: AgentApplicationGraphPayload,
  instances: readonly AgentGraphInstanceResult[],
): AgentGraphRouteResult[] {
  return Object.values(graph.execution.routes).map((route) => {
    const service = Object.values(graph.execution.services).find(
      (candidate) => candidate.id === route.serviceId,
    );
    if (!service) throw new Error(`Graph route ${JSON.stringify(route.name)} has no service`);
    const endpoints = instances
      .filter((instance) => instance.component === service.component)
      .map((instance) => ({
        instanceId: instance.id,
        containerName: instance.containerName,
        dockerPort:
          graph.execution.components[service.component].runtime.networkMode === 'host'
            ? service.containerPort
            : (instance.hostPorts[service.containerPort] ?? 0),
      }));
    if (endpoints.some((endpoint) => !endpoint.dockerPort)) {
      throw new Error(`Graph route ${JSON.stringify(route.name)} has no published endpoint`);
    }
    return {
      name: route.name,
      component: service.component,
      interface: service.interface,
      protocol: service.protocol,
      path: route.path,
      hostname: route.hostname,
      discoverable: route.discoverable,
      containerPort: service.containerPort,
      endpoints,
    };
  });
}

function componentEnvironment(
  graph: AgentApplicationGraphPayload,
  component: ComponentExecutionPlan,
  scope: 'runtime' | 'migration' | 'backup-restore',
): Record<string, string> {
  const environment = { ...(graph.componentEnvironment[component.name] ?? {}) };
  for (const binding of component.environment) {
    if (binding.kind === 'service' && binding.requiredService) {
      environment[binding.variable] = serviceBinding(graph, binding.requiredService, scope);
    }
  }
  const values = graph.profileValues[component.name] ?? {};
  for (const declaration of component.profile?.provisionedValues ?? []) {
    const value = values[declaration.name];
    if (value === undefined) {
      throw new Error(`Profile value ${component.name}.${declaration.name} is unavailable`);
    }
    environment[declaration.environment] = value;
  }
  if (!Object.hasOwn(environment, 'PORT')) {
    const endpoint = Object.values(component.interfaces).find(
      (item) => item.protocol === 'http' || item.protocol === 'https',
    );
    if (endpoint) environment.PORT = String(endpoint.port);
  }
  return environment;
}

function resolveEnvironmentReferences(
  graph: AgentApplicationGraphPayload,
  references: Readonly<Record<string, { from: string }>>,
  scope: 'runtime' | 'migration' | 'backup-restore',
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, reference] of Object.entries(references)) {
    if (reference.from.startsWith('configuration.')) {
      const value = graph.configurationValues[reference.from.slice('configuration.'.length)];
      if (value !== undefined && value !== null) result[name] = String(value);
      continue;
    }
    const service = graph.execution.services[reference.from];
    if (!service) throw new Error(`Unknown graph binding ${JSON.stringify(reference.from)}`);
    result[name] = serviceBinding(graph, service.id, scope);
  }
  return result;
}

function serviceBinding(
  graph: AgentApplicationGraphPayload,
  serviceId: string,
  scope: 'runtime' | 'migration' | 'backup-restore',
): string {
  const service = Object.values(graph.execution.services).find((item) => item.id === serviceId);
  if (!service) throw new Error(`Unknown graph service ${JSON.stringify(serviceId)}`);
  const host = `${service.component}.${graph.applicationId}.internal`
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '-');
  const target = graph.execution.components[service.component];
  const connection = target.profile?.generatedBindings.find(
    (binding) => binding.interface === service.interface && (binding.scope ?? 'runtime') === scope,
  )?.connection;
  if (connection) {
    const values = graph.profileValues[service.component] ?? {};
    return `${connection.scheme}://${encodeURIComponent(values[connection.usernameValue])}:${encodeURIComponent(values[connection.passwordValue])}@${host}:${service.containerPort}/${encodeURIComponent(values[connection.databaseValue])}`;
  }
  if (service.protocol === 'http' || service.protocol === 'https') {
    return `${service.protocol}://${host}:${service.containerPort}`;
  }
  return `${host}:${service.containerPort}`;
}

function writeConfigurationFiles(
  input: AgentGraphExecutionInput,
  component: ComponentExecutionPlan,
): Array<{ source: string; target: string }> {
  const output: Array<{ source: string; target: string }> = [];
  const root = resolve(input.volumeDirectory, '.configuration', safeIdentifier(component.name));
  for (const [target, reference] of Object.entries(component.configurationFiles)) {
    const key = reference.from.slice('configuration.'.length);
    const value = input.graph.configurationValues[key];
    if (value === undefined || value === null) {
      throw new Error(`Configuration file ${JSON.stringify(key)} is unresolved`);
    }
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const filename = `${createHash('sha256').update(`${target}\0${input.graph.configurationDigest}`).digest('hex')}.value`;
    const source = resolve(root, filename);
    writeFileSync(source, typeof value === 'string' ? value : JSON.stringify(value), {
      mode: 0o600,
    });
    output.push({ source, target });
  }
  return output;
}

async function waitForGraphHealth(
  docker: AgentGraphDocker,
  containerName: string,
  component: ComponentExecutionPlan,
  profileValues: Readonly<Record<string, string>>,
  timeoutMs: number,
  probePort?: (port: number, protocol: string, path: string) => Promise<boolean>,
): Promise<Record<number, number>> {
  const deadline = Date.now() + timeoutMs;
  let ports: Record<number, number> = {};
  do {
    const running = await docker.run(['inspect', '--format', '{{.State.Running}}', containerName]);
    if (running.exitCode !== 0) break;
    if (running.stdout.trim() === 'true') {
      ports = await inspectPublishedPorts(docker, containerName, component);
      if (component.profile?.health) {
        const command = substituteProfile(
          component.profile.health.command,
          profileEnvironment(component, profileValues),
        );
        if ((await docker.run(['exec', containerName, ...command])).exitCode === 0) return ports;
      } else if (component.health) {
        const endpoint = component.interfaces[component.health.interface];
        const port =
          component.runtime.networkMode === 'host' ? endpoint.port : ports[endpoint.port];
        if (
          port &&
          (probePort
            ? await probePort(port, endpoint.protocol, component.health.path ?? '/')
            : endpoint.protocol === 'http' || endpoint.protocol === 'https'
              ? await probeHttp(port, component.health.path ?? '/', endpoint.protocol === 'https')
              : await probeTcp(port))
        ) {
          return ports;
        }
      } else {
        const endpoint = Object.values(component.interfaces)[0];
        if (!endpoint) return ports;
        const port =
          component.runtime.networkMode === 'host' ? endpoint.port : ports[endpoint.port];
        if (
          port &&
          (probePort ? await probePort(port, endpoint.protocol, '/') : await probeTcp(port))
        ) {
          return ports;
        }
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  } while (Date.now() < deadline);
  throw new Error(`Component ${JSON.stringify(component.name)} failed its health gate`);
}

async function inspectPublishedPorts(
  docker: AgentGraphDocker,
  containerName: string,
  component: ComponentExecutionPlan,
): Promise<Record<number, number>> {
  if (component.runtime.networkMode === 'host') return {};
  const ports: Record<number, number> = {};
  for (const port of componentPublishedPortsForPlan(component)) {
    const result = await docker.run(['port', containerName, `${port}/tcp`]);
    if (result.exitCode !== 0) continue;
    const match = result.stdout
      .trim()
      .split('\n')[0]
      ?.match(/:(\d+)$/);
    if (match) ports[port] = Number(match[1]);
  }
  return ports;
}

async function provisionProfile(
  docker: AgentGraphDocker,
  containerName: string,
  component: ComponentExecutionPlan,
  valuesByComponent: AgentApplicationGraphPayload['profileValues'],
): Promise<void> {
  if (!component.profile?.provisioning) return;
  const values = profileEnvironment(component, valuesByComponent[component.name] ?? {});
  const provision = await docker.run([
    'exec',
    containerName,
    ...substituteProfile(component.profile.provisioning.command, values),
  ]);
  assertCommand(provision, `Provisioning ${component.name}`);
  const verification = await docker.run([
    'exec',
    containerName,
    ...substituteProfile(component.profile.provisioning.verificationCommand, values),
  ]);
  assertCommand(verification, `Verifying ${component.name} provisioning`);
}

function profileEnvironment(
  component: ComponentExecutionPlan,
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    (component.profile?.provisionedValues ?? []).flatMap((declaration) =>
      values[declaration.name] === undefined
        ? []
        : [[declaration.environment, values[declaration.name]]],
    ),
  );
}

function substituteProfile(command: readonly string[], values: Readonly<Record<string, string>>) {
  return command.map((argument) =>
    argument.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`Profile variable ${key} is unavailable`);
      return value;
    }),
  );
}

function componentPublishedPorts(
  graph: AgentApplicationGraphPayload,
  component: ComponentExecutionPlan,
): number[] {
  const publishedServiceIds = new Set(
    Object.values(graph.execution.routes).map((route) => route.serviceId),
  );
  const ports = Object.values(graph.execution.services)
    .filter(
      (service) => service.component === component.name && publishedServiceIds.has(service.id),
    )
    .map((service) => service.containerPort);
  return [...new Set([...ports, ...componentPublishedPortsForPlan(component)])];
}

function componentPublishedPortsForPlan(component: ComponentExecutionPlan): number[] {
  if (component.runtime.networkMode === 'host') return [];
  if (component.health) return [component.interfaces[component.health.interface].port];
  const first = Object.values(component.interfaces)[0];
  return first ? [first.port] : [];
}

function requiresExclusiveReplacement(
  component: ComponentExecutionPlan,
  spec: ApplicationSpec,
): boolean {
  if (component.rollout.strategy !== 'rolling') return true;
  return Object.values(component.mounts).some(
    (mount) => !mount.readOnly && spec.resources[mount.resource]?.access === 'singleWriter',
  );
}

async function listGraphContainers(
  docker: AgentGraphDocker,
  deploymentName: string,
): Promise<Array<{ name: string; component: string }>> {
  const result = await docker.run([
    'ps',
    '-a',
    '--filter',
    `label=deploy-sh.app=${deploymentName}`,
    '--format',
    '{{.Names}}\t{{.Label "deploy-sh.component"}}',
  ]);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, component] = line.split('\t');
      return { name, component };
    });
}

async function ensureDockerObject(
  docker: AgentGraphDocker,
  kind: 'network' | 'volume',
  name: string,
  create: readonly string[],
): Promise<void> {
  if ((await docker.run([kind, 'inspect', name])).exitCode === 0) return;
  assertCommand(await docker.run(create), `Creating graph ${kind} ${name}`);
}

function readGraphState(path: string): AgentGraphState {
  if (!existsSync(path)) return { version: 1, completedJobs: [] };
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as AgentGraphState;
    if (value.version === 1 && Array.isArray(value.completedJobs)) return value;
  } catch {
    // A partial/corrupt state file cannot claim completed one-shot work.
  }
  return { version: 1, completedJobs: [] };
}

function writeGraphState(path: string, state: AgentGraphState): void {
  const temporary = `${path}.partial`;
  mkdirSync(resolve(path, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function jobExecutionKey(input: {
  applicationId: string;
  releaseDigest: string;
  configurationDigest: string;
  jobName: string;
  siteId: string;
  instanceId?: string;
}): string {
  return `job:${createHash('sha256')
    .update(
      JSON.stringify([
        input.applicationId,
        input.releaseDigest,
        input.configurationDigest,
        input.jobName,
        input.siteId,
        input.instanceId ?? null,
      ]),
    )
    .digest('hex')}`;
}

function componentReleaseDigest(spec: ApplicationSpec, component: string): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(spec.components[component])).digest('hex')}`;
}

function componentConfigurationDigest(
  graph: AgentApplicationGraphPayload,
  componentName: string,
): string {
  const component = graph.spec.components[componentName];
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
        Object.hasOwn(graph.configurationValues, key)
          ? graph.configurationValues[key]
          : '__missing__',
      ];
    })
    .sort(([left], [right]) => String(left).localeCompare(String(right)));
  return `sha256:${createHash('sha256').update(JSON.stringify(projected)).digest('hex')}`;
}

function graphNetworkName(applicationId: string): string {
  return boundedDockerName(`deploy-sh-${applicationId}-private`, 63);
}

function graphImageTag(applicationId: string, component: string, releaseDigest: string): string {
  return `${boundedDockerName(`deploy-sh-${applicationId}-${component}`, 80)}:${releaseDigest.replace(/^sha256:/, '').slice(0, 16)}`;
}

function boundedDockerName(value: string, maxLength = 120): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
  if (normalized.length <= maxLength) return normalized;
  const suffix = createHash('sha256').update(normalized).digest('hex').slice(0, 10);
  return `${normalized.slice(0, maxLength - suffix.length - 1)}-${suffix}`;
}

function safeIdentifier(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
  if (!normalized || normalized === '.' || normalized === '..') {
    throw new Error(`Unsafe graph identifier ${JSON.stringify(value)}`);
  }
  return normalized;
}

function containedPath(root: string, child: string): string {
  const absoluteRoot = resolve(root);
  const value = resolve(absoluteRoot, child);
  if (value !== absoluteRoot && !value.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`Build path ${JSON.stringify(child)} escapes the project directory`);
  }
  return value;
}

function assertCommand(result: AgentGraphCommandResult, action: string): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${action} failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function probeHttp(port: number, path: string, tls: boolean): Promise<boolean> {
  try {
    const response = await fetch(`${tls ? 'https' : 'http'}://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

function probeTcp(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (ready: boolean) => {
      socket.destroy();
      resolvePromise(ready);
    };
    socket.setTimeout(1_000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}
