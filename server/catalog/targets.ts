import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statfsSync } from 'node:fs';
import { arch, cpus, platform, totalmem } from 'node:os';
import { dirname } from 'node:path';
import { deployDataDirectory } from '../data-directory.ts';
import { listTopology, type TopologySite } from '../multisite.ts';
import { ensureCoordinatorNode, getNode, getNodes } from '../store.ts';
import type { CatalogTargetResolver } from './handler.ts';
import type { CatalogTargetProfile } from './types.ts';

const DEPLOY_LOCAL_VERSION = '1.0.0';

/** Target facts are read from the coordinator or authenticated node heartbeats, never requests. */
export class DurableCatalogTargetResolver implements CatalogTargetResolver {
  list(): CatalogTargetProfile[] {
    ensureCoordinatorNode();
    const nodes = getNodes().flatMap((node) => {
      try {
        return [node.id === 'coordinator' ? coordinatorProfile() : remoteProfile(node)];
      } catch {
        return [];
      }
    });
    const suitcases = listTopology().sites.flatMap((site) => {
      if (site.kind !== 'suitcase' || site.revoked_at) return [];
      try {
        return [suitcaseProfile(site)];
      } catch {
        return [];
      }
    });
    return [...nodes, ...suitcases];
  }

  resolve(siteId: string): CatalogTargetProfile {
    ensureCoordinatorNode();
    if (siteId === 'coordinator') return coordinatorProfile();
    const node = getNode(siteId);
    if (node && !node.revokedAt) return remoteProfile(node);
    const site = listTopology().sites.find(
      (candidate) => candidate.id === siteId && candidate.kind === 'suitcase',
    );
    if (!site || site.revoked_at)
      throw new Error(`Catalog target ${JSON.stringify(siteId)} not found`);
    return suitcaseProfile(site);
  }
}

function suitcaseProfile(site: TopologySite): CatalogTargetProfile {
  const capabilities = parsedObject(site.capabilities);
  const catalog = parsedObject(capabilities.catalog);
  const operatingSystem = normalizedOperatingSystem(String(site.platform ?? ''));
  const dockerTarget = booleanFact(capabilities.dockerTarget) || booleanFact(capabilities.docker);
  const lastContactAt = numberFact(site.last_contact_at, 0);
  return {
    siteId: site.id,
    siteKind: 'suitcase',
    deployLocalVersion: sourceVersion(stringFact(catalog.deployLocalVersion, String(site.version))),
    operatingSystem,
    architecture: normalizedArchitecture(String(site.architecture ?? '')),
    engine:
      catalog.engine === 'docker-desktop' || operatingSystem !== 'linux'
        ? 'docker-desktop'
        : 'docker-engine',
    engineVersion: normalizedVersion(
      stringFact(catalog.engineVersion, stringFact(capabilities.dockerVersion, '0.0.0')),
    ),
    memoryMiB: numberFact(catalog.memoryMiB, numberFact(capabilities.memoryBytes, 0) / 1024 ** 2),
    storageMiB: numberFact(
      catalog.storageMiB,
      numberFact(capabilities.freeStorageBytes, 0) / 1024 ** 2,
    ),
    cpuCores: numberFact(catalog.cpuCores, numberFact(capabilities.cpuCount, 0)),
    online:
      site.mode !== 'away' && site.mode !== 'revoked' && Date.now() - lastContactAt < 2 * 60_000,
    cachedArtifactDigests: stringArrayFact(catalog.cachedArtifactDigests),
    capabilities: {
      catalogExecution: booleanFact(catalog.catalogExecution) || dockerTarget,
      privilegedContainers:
        operatingSystem === 'linux' && (booleanFact(catalog.privilegedContainers) || dockerTarget),
      hostNetwork:
        operatingSystem === 'linux' && (booleanFact(catalog.hostNetwork) || dockerTarget),
      lanDiscovery:
        operatingSystem === 'linux' && (booleanFact(catalog.lanDiscovery) || dockerTarget),
      hostPaths: stringArrayFact(catalog.hostPaths),
      devices: stringArrayFact(catalog.devices),
      dockerSocket: booleanFact(catalog.dockerSocket) || dockerTarget,
    },
  } satisfies CatalogTargetProfile;
}

function coordinatorProfile(): CatalogTargetProfile {
  const operatingSystem = normalizedOperatingSystem(platform());
  const dockerVersion = localDockerVersion();
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
    cachedArtifactDigests: localCachedArtifactDigests(),
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

function localDockerVersion(): string | null {
  try {
    const output = execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.match(/\d+(?:\.\d+){1,2}/)?.[0] ?? null;
  } catch {
    return null;
  }
}

function localCachedArtifactDigests(): string[] {
  try {
    return [
      ...new Set(
        execFileSync('docker', ['image', 'ls', '--digests', '--format', '{{.Digest}}'], {
          encoding: 'utf8',
          timeout: 2_000,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .split(/\r?\n/)
          .filter((value) => /^sha256:[a-f0-9]{64}$/.test(value)),
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

function sourceVersion(value: string): string {
  return value === 'source' || !/^\d+(?:\.\d+){1,2}/.test(value) ? DEPLOY_LOCAL_VERSION : value;
}

function normalizedVersion(value: string): string {
  return value.match(/\d+(?:\.\d+){1,2}/)?.[0] ?? '0.0.0';
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
