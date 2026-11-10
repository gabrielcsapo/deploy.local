import { processResult } from '../process.ts';
import { existsSync, readdirSync, statfsSync } from 'node:fs';
import { arch, cpus, platform, totalmem } from 'node:os';
import { dirname } from 'node:path';
import { deployDataDirectory } from '../data-directory.ts';

import { ensureCoordinatorNode, getNode, getNodes } from '../store.ts';
import type { CatalogTargetResolver } from './handler.ts';
import type { CatalogTargetProfile } from './types.ts';

const DEPLOY_LOCAL_VERSION = '1.0.0';

/** Target facts are read from the coordinator or authenticated node heartbeats, never requests. */
export class DurableCatalogTargetResolver implements CatalogTargetResolver {
  async list(): Promise<CatalogTargetProfile[]> {
    ensureCoordinatorNode();
    const nodes: CatalogTargetProfile[] = [];
    for (const node of getNodes()) {
      try {
        nodes.push(node.id === 'coordinator' ? await coordinatorProfile() : remoteProfile(node));
      } catch {
        // An unavailable target is omitted, as before.
      }
    }
    return nodes;
  }

  async resolve(siteId: string): Promise<CatalogTargetProfile> {
    ensureCoordinatorNode();
    if (siteId === 'coordinator') return coordinatorProfile();
    const node = getNode(siteId);
    if (node && !node.revokedAt) return remoteProfile(node);
    throw new Error(`Catalog target ${JSON.stringify(siteId)} not found`);
  }
}

async function coordinatorProfile(): Promise<CatalogTargetProfile> {
  const operatingSystem = normalizedOperatingSystem(platform());
  const dockerVersion = await localDockerVersion();
  const devices = operatingSystem === 'linux' ? localDevices() : [];
  return {
    siteId: 'coordinator',
    siteKind: 'coordinator',
    deployLocalVersion: DEPLOY_LOCAL_VERSION,
    operatingSystem,
    architecture: normalizedArchitecture(arch()),
    engine: operatingSystem === 'linux' ? 'docker-engine' : 'docker-desktop',
    engineVersion: dockerVersion ?? '0.0.0',
    memoryMiB: Math.floor(totalmem() / 1024 ** 2),
    storageMiB: localStorageMiB(),
    cpuCores: cpus().length,
    online: process.env.DEPLOY_OFFLINE !== '1',
    cachedArtifactDigests: await localCachedArtifactDigests(),
    capabilities: {
      catalogExecution: true,
      privilegedContainers: dockerVersion !== null,
      hostNetwork: operatingSystem === 'linux' && dockerVersion !== null,
      lanDiscovery: operatingSystem === 'linux' && dockerVersion !== null,
      hostPaths: ['/run/dbus', '/var/run/dbus'].filter(existsSync),
      devices,
      dockerSocket: existsSync('/var/run/docker.sock'),
    },
  };
}

function remoteProfile(node: ReturnType<typeof getNode> extends infer T ? NonNullable<T> : never) {
  const capabilities = parsedObject(node.capabilities);
  const catalog = parsedObject(capabilities.catalog);
  const operatingSystem = normalizedOperatingSystem(String(node.platform ?? ''));
  return {
    siteId: node.id,
    siteKind: 'node',
    deployLocalVersion: stringFact(catalog.deployLocalVersion, node.agentVersion ?? '0.0.0'),
    operatingSystem,
    architecture: normalizedArchitecture(String(node.architecture ?? '')),
    engine:
      catalog.engine === 'docker-desktop' || operatingSystem !== 'linux'
        ? 'docker-desktop'
        : 'docker-engine',
    engineVersion: stringFact(catalog.engineVersion, '0.0.0'),
    memoryMiB: numberFact(catalog.memoryMiB, numberFact(capabilities.memoryBytes, 0) / 1024 ** 2),
    storageMiB: numberFact(catalog.storageMiB, 0),
    cpuCores: numberFact(catalog.cpuCores, numberFact(capabilities.cpuCount, 0)),
    online: node.online,
    cachedArtifactDigests: stringArrayFact(catalog.cachedArtifactDigests),
    capabilities: {
      // Remote operation completion is intentionally unavailable in v1. Heartbeats cannot opt in
      // until the coordinator has a durable terminal-result protocol.
      catalogExecution: false,
      privilegedContainers: booleanFact(catalog.privilegedContainers),
      hostNetwork: booleanFact(catalog.hostNetwork),
      lanDiscovery: booleanFact(catalog.lanDiscovery),
      hostPaths: stringArrayFact(catalog.hostPaths),
      devices: stringArrayFact(catalog.devices),
      dockerSocket: booleanFact(catalog.dockerSocket),
    },
  } satisfies CatalogTargetProfile;
}

async function localDockerVersion(): Promise<string | null> {
  try {
    const result = await processResult('docker', ['version', '--format', '{{.Server.Version}}'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    });
    if (result.status !== 0) return null;
    return result.stdout.match(/\d+(?:\.\d+){1,2}/)?.[0] ?? null;
  } catch {
    return null;
  }
}

async function localCachedArtifactDigests(): Promise<string[]> {
  try {
    const result = await processResult(
      'docker',
      ['image', 'ls', '--digests', '--format', '{{.Digest}}'],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
      },
    );
    if (result.status !== 0) return [];
    return [
      ...new Set(
        result.stdout.split(/\r?\n/).filter((value) => /^sha256:[a-f0-9]{64}$/.test(value)),
      ),
    ].sort();
  } catch {
    return [];
  }
}

function localStorageMiB(): number {
  let candidate = deployDataDirectory();
  while (!existsSync(candidate) && dirname(candidate) !== candidate) candidate = dirname(candidate);
  try {
    const stats = statfsSync(candidate);
    return Math.floor((Number(stats.bavail) * Number(stats.bsize)) / 1024 ** 2);
  } catch {
    return 0;
  }
}

function localDevices(): string[] {
  const devices: string[] = [];
  for (const directory of ['/dev/serial/by-id']) {
    try {
      devices.push(...readdirSync(directory).map((entry) => `${directory}/${entry}`));
    } catch {
      // Optional device class is absent.
    }
  }
  try {
    devices.push(
      ...readdirSync('/dev')
        .filter((entry) => /^(ttyUSB|ttyACM|video)\d+$/.test(entry))
        .map((entry) => `/dev/${entry}`),
    );
  } catch {
    // Non-Linux hosts do not expose /dev in this form.
  }
  return [...new Set(devices)].sort();
}

function normalizedOperatingSystem(value: string): CatalogTargetProfile['operatingSystem'] {
  if (value === 'linux' || value === 'darwin' || value === 'windows') return value;
  if (value === 'win32') return 'windows';
  throw new Error(`Unsupported target operating system ${JSON.stringify(value)}`);
}

function normalizedArchitecture(value: string): CatalogTargetProfile['architecture'] {
  if (value === 'arm64') return 'arm64';
  if (value === 'amd64' || value === 'x64') return 'amd64';
  throw new Error(`Unsupported target architecture ${JSON.stringify(value)}`);
}

function parsedObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return parsedObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringFact(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback;
}

function numberFact(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function booleanFact(value: unknown): boolean {
  return value === true;
}

function stringArrayFact(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}
