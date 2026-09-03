import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { basename, dirname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import http from 'node:http';
import type { ComponentExecutableSource } from './application-execution.ts';
import {
  apiRemoveContainer,
  apiStartContainer,
  apiStopContainer,
  inspectContainer,
} from './docker-api.ts';

const execFileAsync = promisify(execFile);
const ARCHIVE_HELPER_IMAGE =
  'busybox:1.37@sha256:9db7b59979c38555a39def84a31fb98b5296952f9e3afd4f6f11f05b07adfab0';

export interface GraphContainerMount {
  source: string;
  target: string;
  type: 'volume' | 'bind';
  readOnly: boolean;
}

export interface GraphContainerCreateRequest {
  name: string;
  image: string;
  network: string;
  networkMode: 'private' | 'host';
  networkAliases: readonly string[];
  environment: Readonly<Record<string, string>>;
  command?: readonly string[];
  mounts: readonly GraphContainerMount[];
  publishPorts: readonly number[];
  labels: Readonly<Record<string, string>>;
  memoryLimit?: string;
  cpuLimit?: string;
  gpus?: boolean;
  privileged?: boolean;
  privilegedDocker?: boolean;
  devices: readonly {
    hostPath: string;
    containerPath: string;
    permissions: 'r' | 'rw' | 'rwm';
  }[];
  runArgs?: readonly string[];
  restart?: 'unless-stopped' | 'no';
}

export interface GraphContainerInspection {
  id: string;
  name: string;
  exists: boolean;
  running: boolean;
  status: string;
  health: 'starting' | 'healthy' | 'unhealthy' | 'none';
  hostPorts: Readonly<Record<number, number>>;
}

export type GraphHealthProbe =
  | { kind: 'running' }
  | { kind: 'http'; containerPort: number; path: string; hostNetwork?: boolean }
  | { kind: 'tcp'; containerPort: number; hostNetwork?: boolean }
  | { kind: 'command'; command: readonly string[] };

export interface GraphCommandResult {
  exitCode: number;
  output: string;
}

export interface GraphVolumeArchiveResult {
  digest: `sha256:${string}`;
  bytes: number;
}

export interface GraphDockerAdapter {
  prepareImage(input: {
    applicationId: string;
    component: string;
    releaseDigest: string;
    source: ComponentExecutableSource;
    projectDirectory: string;
    noCache?: boolean;
    /** Force Docker to execute the build even when the immutable output tag already exists. */
    forceBuild?: boolean;
    /** `none` is used for an exact target-local offline build proof. */
    networkMode?: 'default' | 'none';
  }): Promise<string>;
  ensureNetwork(
    name: string,
    labels: Readonly<Record<string, string>>,
    options?: { internal?: boolean },
  ): Promise<void>;
  ensureVolume(name: string, labels: Readonly<Record<string, string>>): Promise<void>;
  volumeExists(name: string): Promise<boolean>;
  removeNetwork(name: string): Promise<void>;
  removeVolume(name: string): Promise<void>;
  createContainer(request: GraphContainerCreateRequest): Promise<{ id: string; name: string }>;
  startContainer(name: string): Promise<void>;
  inspectContainer(name: string): Promise<GraphContainerInspection>;
  waitHealthy(name: string, probe: GraphHealthProbe, timeoutMs: number): Promise<boolean>;
  stopContainer(name: string): Promise<void>;
  removeContainer(name: string): Promise<void>;
  runOneShot(request: GraphContainerCreateRequest): Promise<GraphCommandResult>;
  exec(name: string, command: readonly string[]): Promise<GraphCommandResult>;
  copyFromContainer(name: string, containerPath: string, hostPath: string): Promise<void>;
  copyToContainer(name: string, hostPath: string, containerPath: string): Promise<void>;
  exportVolume(volume: string, archivePath: string): Promise<GraphVolumeArchiveResult>;
  verifyVolumeArchive(archivePath: string): Promise<boolean>;
  restoreVolume(volume: string, archivePath: string): Promise<void>;
}

export class DockerCliGraphAdapter implements GraphDockerAdapter {
  async prepareImage(input: {
    applicationId: string;
    component: string;
    releaseDigest: string;
    source: ComponentExecutableSource;
    projectDirectory: string;
    noCache?: boolean;
    forceBuild?: boolean;
    networkMode?: 'default' | 'none';
  }): Promise<string> {
    if (input.source.kind === 'image') {
      // Suitcase startup is offline-first: an already-materialized image is sufficient. A deploy
      // with a new immutable reference still pulls because that reference will not exist locally.
      if (!(await dockerObjectExists('image', input.source.reference))) {
        await execFileAsync('docker', ['pull', input.source.reference], {
          maxBuffer: 20 * 1024 * 1024,
        });
      }
      return input.source.reference;
    }
    const tag = graphImageTag(input.applicationId, input.component, input.releaseDigest);
    if (!input.forceBuild && !input.noCache && (await dockerObjectExists('image', tag))) return tag;
    const context = containedPath(input.projectDirectory, input.source.context);
    const args = ['build', '--tag', tag];
    if (input.networkMode === 'none') args.push('--network', 'none');
    if (input.noCache) args.push('--no-cache');
    if (input.source.dockerfile) {
      args.push('--file', containedPath(context, input.source.dockerfile));
    }
    if (input.source.target) args.push('--target', input.source.target);
    args.push(context);
    await execFileAsync('docker', args, { maxBuffer: 50 * 1024 * 1024 });
    return tag;
  }

  async ensureNetwork(
    name: string,
    labels: Readonly<Record<string, string>>,
    options: { internal?: boolean } = {},
  ): Promise<void> {
    if (await dockerObjectExists('network', name)) return;
    const args = ['network', 'create'];
    if (options.internal) args.push('--internal');
    for (const [key, value] of Object.entries(labels)) args.push('--label', `${key}=${value}`);
    args.push(name);
    try {
      await execFileAsync('docker', args);
    } catch (error) {
      if (!(await dockerObjectExists('network', name))) throw error;
    }
  }

  async ensureVolume(name: string, labels: Readonly<Record<string, string>>): Promise<void> {
    if (await dockerObjectExists('volume', name)) return;
    const args = ['volume', 'create'];
    for (const [key, value] of Object.entries(labels)) args.push('--label', `${key}=${value}`);
    args.push(name);
    try {
      await execFileAsync('docker', args);
    } catch (error) {
      if (!(await dockerObjectExists('volume', name))) throw error;
    }
  }

  async volumeExists(name: string): Promise<boolean> {
    return dockerObjectExists('volume', name);
  }

  async removeNetwork(name: string): Promise<void> {
    await execFileAsync('docker', ['network', 'rm', name]).catch(() => {});
  }

  async removeVolume(name: string): Promise<void> {
    await execFileAsync('docker', ['volume', 'rm', name]).catch(() => {});
  }

  async createContainer(
    request: GraphContainerCreateRequest,
  ): Promise<{ id: string; name: string }> {
    const args = containerArgs('create', request);
    const { stdout } = await execFileAsync('docker', args, { maxBuffer: 20 * 1024 * 1024 });
    return { id: stdout.trim(), name: request.name };
  }

  async startContainer(name: string): Promise<void> {
    await apiStartContainer(name);
  }

  async inspectContainer(name: string): Promise<GraphContainerInspection> {
    const inspection = await inspectContainer(name);
    if (!inspection) {
      return {
        id: '',
        name,
        exists: false,
        running: false,
        status: 'missing',
        health: 'none',
        hostPorts: {},
      };
    }
    const hostPorts: Record<number, number> = {};
    for (const [key, bindings] of Object.entries(inspection.NetworkSettings.Ports ?? {})) {
      const containerPort = Number.parseInt(key.split('/')[0], 10);
      const hostPort = Number.parseInt(bindings?.[0]?.HostPort ?? '', 10);
      if (Number.isInteger(containerPort) && Number.isInteger(hostPort)) {
        hostPorts[containerPort] = hostPort;
      }
    }
    const dockerHealth = inspection.State.Health?.Status;
    return {
      id: inspection.Id,
      name,
      exists: true,
      running: inspection.State.Status === 'running',
      status: inspection.State.Status,
      health:
        dockerHealth === 'healthy' || dockerHealth === 'unhealthy' || dockerHealth === 'starting'
          ? dockerHealth
          : 'none',
      hostPorts,
    };
  }

  async waitHealthy(name: string, probe: GraphHealthProbe, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      const inspection = await this.inspectContainer(name);
      if (!inspection.exists || (!inspection.running && inspection.status !== 'created')) {
        return false;
      }
      if (inspection.running && (await this.probe(name, inspection, probe))) return true;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    } while (Date.now() < deadline);
    return false;
  }

  async stopContainer(name: string): Promise<void> {
    try {
      await apiStopContainer(name);
    } catch {
      // Missing or already stopped is converged state.
    }
  }

  async removeContainer(name: string): Promise<void> {
    try {
      await apiRemoveContainer(name);
    } catch {
      // Missing is converged state.
    }
  }

  async runOneShot(request: GraphContainerCreateRequest): Promise<GraphCommandResult> {
    try {
      const { stdout, stderr } = await execFileAsync(
        'docker',
        containerArgs('run', request, true),
        {
          maxBuffer: 20 * 1024 * 1024,
        },
      );
      return { exitCode: 0, output: `${stdout}${stderr}` };
    } catch (error) {
      return commandFailure(error);
    }
  }

  async exec(name: string, command: readonly string[]): Promise<GraphCommandResult> {
    try {
      const { stdout, stderr } = await execFileAsync('docker', ['exec', name, ...command], {
        maxBuffer: 20 * 1024 * 1024,
      });
      return { exitCode: 0, output: `${stdout}${stderr}` };
    } catch (error) {
      return commandFailure(error);
    }
  }

  async copyFromContainer(name: string, containerPath: string, hostPath: string): Promise<void> {
    assertContainerFilePath(containerPath);
    const destination = resolve(hostPath);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    await execFileAsync('docker', ['cp', `${name}:${containerPath}`, destination], {
      maxBuffer: 20 * 1024 * 1024,
    });
  }

  async copyToContainer(name: string, hostPath: string, containerPath: string): Promise<void> {
    assertContainerFilePath(containerPath);
    await execFileAsync('docker', ['cp', resolve(hostPath), `${name}:${containerPath}`], {
      maxBuffer: 20 * 1024 * 1024,
    });
  }

  async exportVolume(volume: string, archivePath: string): Promise<GraphVolumeArchiveResult> {
    const { directory, filename } = archiveLocation(archivePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    await execFileAsync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--volume',
        `${volume}:/source:ro`,
        '--volume',
        `${directory}:/backup`,
        ARCHIVE_HELPER_IMAGE,
        'tar',
        '-czf',
        `/backup/${filename}`,
        '-C',
        '/source',
        '.',
      ],
      { maxBuffer: 20 * 1024 * 1024 },
    );
    return {
      digest: await fileDigest(archivePath),
      bytes: statSync(archivePath).size,
    };
  }

  async verifyVolumeArchive(archivePath: string): Promise<boolean> {
    const { directory, filename } = archiveLocation(archivePath);
    try {
      await execFileAsync(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '--volume',
          `${directory}:/backup:ro`,
          ARCHIVE_HELPER_IMAGE,
          'tar',
          '-tzf',
          `/backup/${filename}`,
        ],
        { maxBuffer: 20 * 1024 * 1024 },
      );
      return true;
    } catch {
      return false;
    }
  }

  async restoreVolume(volume: string, archivePath: string): Promise<void> {
    const { directory, filename } = archiveLocation(archivePath);
    if (!(await this.verifyVolumeArchive(archivePath))) {
      throw new Error(`Recovery archive ${JSON.stringify(filename)} failed verification`);
    }
    await execFileAsync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--volume',
        `${volume}:/target`,
        '--volume',
        `${directory}:/backup:ro`,
        ARCHIVE_HELPER_IMAGE,
        'sh',
        '-ec',
        `find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -xzf "/backup/${filename}" -C /target`,
      ],
      { maxBuffer: 20 * 1024 * 1024 },
    );
  }

  private async probe(
    name: string,
    inspection: GraphContainerInspection,
    probe: GraphHealthProbe,
  ): Promise<boolean> {
    if (probe.kind === 'running') return inspection.running;
    if (probe.kind === 'command') return (await this.exec(name, probe.command)).exitCode === 0;
    const hostPort = probe.hostNetwork
      ? probe.containerPort
      : inspection.hostPorts[probe.containerPort];
    if (!hostPort) return false;
    return probe.kind === 'http' ? probeHttp(hostPort, probe.path) : probeTcp(hostPort);
  }
}

export function graphNetworkName(applicationId: string): string {
  return safeDockerName(`deploy-sh-${applicationId}-private`, 63);
}

export function graphVolumeName(applicationId: string, resource: string): string {
  return safeDockerName(`deploy-sh-${applicationId}-${resource}`, 63);
}

export function graphImageTag(
  applicationId: string,
  component: string,
  releaseDigest: string,
): string {
  const digest = releaseDigest.replace(/^sha256:/, '').slice(0, 16);
  return `${safeDockerName(`deploy-sh-${applicationId}-${component}`, 80)}:${digest}`;
}

function containerArgs(
  operation: 'create' | 'run',
  request: GraphContainerCreateRequest,
  remove = false,
): string[] {
  const args: string[] = [operation];
  if (remove) args.push('--rm');
  args.push(
    '--name',
    request.name,
    '--network',
    request.networkMode === 'host' ? 'host' : request.network,
  );
  if (request.networkMode === 'private') {
    for (const alias of request.networkAliases) args.push('--network-alias', alias);
  }
  if (request.restart !== 'no' && operation === 'create') {
    args.push('--restart', request.restart ?? 'unless-stopped');
  }
  if (request.memoryLimit) args.push('--memory', request.memoryLimit);
  if (request.cpuLimit) args.push('--cpus', request.cpuLimit);
  if (request.gpus) args.push('--gpus', 'all');
  if (request.privileged) args.push('--privileged');
  if (request.privilegedDocker) {
    args.push('--volume', '/var/run/docker.sock:/var/run/docker.sock');
  }
  for (const device of request.devices) {
    args.push('--device', `${device.hostPath}:${device.containerPath}:${device.permissions}`);
  }
  for (const [key, value] of Object.entries(request.environment)) {
    args.push('--env', `${key}=${value}`);
  }
  for (const mount of request.mounts) {
    const source =
      mount.type === 'bind' ? `type=bind,src=${mount.source}` : `type=volume,src=${mount.source}`;
    args.push('--mount', `${source},dst=${mount.target}${mount.readOnly ? ',readonly' : ''}`);
  }
  if (request.networkMode === 'private') {
    for (const port of [...new Set(request.publishPorts)]) {
      args.push('--publish', `127.0.0.1::${port}`);
    }
  }
  for (const [key, value] of Object.entries(request.labels)) {
    args.push('--label', `${key}=${value}`);
  }
  args.push(...(request.runArgs ?? []), request.image, ...(request.command ?? []));
  return args;
}

async function dockerObjectExists(
  kind: 'image' | 'network' | 'volume',
  name: string,
): Promise<boolean> {
  try {
    await execFileAsync('docker', [kind, 'inspect', name]);
    return true;
  } catch {
    return false;
  }
}

function containedPath(root: string, child: string): string {
  const absoluteRoot = resolve(root);
  const value = resolve(absoluteRoot, child);
  if (value !== absoluteRoot && !value.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`Build path ${JSON.stringify(child)} escapes the project directory`);
  }
  return value;
}

function assertContainerFilePath(path: string): void {
  if (!path.startsWith('/') || path.includes('\0') || path.endsWith('/')) {
    throw new Error(`Invalid container file path ${JSON.stringify(path)}`);
  }
}

function safeDockerName(value: string, maxLength: number): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
  if (normalized.length <= maxLength) return normalized;
  const suffix = Buffer.from(normalized).toString('base64url').slice(0, 10).toLowerCase();
  return `${normalized.slice(0, maxLength - suffix.length - 1)}-${suffix}`;
}

function commandFailure(error: unknown): GraphCommandResult {
  const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
  return {
    exitCode: typeof failure.code === 'number' ? failure.code : 1,
    output: `${failure.stdout ?? ''}${failure.stderr ?? ''}${failure.message ?? ''}`,
  };
}

function archiveLocation(archivePath: string): { directory: string; filename: string } {
  const absolute = resolve(archivePath);
  const filename = basename(absolute);
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
    throw new Error(`Recovery archive filename ${JSON.stringify(filename)} is invalid`);
  }
  return { directory: dirname(absolute), filename };
}

async function fileDigest(path: string): Promise<`sha256:${string}`> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return `sha256:${digest.digest('hex')}`;
}

function probeTcp(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => finish(false), 1_000);
    let finished = false;
    const finish = (value: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function probeHttp(port: number, path: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const request = http.get({ host: '127.0.0.1', port, path, timeout: 1_000 }, (response) => {
      response.resume();
      resolvePromise((response.statusCode ?? 500) < 500);
    });
    request.once('timeout', () => request.destroy(new Error('health timeout')));
    request.once('error', () => resolvePromise(false));
  });
}
