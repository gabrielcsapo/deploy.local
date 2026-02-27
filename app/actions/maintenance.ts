'use server';

import { cpus, totalmem } from 'node:os';
import { authenticate, getAllocatedMemory, getAllDeployments, getLatestMetricsAll, getBackupSettings as _getBackupSettings, saveBackupSettings as _saveBackupSettings } from '../../server/store.ts';
import { Cron } from 'croner';
import { maintenance } from '../../server/maintenance.ts';

function requireAuth(username: string, token: string) {
  if (!authenticate(username, token)) {
    throw new Error('Unauthorized');
  }
}

export async function runVacuum(username: string, token: string) {
  requireAuth(username, token);

  const start = Date.now();
  maintenance.vacuum();
  const duration = Date.now() - start;

  return {
    success: true,
    message: `Database vacuum completed in ${duration}ms`,
    duration,
  };
}

export async function getMaintenanceStats(username: string, token: string) {
  requireAuth(username, token);

  const { getSqlite } = await import('../../server/store.ts');
  const sqlite = getSqlite();

  if (!sqlite) {
    throw new Error('Database not initialized');
  }

  // Get database file size
  const dbSizeResult = sqlite
    .prepare('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()')
    .get() as { size: number };
  const dbSize = dbSizeResult.size;

  // Get table row counts
  const tables = [
    'request_logs',
    'resource_metrics',
    'history',
    'build_logs',
    'backups',
    'deployments',
    'users',
    'sessions',
  ];
  const tableCounts: Record<string, number> = {};

  for (const table of tables) {
    try {
      const result = sqlite.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as {
        count: number;
      };
      tableCounts[table] = result.count;
    } catch {
      tableCounts[table] = 0;
    }
  }

  return {
    dbSize,
    tableCounts,
  };
}

export async function getSystemMemoryOverview(username: string, token: string) {
  requireAuth(username, token);

  const systemBytes = totalmem();
  const { totalBytes, perDeployment } = getAllocatedMemory();

  return {
    system: {
      totalBytes: systemBytes,
      allocatedBytes: totalBytes,
      availableBytes: Math.max(0, systemBytes - totalBytes),
    },
    deployments: perDeployment,
  };
}

export async function getSystemCapacityOverview(username: string, token: string) {
  requireAuth(username, token);

  const cpuCount = cpus().length;
  const systemMemoryBytes = totalmem();
  const latestMetrics = getLatestMetricsAll();
  const allDeployments = getAllDeployments();

  // Build deployment lookup by name
  const deploymentMap = new Map<string, { memoryLimit: string | null; status: string | null }>();
  for (const d of allDeployments) {
    deploymentMap.set(d.name, { memoryLimit: d.memoryLimit, status: d.status });
  }

  const perApp: Array<{
    name: string;
    cpuPercent: number;
    memUsageBytes: number;
    memLimitBytes: number;
    memPercent: number;
    allocatedLimit: string;
    status: string;
  }> = [];

  let totalCpuPercent = 0;
  let totalMemUsageBytes = 0;

  for (const metric of latestMetrics) {
    const dep = deploymentMap.get(metric.deploymentName);

    perApp.push({
      name: metric.deploymentName,
      cpuPercent: metric.cpuPercent,
      memUsageBytes: metric.memUsageBytes,
      memLimitBytes: metric.memLimitBytes,
      memPercent: metric.memPercent,
      allocatedLimit: dep?.memoryLimit || '4g',
      status: dep?.status || 'stopped',
    });

    totalCpuPercent += metric.cpuPercent;
    totalMemUsageBytes += metric.memUsageBytes;
  }

  perApp.sort((a, b) => b.memUsageBytes - a.memUsageBytes);

  return {
    system: {
      cpuCount,
      totalMemoryBytes: systemMemoryBytes,
      totalCpuPercent,
      totalMemUsageBytes,
    },
    apps: perApp,
  };
}

// ── Backup settings ─────────────────────────────────────────────────────────

export async function getBackupSettingsAction(username: string, token: string) {
  requireAuth(username, token);
  const settings = _getBackupSettings();
  const status = maintenance.getBackupStatus();
  return { settings, status };
}

export async function updateBackupSettings(
  username: string,
  token: string,
  settings: { enabled: boolean; destination: string; cron: string },
) {
  requireAuth(username, token);

  if (!settings.destination || settings.destination.trim() === '') {
    throw new Error('Backup destination path is required');
  }

  // Validate cron expression using croner
  try {
    // eslint-disable-next-line no-new -- validating cron expression by constructing; throws if invalid
    new Cron(settings.cron);
  } catch {
    throw new Error(`Invalid cron expression: "${settings.cron}"`);
  }

  _saveBackupSettings({
    enabled: settings.enabled,
    destination: settings.destination.trim(),
    cron: settings.cron.trim(),
  });

  // Reschedule cron job with new settings
  maintenance.rescheduleBackup();

  return { success: true, message: 'Backup settings updated' };
}

export async function triggerManualBackup(username: string, token: string) {
  requireAuth(username, token);
  const result = await maintenance.runBackup();
  return result;
}
