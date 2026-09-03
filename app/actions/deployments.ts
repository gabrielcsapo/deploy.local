'use server';

import { copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  authenticate,
  getDeployments as _getDeployments,
  getDeployment as _getDeployment,
  getDiscoverableDeployments,
  deleteDeployment as _deleteDeployment,
  updateDeploymentSettings as _updateDeploymentSettings,
  saveDeployment as _saveDeployment,
  addDeployEvent,
  getDeployHistory as _getDeployHistory,
  getRequestLogs as _getRequestLogs,
  getRequestSummary as _getRequestSummary,
  getPathAnalytics as _getPathAnalytics,
  getEndpointDetail as _getEndpointDetail,
  getCurrentHealth as _getCurrentHealth,
  getDashboardAggregate as _getDashboardAggregate,
  getFleetSeries as _getFleetSeries,
  getRecentFleetActivity as _getRecentFleetActivity,
  getRequestSeries as _getRequestSeries,
  getTopErrorPaths as _getTopErrorPaths,
  getBackups as _getBackups,
  saveBackup as _saveBackup,
  deleteBackupRecord as _deleteBackupRecord,
  getBuildLogs as _getBuildLogs,
  getDeploymentVolumes as _getDeploymentVolumes,
  getNode as _getNode,
  enqueueAgentJob as _enqueueAgentJob,
  getAgentJob as _getAgentJob,
  _invalidateDeploymentsCache,
} from '../../server/store.ts';
import {
  getContainerStatusAsync,
  getAllContainerStatuses,
  getContainerInspectAsync as _getContainerInspect,
  getContainerLogsByName as _getContainerLogsByName,
  stopContainer as _stopContainer,
  startContainer as _startContainer,
  restartContainer as _restartContainer,
  recreateContainer as _recreateContainer,
  getPreviousRelease as _getPreviousRelease,
  rollbackContainer as _rollbackContainer,
  removeContainer as _removeContainer,
  getBuildCacheSize as _getBuildCacheSize,
  purgeBuildCache as _purgeBuildCache,
} from '../../server/docker.ts';
import {
  resolveApplicationInstanceTarget,
  type ApplicationInstanceSelector,
} from '../../server/application-instance-target.ts';
import {
  getVolumeDir,
  getBackupDir,
  deleteBackupFile as _deleteBackupFile,
  deleteVolumes as _deleteVolumes,
  getVolumeSize as _getVolumeSize,
} from '../../server/volumes.ts';
import {
  createCoordinatorApplicationBackup as _createCoordinatorApplicationBackup,
  restoreCoordinatorApplicationBackup as _restoreCoordinatorApplicationBackup,
} from '../../server/application-backups.ts';
import { readCapture } from '../../server/capture.ts';
import { getActiveBuildLog } from '../../server/store.ts';
import { notifyCachePurge } from '../../server/ipc.ts';
import { listLatestFleetTelemetry, type FleetTelemetryKind } from '../../server/fleet-telemetry.ts';
import { registerApplicationIdentity, resolveLocalSiteId } from '../../server/multisite.ts';
import { getArtifact } from '../../server/content-store.ts';
import {
  applicationDeleteMutationFingerprint,
  assertFleetMutationReady,
} from '../../server/fleet-mutation-guard.ts';

const FLEET_BACKUP_PREFIX = 'fleet-telemetry-';

function remoteTelemetry(name: string, kind: FleetTelemetryKind) {
  const localSiteId = resolveLocalSiteId();
  return listLatestFleetTelemetry(name, kind).filter(
    (record) => record.originSiteId !== localSiteId,
  );
}

function telemetryNumericId(id: string): number {
  return -Number.parseInt(id.slice(-12), 16);
}

function remoteBuildDisplayId(
  name: string,
  originSiteId: string,
  sourceId: unknown,
): number | null {
  if (typeof sourceId !== 'number') return null;
  const build = listLatestFleetTelemetry(name, 'build').find(
    (record) => record.originSiteId === originSiteId && record.logicalKey === `build:${sourceId}`,
  );
  return build ? telemetryNumericId(build.id) : null;
}

function requireAuth(username: string, token: string) {
  if (!authenticate(username, token)) {
    throw new Error('Unauthorized');
  }
}

async function runRemoteCommand(
  nodeId: string,
  type: string,
  name: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 120_000,
  artifactPath?: string,
) {
  const node = _getNode(nodeId);
  if (!node?.online) throw new Error('Deployment node is offline');
  const queued = _enqueueAgentJob({
    nodeId,
    type,
    deploymentName: name,
    payload,
    artifactPath,
  });
  const deadline = Date.now() + timeoutMs;
  let job = _getAgentJob(queued.id);
  while (job && job.status !== 'complete' && job.status !== 'failed' && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    job = _getAgentJob(queued.id);
  }
  if (!job || (job.status !== 'complete' && job.status !== 'failed')) {
    throw new Error(`Timed out waiting for ${node.name}`);
  }
  if (job.status === 'failed') throw new Error(job.error || `Remote ${type} failed`);
  return job.result ? (JSON.parse(job.result) as Record<string, unknown>) : {};
}

const PRE_CONTAINER_STATES = new Set([
  'uploading',
  'backing-up',
  'building',
  'restoring',
  'starting',
]);

async function resolveStatus(d: {
  name: string;
  status: string | null;
  activeNodeId?: string | null;
}): Promise<string> {
  if (d.activeNodeId && d.activeNodeId !== 'coordinator') {
    return _getNode(d.activeNodeId)?.online ? d.status || 'unknown' : 'node-offline';
  }
  if (d.status && PRE_CONTAINER_STATES.has(d.status)) return d.status;
  return getContainerStatusAsync(d.name);
}

function resolveStatusBatched(
  d: { name: string; status: string | null; activeNodeId?: string | null },
  statusMap: Map<string, string>,
): string {
  if (d.activeNodeId && d.activeNodeId !== 'coordinator') {
    return _getNode(d.activeNodeId)?.online ? d.status || 'unknown' : 'node-offline';
  }
  if (d.status && PRE_CONTAINER_STATES.has(d.status)) return d.status;
  return statusMap.get(d.name.toLowerCase()) || 'stopped';
}

export async function fetchDeployments(username: string, token: string) {
  requireAuth(username, token);
  // The UI development server and production control plane are separate
  // processes sharing SQLite. Never let a UI-process cache outlive a control
  // plane status transition.
  _invalidateDeploymentsCache();
  const allDeps = _getDeployments(username);
  const statusMap = await getAllContainerStatuses();
  return allDeps.map((d) => ({
    ...d,
    status: resolveStatusBatched(d, statusMap),
  }));
}

export async function fetchDeployment(username: string, token: string, name: string) {
  requireAuth(username, token);
  _invalidateDeploymentsCache();
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  return { ...d, status: await resolveStatus(d) };
}

export async function deleteDeployment(
  username: string,
  token: string,
  name: string,
  opts?: { deleteVolumes?: boolean },
) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  const applicationId = d.appId || registerApplicationIdentity(name);
  assertFleetMutationReady({
    appId: applicationId,
    applicationName: name,
    kind: 'application-delete',
    mutationFingerprint: applicationDeleteMutationFingerprint(applicationId),
    consequence:
      'Deleting this application removes its Home runtime, graph record, and managed data. It cannot proceed while a selected suitcase may still hold an unreceived branch.',
    actor: username,
  });
  if (d.activeNodeId && d.activeNodeId !== 'coordinator') {
    await runRemoteCommand(d.activeNodeId, 'delete', name, {
      deleteVolumes: opts?.deleteVolumes === true,
    });
  } else {
    await _removeContainer(name);
  }
  addDeployEvent(name, { action: 'delete', username });
  _deleteDeployment(name);
  if (opts?.deleteVolumes) _deleteVolumes(name);
  return { message: `Deleted ${name}` };
}

export async function updateDeploymentSettings(
  username: string,
  token: string,
  name: string,
  settings: {
    autoBackup?: boolean;
    discoverable?: boolean;
    envVars?: Record<string, string>;
    memoryLimit?: string;
    cpuLimit?: string;
    volumes?: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }>;
    gpuEnabled?: boolean;
    privilegedDocker?: boolean;
    extraPorts?: Array<{ container: number; protocol?: string }>;
  },
) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');

  // Don't pass extraPorts to the DB settings update — it's handled via container recreation below
  const { extraPorts: extraPortsConfig, ...dbSettings } = settings;
  _updateDeploymentSettings(name, dbSettings);
  if (d.activeNodeId && d.activeNodeId !== 'coordinator') {
    return { message: 'Settings saved. Run deploy to apply them on the remote node.' };
  }

  // If env vars, volumes, GPU, privileged Docker, or extra ports changed, recreate the container so they take effect
  const needsRecreation =
    settings.envVars !== undefined ||
    settings.volumes !== undefined ||
    settings.gpuEnabled !== undefined ||
    settings.privilegedDocker !== undefined ||
    extraPortsConfig !== undefined;
  if (needsRecreation && d.port && (await resolveStatus(d)) === 'running') {
    const volumeDir = getVolumeDir(name);
    const memLimit = settings.memoryLimit || d.memoryLimit || '4g';
    const cpuLimit = settings.cpuLimit ?? d.cpuLimit ?? undefined;
    const envVarsToUse =
      settings.envVars ?? (d.envVars ? (JSON.parse(d.envVars) as Record<string, string>) : {});
    const customVolumes = settings.volumes ?? _getDeploymentVolumes(name);
    const gpuFlag = settings.gpuEnabled ?? d.gpuEnabled ?? false;
    const privilegedDockerFlag = settings.privilegedDocker ?? d.privilegedDocker ?? false;
    const { id, containerName, extraPorts } = await _recreateContainer(
      name,
      d.port,
      volumeDir,
      d.directory,
      envVarsToUse,
      memLimit,
      customVolumes,
      gpuFlag,
      extraPortsConfig,
      privilegedDockerFlag,
      cpuLimit,
    );
    const extraPortsJson = extraPorts.length > 0 ? JSON.stringify(extraPorts) : null;
    _saveDeployment({
      name,
      type: d.type || undefined,
      username: d.username,
      port: d.port,
      containerId: id,
      containerName,
      directory: d.directory || undefined,
      extraPorts: extraPortsJson,
    });
    const action =
      extraPortsConfig !== undefined
        ? 'ports-update'
        : settings.gpuEnabled !== undefined
          ? 'gpu-update'
          : settings.privilegedDocker !== undefined
            ? 'privileged-docker-update'
            : settings.volumes !== undefined
              ? 'volumes-update'
              : 'env-update';
    addDeployEvent(name, { action, username });
  }

  return { message: 'Settings updated' };
}

export async function fetchContainerInspect(username: string, token: string, name: string) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  return _getContainerInspect(name);
}

export async function fetchContainerLogs(
  username: string,
  token: string,
  name: string,
  tail = 1000,
  selector: ApplicationInstanceSelector = {},
) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  const target = resolveApplicationInstanceTarget(name, selector);
  if (target.nodeId !== 'coordinator') {
    const result = await runRemoteCommand(target.nodeId, 'logs', name, {
      tail,
      containerName: target.containerName,
    });
    return String(result.logs || '');
  }
  return _getContainerLogsByName(target.containerName, tail);
}

export async function restartDeployment(username: string, token: string, name: string) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  if (d.activeNodeId && d.activeNodeId !== 'coordinator') {
    await runRemoteCommand(d.activeNodeId, 'restart', name);
  } else {
    await _restartContainer(name);
  }
  addDeployEvent(name, { action: 'restart', username });
  return { message: `Restarted ${name}` };
}

export async function stopDeployment(username: string, token: string, name: string) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  if (d.activeNodeId && d.activeNodeId !== 'coordinator') {
    await runRemoteCommand(d.activeNodeId, 'stop', name);
  } else {
    await _stopContainer(name);
  }
  addDeployEvent(name, { action: 'stop', username });
  return { message: `Stopped ${name}` };
}

export async function startDeployment(username: string, token: string, name: string) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  if (d.activeNodeId && d.activeNodeId !== 'coordinator') {
    await runRemoteCommand(d.activeNodeId, 'start', name);
  } else {
    await _startContainer(name);
  }
  addDeployEvent(name, { action: 'start', username });
  return { message: `Started ${name}` };
}

export async function recreateDeployment(username: string, token: string, name: string) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  if (!d.port) throw new Error('Deployment has no port assigned');

  const volumeDir = getVolumeDir(name);
  const envVars = d.envVars ? (JSON.parse(d.envVars) as Record<string, string>) : {};
  const customVolumes = _getDeploymentVolumes(name);
  const gpuFlag = d.gpuEnabled ?? false;
  const privilegedDockerFlag = d.privilegedDocker ?? false;
  const extraPortsConfig = d.extraPorts
    ? (JSON.parse(d.extraPorts) as Array<{ container: number; protocol?: string }>)
    : undefined;
  const { id, containerName, extraPorts } = await _recreateContainer(
    name,
    d.port,
    volumeDir,
    d.directory,
    envVars,
    d.memoryLimit || '4g',
    customVolumes,
    gpuFlag,
    extraPortsConfig,
    privilegedDockerFlag,
  );
  const extraPortsJson = extraPorts.length > 0 ? JSON.stringify(extraPorts) : null;
  _saveDeployment({
    name,
    type: d.type || undefined,
    username: d.username,
    port: d.port,
    containerId: id,
    containerName,
    directory: d.directory || undefined,
    extraPorts: extraPortsJson,
  });
  addDeployEvent(name, { action: 'recreate', username });
  return { message: `Recreated ${name}` };
}

export async function applyMemoryLimit(username: string, token: string, name: string) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  if (!d.port || (await resolveStatus(d)) !== 'running')
    throw new Error('Container is not running');

  const volumeDir = getVolumeDir(name);
  const envVars = d.envVars ? (JSON.parse(d.envVars) as Record<string, string>) : {};
  const memLimit = d.memoryLimit || '4g';
  const cpuLimit = d.cpuLimit ?? undefined;
  const customVolumes = _getDeploymentVolumes(name);
  const gpuFlag = d.gpuEnabled ?? false;
  const privilegedDockerFlag = d.privilegedDocker ?? false;
  const { id, containerName, extraPorts } = await _recreateContainer(
    name,
    d.port,
    volumeDir,
    d.directory,
    envVars,
    memLimit,
    customVolumes,
    gpuFlag,
    undefined,
    privilegedDockerFlag,
    cpuLimit,
  );
  const extraPortsJson = extraPorts.length > 0 ? JSON.stringify(extraPorts) : null;
  _saveDeployment({
    name,
    type: d.type || undefined,
    username: d.username,
    port: d.port,
    containerId: id,
    containerName,
    directory: d.directory || undefined,
    extraPorts: extraPortsJson,
  });
  addDeployEvent(name, { action: 'memory-update', username });
  return { message: `Applied memory limit ${memLimit} to ${name}` };
}

export async function fetchDeployHistory(username: string, token: string, name: string) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  const local = _getDeployHistory(name);
  const remote = remoteTelemetry(name, 'activity').map((record) => ({
    id: telemetryNumericId(record.id),
    deploymentName: record.deploymentName,
    action: String(record.payload.action || 'activity'),
    username: typeof record.payload.username === 'string' ? record.payload.username : null,
    type: typeof record.payload.type === 'string' ? record.payload.type : null,
    port: typeof record.payload.port === 'number' ? record.payload.port : null,
    containerId: typeof record.payload.containerId === 'string' ? record.payload.containerId : null,
    buildLogId: remoteBuildDisplayId(name, record.originSiteId, record.payload.buildLogId),
    durationMs: typeof record.payload.durationMs === 'number' ? record.payload.durationMs : null,
    source: 'auto' as const,
    siteId: record.originSiteId,
    timestamp: record.observedAt,
  }));
  return [...local, ...remote].sort((left, right) =>
    String(right.timestamp).localeCompare(String(left.timestamp)),
  );
}

export async function fetchRollbackRelease(username: string, token: string, name: string) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  return _getPreviousRelease(name);
}

export async function rollbackDeployment(username: string, token: string, name: string) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  const release = await _rollbackContainer(name);
  _saveDeployment({
    name,
    type: d.type || undefined,
    username: d.username,
    port: release.port,
    containerId: release.containerId,
    containerName: release.containerName,
    directory: d.directory || undefined,
    extraPorts: d.extraPorts,
  });
  addDeployEvent(name, {
    action: 'rollback',
    username,
    port: release.port,
    containerId: release.containerId,
    source: 'ui',
  });
  return { message: `Rolled back ${name}`, release };
}

export async function purgeDeploymentCache(username: string, token: string, name: string) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  notifyCachePurge(name);
  addDeployEvent(name, { action: 'cache-purge', username, source: 'ui' });
  return { message: `Purged edge cache for ${name}` };
}

export async function fetchBuildCacheUsage(username: string, token: string, name: string) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  return { bytes: _getBuildCacheSize(name) };
}

export async function purgeDeploymentBuildCache(username: string, token: string, name: string) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  const bytes = await _purgeBuildCache(name);
  addDeployEvent(name, { action: 'build-cache-purge', username, source: 'ui' });
  return { message: `Purged build cache for ${name}`, bytes };
}

export async function fetchRequestData(
  username: string,
  token: string,
  name: string,
  options?: {
    page?: number;
    limit?: number;
    pathFilter?: string;
    statusFilter?: string;
    fromTimestamp?: number;
    toTimestamp?: number;
  },
) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  const logsResult = _getRequestLogs(name, options);
  return {
    logs: logsResult.logs,
    total: logsResult.total,
    page: logsResult.page,
    totalPages: logsResult.totalPages,
    summary: _getRequestSummary(name, {
      fromTimestamp: options?.fromTimestamp,
      toTimestamp: options?.toTimestamp,
    }),
    pathAnalytics: _getPathAnalytics(name, {
      fromTimestamp: options?.fromTimestamp,
      toTimestamp: options?.toTimestamp,
    }),
  };
}

export async function fetchRequestCapture(
  username: string,
  token: string,
  name: string,
  captureId: string,
) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  return readCapture(name, captureId);
}

export async function fetchEndpointDetail(
  username: string,
  token: string,
  name: string,
  path: string,
  options?: {
    fromTimestamp?: number;
    toTimestamp?: number;
    page?: number;
    limit?: number;
  },
) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  return _getEndpointDetail(name, path, options);
}

export async function fetchBackups(username: string, token: string, name: string) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');

  const backups = [
    ..._getBackups(name),
    ...remoteTelemetry(name, 'backup').map((record) => ({
      id: telemetryNumericId(record.id),
      deploymentName: record.deploymentName,
      filename: `${FLEET_BACKUP_PREFIX}${record.id}`,
      label:
        typeof record.payload.label === 'string' ? record.payload.label : 'Fleet recovery copy',
      sizeBytes: Number(record.payload.sizeBytes || 0),
      createdBy:
        typeof record.payload.createdBy === 'string'
          ? record.payload.createdBy
          : `site:${record.originSiteId}`,
      createdAt: record.observedAt,
      volumePaths: Array.isArray(record.payload.volumePaths) ? record.payload.volumePaths : [],
      relatedBuildLogId: remoteBuildDisplayId(
        name,
        record.originSiteId,
        record.payload.relatedBuildLogId,
      ),
      auto: Boolean(record.payload.auto),
      remote: true,
      originSiteId: record.originSiteId,
      artifactAvailable: Boolean(
        record.artifactDigests[0] && getArtifact(record.artifactDigests[0]),
      ),
    })),
  ].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  const volumeSize = _getVolumeSize(name);

  return { backups, volumeSize };
}

export async function createBackup(username: string, token: string, name: string, label?: string) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');

  let result;
  if (d.activeNodeId && d.activeNodeId !== 'coordinator') {
    result = await runRemoteCommand(
      d.activeNodeId,
      'backup',
      name,
      {
        label: label || 'manual',
        createdBy: username,
        relatedBuildLogId: d.currentBuildLogId ?? null,
        auto: false,
      },
      10 * 60_000,
    );
  } else {
    result = await _createCoordinatorApplicationBackup(d, label);
    _saveBackup({
      deploymentName: name,
      filename: result.filename as string,
      label: label || null,
      sizeBytes: result.sizeBytes as number,
      createdBy: username,
      createdAt: result.timestamp as string,
      volumePaths: result.volumePaths,
    });
  }

  addDeployEvent(name, { action: 'backup', username });
  return result;
}

export async function restoreBackup(
  username: string,
  token: string,
  name: string,
  filename: string,
) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  if (basename(filename) !== filename) throw new Error('Invalid backup filename');

  const remoteId = filename.startsWith(FLEET_BACKUP_PREFIX)
    ? filename.slice(FLEET_BACKUP_PREFIX.length)
    : null;
  const remoteRecord = remoteId
    ? remoteTelemetry(name, 'backup').find((record) => record.id === remoteId)
    : null;
  const remoteArtifact = remoteRecord?.artifactDigests[0]
    ? getArtifact(remoteRecord.artifactDigests[0])
    : null;
  if (remoteId && !remoteRecord) throw new Error('Fleet backup inventory record not found');
  if (remoteId && !remoteArtifact) throw new Error('Fleet backup content is not materialized here');

  if (d.activeNodeId && d.activeNodeId !== 'coordinator') {
    const backupPath = remoteArtifact?.localPath || resolve(getBackupDir(name), filename);
    if (!existsSync(backupPath)) throw new Error('Backup file not found');
    await runRemoteCommand(d.activeNodeId, 'restore', name, {}, 10 * 60_000, backupPath);
  } else {
    let localFilename = filename;
    if (remoteArtifact) {
      localFilename = `${FLEET_BACKUP_PREFIX}${remoteRecord!.id}.tar.gz`;
      copyFileSync(remoteArtifact.localPath, resolve(getBackupDir(name), localFilename));
    }
    try {
      const restored = await _restoreCoordinatorApplicationBackup(d, localFilename);
      if (restored.format === 'legacy') await _restartContainer(name);
    } finally {
      if (remoteArtifact) {
        const temporary = resolve(getBackupDir(name), localFilename);
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    }
  }

  addDeployEvent(name, { action: 'restore', username });
  return { message: 'Backup restored and container restarted' };
}

export async function deleteBackup(
  username: string,
  token: string,
  name: string,
  filename: string,
) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  if (filename.startsWith(FLEET_BACKUP_PREFIX)) {
    throw new Error('Fleet backup inventory is immutable; change its retention at the origin site');
  }

  _deleteBackupFile(name, filename);
  _deleteBackupRecord(name, filename);

  return { message: 'Backup deleted' };
}

export async function fetchBuildLogs(username: string, token: string, name: string, page = 1) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');

  const pageSize = 20;
  const local = _getBuildLogs(name, 1, 10_000).rows;
  const remote = remoteTelemetry(name, 'build').map((record) => ({
    id: telemetryNumericId(record.id),
    deploymentName: record.deploymentName,
    output: String(record.payload.output || ''),
    success: typeof record.payload.success === 'boolean' ? record.payload.success : null,
    duration: typeof record.payload.duration === 'number' ? record.payload.duration : null,
    status: String(record.payload.status || 'complete'),
    runtimeLogs: null,
    timestamp: record.observedAt,
    siteId: record.originSiteId,
  }));
  const all = [...local, ...remote].sort((left, right) =>
    String(right.timestamp).localeCompare(String(left.timestamp)),
  );
  const total = all.length;
  const rows = all.slice((page - 1) * pageSize, page * pageSize);
  const activeBuild = getActiveBuildLog(name);
  return {
    logs: rows,
    total,
    page,
    pageSize,
    activeBuild: activeBuild
      ? {
          output: activeBuild.output,
          timestamp: activeBuild.timestamp,
          phase: d.status || 'building',
        }
      : null,
  };
}

export async function fetchHealth(username: string, token: string, name: string) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  return _getCurrentHealth(name);
}

export async function fetchDashboardAggregate(username: string, token: string) {
  requireAuth(username, token);
  return _getDashboardAggregate();
}

export async function fetchFleetSeries(
  username: string,
  token: string,
  fromMs: number,
  toMs: number,
) {
  requireAuth(username, token);
  const result = _getFleetSeries(fromMs, toMs);
  const byBucket = new Map(result.series.map((point) => [point.bucket, point]));
  const localSiteId = resolveLocalSiteId();
  for (const deployment of _getDeployments(username)) {
    for (const record of listLatestFleetTelemetry(deployment.name, 'request-aggregate')) {
      if (record.originSiteId === localSiteId) continue;
      const sourceBucket = Number(record.payload.bucketMs);
      if (!Number.isFinite(sourceBucket) || sourceBucket < fromMs || sourceBucket > toMs) continue;
      const bucket = Math.floor(sourceBucket / result.bucketMs) * result.bucketMs;
      const point = byBucket.get(bucket);
      if (!point) continue;
      point.total += Number(record.payload.count || 0);
      point.errors += Number(record.payload.errors5xx || 0);
    }
  }
  return result;
}

export async function fetchRecentFleetActivity(username: string, token: string, limit = 12) {
  requireAuth(username, token);
  const local = _getRecentFleetActivity(limit);
  const localSiteId = resolveLocalSiteId();
  const remote = _getDeployments(username).flatMap((deployment) =>
    listLatestFleetTelemetry(deployment.name, 'activity')
      .filter((record) => record.originSiteId !== localSiteId)
      .map((record) => ({
        id: telemetryNumericId(record.id),
        deploymentName: record.deploymentName,
        action: String(record.payload.action || 'activity'),
        source: `site:${record.originSiteId}`,
        durationMs:
          typeof record.payload.durationMs === 'number' ? record.payload.durationMs : null,
        timestamp: record.observedAt,
      })),
  );
  return [...local, ...remote]
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, Math.min(limit, 100));
}

export async function fetchRequestSeries(
  username: string,
  token: string,
  name: string,
  fromMs: number,
  toMs: number,
) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  return _getRequestSeries(name, fromMs, toMs);
}

export async function fetchTopErrorPaths(
  username: string,
  token: string,
  name: string,
  fromMs: number,
  limit = 10,
) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  return _getTopErrorPaths(name, fromMs, limit);
}

export async function fetchDiscoverableApps() {
  const allDeps = getDiscoverableDeployments();
  const statusMap = await getAllContainerStatuses();
  return allDeps.map((d) => ({
    name: d.name,
    type: d.type,
    status: resolveStatusBatched(d, statusMap),
  }));
}
