import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statfsSync } from 'node:fs';
import { arch, cpus, platform, totalmem } from 'node:os';
import { dirname } from 'node:path';
import {
  readSuitcaseMembership,
  syncSuitcaseNow,
  withSuitcaseMembershipLock,
  type SuitcaseMembership,
} from '../lib/suitcase-sync-client.ts';
import { initializeSuitcaseMembershipState } from './suitcase-bootstrap.ts';
import { enqueueLocalDatabaseEvents } from './suitcase-local-outbox.ts';
import { projectSuitcaseFleetEvent } from './suitcase-projector.ts';
import {
  captureSuitcaseApplicationBranches,
  reconcileSuitcaseApplications,
} from './suitcase-application-materializer.ts';
import { deployDataDirectory } from './data-directory.ts';
import { processLocalOpaqueVolumeAuthorityTransfers } from './volume-sync.ts';
import {
  collectLocalFleetTelemetry,
  ingestFleetTelemetryRecords,
  type WireFleetTelemetryRecord,
} from './fleet-telemetry.ts';
import {
  consumePendingManualDataSyncRequests,
  type ManualDataSyncRequest,
} from './manual-data-sync.ts';
import { acknowledgePendingFleetMutationRequests } from './fleet-mutation-guard.ts';
import { configuredPlacementLabels } from './application-placement.ts';

export function suitcaseRuntimeEnvironment() {
  return {
    membershipFile: process.env.DEPLOY_SUITCASE_MEMBERSHIP_FILE,
    pairingExchangeFile: process.env.DEPLOY_SUITCASE_MEMBERSHIP_BOOTSTRAP_FILE,
  };
}

export function initializeSuitcaseRuntime(): boolean {
  return initializeSuitcaseMembershipState(suitcaseRuntimeEnvironment());
}

export function projectSuitcaseRuntimeEvent(
  event: Parameters<typeof projectSuitcaseFleetEvent>[0],
  artifactPaths: Record<string, string>,
  membership: SuitcaseMembership,
) {
  return projectSuitcaseFleetEvent(
    event,
    {
      fleetId: membership.fleetId,
      homeSiteId: membership.homeSiteId,
      localSiteId: membership.siteId,
      localSiteName: membership.name,
      rootPublicIdentity: membership.siteKeys[membership.homeSiteId] || '',
      localPublicKey: membership.publicKey,
      siteKeys: membership.siteKeys,
      defaultDataPolicy: membership.defaultDataPolicy,
      accessMode: membership.accessMode,
      securityProfile: membership.securityProfile,
      siteCredential: membership.credential,
    },
    artifactPaths,
  );
}

export async function syncSuitcaseRuntimeNow(manualSync: boolean) {
  const { membershipFile } = suitcaseRuntimeEnvironment();
  if (!membershipFile) throw new Error('Suitcase membership state path is unavailable');
  initializeSuitcaseRuntime();
  return withSuitcaseMembershipLock(membershipFile, async () => {
    const membership = readSuitcaseMembership(undefined, membershipFile);
    if (!membership) throw new Error('Suitcase membership is unavailable');
    await captureSuitcaseApplicationBranches(membership, { explicitManual: manualSync });
    enqueueLocalDatabaseEvents(membershipFile);
    // A request created from this suitcase's own admin UI is already in the
    // local durable event log, so consume it before contacting Home. Remote
    // requests discovered by the exchange are consumed in the second pass.
    const localManualRequests = await consumeRuntimeManualRequests(membership, membershipFile);
    if (localManualRequests.length > 0) enqueueLocalDatabaseEvents(membershipFile);
    const sync = await exchangeSuitcaseRuntime(membership, membershipFile, manualSync);
    const remoteManualRequests = await consumeRuntimeManualRequests(membership, membershipFile);
    if (remoteManualRequests.length > 0) {
      // Terminal child events are durable before this flush. If the network
      // drops here, the next background pass reports them without re-running
      // the already terminal request.
      enqueueLocalDatabaseEvents(membershipFile);
      await exchangeSuitcaseRuntime(membership, membershipFile, false);
    }
    // A destructive fleet operation is acknowledged only after at least one
    // complete coordinator exchange. This ensures every local event admitted
    // by policy is durable at Home before the replica releases its safety hold.
    const fleetMutationAcknowledgements = acknowledgePendingFleetMutationRequests({
      siteId: membership.siteId,
      homeSiteId: membership.homeSiteId,
    });
    if (fleetMutationAcknowledgements.length > 0) {
      enqueueLocalDatabaseEvents(membershipFile);
      await exchangeSuitcaseRuntime(membership, membershipFile, false);
    }
    return {
      ...sync,
      manualRequests: [...localManualRequests, ...remoteManualRequests],
      fleetMutationAcknowledgements,
    };
  });
}

function consumeRuntimeManualRequests(membership: SuitcaseMembership, membershipFile: string) {
  return consumePendingManualDataSyncRequests({
    siteId: membership.siteId,
    homeSiteId: membership.homeSiteId,
    async capture(request) {
      return captureRequestedApplication(membership, request);
    },
    async exchange(request) {
      enqueueLocalDatabaseEvents(membershipFile);
      const submitted = await exchangeSuitcaseRuntime(membership, membershipFile, true, [
        request.appId,
      ]);
      // The coordinator reconciles after constructing the first exchange
      // response. A second targeted pass retrieves and projects the adopted
      // checkpoint before this request is declared complete.
      const adopted = await exchangeSuitcaseRuntime(membership, membershipFile, true, [
        request.appId,
      ]);
      return { submitted, adopted };
    },
  });
}

async function captureRequestedApplication(
  membership: SuitcaseMembership,
  request: ManualDataSyncRequest,
): Promise<Record<string, unknown>> {
  const captures = await captureSuitcaseApplicationBranches(membership, {
    explicitManual: true,
    applicationIds: new Set([request.appId]),
  });
  const capture = captures.find((candidate) => candidate.appId === request.appId);
  if (!capture) throw new Error('The requested application is not materialized on this suitcase');
  if (capture.status === 'blocked') {
    throw new Error(capture.blockers?.join('; ') || 'Suitcase branch capture is blocked');
  }
  return capture as unknown as Record<string, unknown>;
}

async function exchangeSuitcaseRuntime(
  membership: SuitcaseMembership,
  membershipFile: string,
  manualSync: boolean,
  manualSyncAppIds?: string[],
) {
  const telemetry = await collectLocalFleetTelemetry({
    fleetId: membership.fleetId,
    siteId: membership.siteId,
  });
  return syncSuitcaseNow({
    membershipFile,
    manualSync,
    manualSyncAppIds,
    capabilities: suitcaseCatalogCapabilities(),
    telemetry: telemetry.records,
    telemetryArtifacts: telemetry.artifacts,
    projectEvent: projectSuitcaseRuntimeEvent,
    projectTelemetry(records) {
      const byOrigin = new Map<string, WireFleetTelemetryRecord[]>();
      for (const record of records) {
        const group = byOrigin.get(record.originSiteId) ?? [];
        group.push(record);
        byOrigin.set(record.originSiteId, group);
      }
      for (const [originSiteId, group] of byOrigin) {
        ingestFleetTelemetryRecords(group, {
          fleetId: membership.fleetId,
          originSiteId,
        });
      }
    },
  });
}

export async function materializeSuitcaseRuntime(membership: SuitcaseMembership) {
  const writerTransfers = await processLocalOpaqueVolumeAuthorityTransfers({
    localSiteId: membership.siteId,
  });
  const applications = await reconcileSuitcaseApplications(membership);
  return { writerTransfers, applications };
}

/** Facts measured inside the portable target and authenticated by its site credential. */
export function suitcaseCatalogCapabilities(): Record<string, unknown> {
  const dockerVersion = localDockerVersion();
  const operatingSystem = platform();
  const devices = operatingSystem === 'linux' ? localDevices() : [];
  const storageMiB = localStorageMiB();
  return {
    dockerTarget: dockerVersion !== null,
    docker: dockerVersion !== null,
    dockerVersion: dockerVersion ?? undefined,
    cpuCount: cpus().length,
    memoryBytes: totalmem(),
    labels: configuredPlacementLabels(),
    freeStorageBytes: storageMiB * 1024 ** 2,
    catalog: {
      deployLocalVersion: process.env.npm_package_version || '1.0.0',
      engine: operatingSystem === 'linux' ? 'docker-engine' : 'docker-desktop',
      engineVersion: dockerVersion ?? '0.0.0',
      memoryMiB: Math.floor(totalmem() / 1024 ** 2),
      storageMiB,
      cpuCores: cpus().length,
      cachedArtifactDigests: localCachedArtifactDigests(),
      catalogExecution: dockerVersion !== null,
      privilegedContainers: dockerVersion !== null && operatingSystem === 'linux',
      hostNetwork: dockerVersion !== null && operatingSystem === 'linux',
      lanDiscovery: dockerVersion !== null && operatingSystem === 'linux',
      hostPaths: ['/run/dbus', '/var/run/dbus'].filter(existsSync),
      devices,
      dockerSocket: existsSync('/var/run/docker.sock'),
      architecture: arch(),
    },
  };
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
    // Non-Linux targets do not expose /dev in this form.
  }
  return [...new Set(devices)].sort();
}
