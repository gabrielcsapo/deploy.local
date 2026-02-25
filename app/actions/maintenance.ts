'use server';

import { totalmem } from 'node:os';
import { authenticate, getAllocatedMemory } from '../../server/store.ts';
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
