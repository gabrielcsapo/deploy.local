'use server';

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
  getBackups as _getBackups,
  saveBackup as _saveBackup,
  deleteBackupRecord as _deleteBackupRecord,
  getBuildLogs as _getBuildLogs,
  getDeploymentVolumes as _getDeploymentVolumes,
} from '../../server/store.ts';
import {
  getContainerStatus,
  getAllContainerStatuses,
  getContainerInspect as _getContainerInspect,
  stopContainer,
  restartContainer as _restartContainer,
  recreateContainer as _recreateContainer,
} from '../../server/docker.ts';
import {
  getVolumeDir,
  createBackup as _createBackup,
  restoreBackup as _restoreBackup,
  deleteBackupFile as _deleteBackupFile,
  getVolumeSize as _getVolumeSize,
} from '../../server/volumes.ts';
import { getActiveBuildLog } from '../../server/store.ts';
import { startProxies, stopProxies } from '../../server/tcp-proxy.ts';

function requireAuth(username: string, token: string) {
  if (!authenticate(username, token)) {
    throw new Error('Unauthorized');
  }
}

const PRE_CONTAINER_STATES = new Set(['uploading', 'building', 'starting']);

function resolveStatus(d: { name: string; status: string | null }): string {
  if (d.status && PRE_CONTAINER_STATES.has(d.status)) return d.status;
  return getContainerStatus(d.name);
}

function resolveStatusBatched(
  d: { name: string; status: string | null },
  statusMap: Map<string, string>,
): string {
  if (d.status && PRE_CONTAINER_STATES.has(d.status)) return d.status;
  return statusMap.get(d.name.toLowerCase()) || 'stopped';
}

export async function fetchDeployments(username: string, token: string) {
  requireAuth(username, token);
  const allDeps = _getDeployments(username);
  const statusMap = getAllContainerStatuses();
  return allDeps.map((d) => ({
    ...d,
    status: resolveStatusBatched(d, statusMap),
  }));
}

export async function fetchDeployment(username: string, token: string, name: string) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  return { ...d, status: resolveStatus(d) };
}

export async function deleteDeployment(username: string, token: string, name: string) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  stopProxies(name);
  stopContainer(name);
  addDeployEvent(name, { action: 'delete', username });
  _deleteDeployment(name);
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
    volumes?: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }>;
    gpuEnabled?: boolean;
    extraPorts?: Array<{ container: number; protocol?: string }>;
  },
) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');

  // Don't pass extraPorts to the DB settings update — it's handled via container recreation below
  const { extraPorts: extraPortsConfig, ...dbSettings } = settings;
  _updateDeploymentSettings(name, dbSettings);

  // If env vars, volumes, GPU, or extra ports changed, recreate the container so they take effect
  const needsRecreation =
    settings.envVars !== undefined ||
    settings.volumes !== undefined ||
    settings.gpuEnabled !== undefined ||
    extraPortsConfig !== undefined;
  if (needsRecreation && d.port && resolveStatus(d) === 'running') {
    const volumeDir = getVolumeDir(name);
    const memLimit = settings.memoryLimit || d.memoryLimit || '4g';
    const envVarsToUse =
      settings.envVars ?? (d.envVars ? (JSON.parse(d.envVars) as Record<string, string>) : {});
    const customVolumes = settings.volumes ?? _getDeploymentVolumes(name);
    const gpuFlag = settings.gpuEnabled ?? d.gpuEnabled ?? false;
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
    if (extraPorts.length > 0) {
      startProxies(name, extraPorts);
    } else {
      stopProxies(name);
    }
    const action =
      extraPortsConfig !== undefined
        ? 'ports-update'
        : settings.gpuEnabled !== undefined
          ? 'gpu-update'
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

export async function restartDeployment(username: string, token: string, name: string) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  _restartContainer(name);
  addDeployEvent(name, { action: 'restart', username });
  return { message: `Restarted ${name}` };
}

export async function applyMemoryLimit(username: string, token: string, name: string) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  if (!d.port || resolveStatus(d) !== 'running') throw new Error('Container is not running');

  const volumeDir = getVolumeDir(name);
  const envVars = d.envVars ? (JSON.parse(d.envVars) as Record<string, string>) : {};
  const memLimit = d.memoryLimit || '4g';
  const customVolumes = _getDeploymentVolumes(name);
  const gpuFlag = d.gpuEnabled ?? false;
  const { id, containerName, extraPorts } = await _recreateContainer(
    name,
    d.port,
    volumeDir,
    d.directory,
    envVars,
    memLimit,
    customVolumes,
    gpuFlag,
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
  if (extraPorts.length > 0) {
    startProxies(name, extraPorts);
  } else {
    stopProxies(name);
  }
  addDeployEvent(name, { action: 'memory-update', username });
  return { message: `Applied memory limit ${memLimit} to ${name}` };
}

export async function fetchDeployHistory(username: string, token: string, name: string) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');
  return _getDeployHistory(name);
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

  const backups = _getBackups(name);
  const volumeSize = _getVolumeSize(name);

  return { backups, volumeSize };
}

export async function createBackup(username: string, token: string, name: string, label?: string) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');

  const result = await _createBackup(name, label);
  _saveBackup({
    deploymentName: name,
    filename: result.filename,
    label: label || null,
    sizeBytes: result.sizeBytes,
    createdBy: username,
    createdAt: result.timestamp,
    volumePaths: ['data', 'uploads'],
  });

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

  _restoreBackup(name, filename);
  _restartContainer(name);

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

  _deleteBackupFile(name, filename);
  _deleteBackupRecord(name, filename);

  return { message: 'Backup deleted' };
}

export async function fetchBuildLogs(username: string, token: string, name: string, page = 1) {
  requireAuth(username, token);
  const d = _getDeployment(name);
  if (!d || d.username !== username) throw new Error('Not found');

  const { rows, total, pageSize } = _getBuildLogs(name, page);
  const activeBuild = getActiveBuildLog(name);
  return {
    logs: rows,
    total,
    page,
    pageSize,
    activeBuild: activeBuild
      ? { output: activeBuild.output, timestamp: activeBuild.timestamp }
      : null,
  };
}

export async function fetchDiscoverableApps() {
  const allDeps = getDiscoverableDeployments();
  const statusMap = getAllContainerStatuses();
  return allDeps.map((d) => ({
    name: d.name,
    type: d.type,
    status: resolveStatusBatched(d, statusMap),
  }));
}
