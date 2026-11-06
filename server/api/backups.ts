import { requireAuth, error, dispatchAgentCommand, json } from './shared.ts';
import {
  getDeployment,
  saveBackup,
  addDeployEvent,
  getBackups,
  recordContainerStart,
  deleteBackupRecord,
} from '../store.ts';
import { readBody, RequestBodyTooLargeError } from '../http.ts';
import {
  createCoordinatorApplicationBackup,
  isCoordinatorApplicationGraph,
  restoreCoordinatorApplicationBackup,
} from '../application-backups.ts';
import { getVolumeSize, getBackupDir, deleteBackupFile } from '../volumes.ts';
import { basename, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { restartContainer } from '../docker.ts';
import { type ApiRouteContext } from './context.ts';

export async function backupsRoutes(ctx: ApiRouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx;
  // Keep the original return boundary: returned promises bypass the catch,
  // while thrown errors and rejected awaits use the existing API error response.
  const result = await (async () => {
    try {
      // ── Backup management ──────────────────────────────────────────────

      // Create backup or list backups
      const backupsMatch = path.match(/^\/api\/deployments\/([^/]+)\/backups$/);

      if (backupsMatch && method === 'POST') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = backupsMatch[1];
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);

        const body = JSON.parse((await readBody(req)).toString());
        const label = body.label || null;

        let result;
        if (d.activeNodeId && d.activeNodeId !== 'coordinator') {
          result = await dispatchAgentCommand(
            d.activeNodeId,
            'backup',
            name,
            {
              label: label || 'manual',
              createdBy: auth.username,
              relatedBuildLogId: d.currentBuildLogId ?? null,
              auto: false,
            },
            10 * 60_000,
          );
        } else {
          result = await createCoordinatorApplicationBackup(d, label);
          saveBackup({
            deploymentName: name,
            filename: result.filename,
            label,
            sizeBytes: result.sizeBytes,
            createdBy: auth.username,
            createdAt: result.timestamp,
            volumePaths: result.volumePaths,
            relatedBuildLogId: d.currentBuildLogId ?? null,
            auto: false,
          });
        }

        addDeployEvent(name, { action: 'backup', username: auth.username, source: 'ui' });
        return json(res, result, 201);
      }

      if (backupsMatch && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = backupsMatch[1];
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);

        const dbBackups = getBackups(name);
        const volumeSize =
          d.activeNodeId && d.activeNodeId !== 'coordinator'
            ? null
            : isCoordinatorApplicationGraph(d)
              ? null
              : await getVolumeSize(name);

        return json(res, { backups: dbBackups, volumeSize });
      }

      // Restore backup
      const restoreMatch = path.match(/^\/api\/deployments\/([^/]+)\/backups\/([^/]+)\/restore$/);

      if (restoreMatch && method === 'POST') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = restoreMatch[1];
        const filename = decodeURIComponent(restoreMatch[2]);
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);
        if (basename(filename) !== filename) return error(res, 'Invalid backup filename', 400);

        if (d.activeNodeId && d.activeNodeId !== 'coordinator') {
          const backupPath = resolve(getBackupDir(name), filename);
          if (!existsSync(backupPath)) return error(res, 'Backup file not found', 404);
          await dispatchAgentCommand(d.activeNodeId, 'restore', name, {}, 10 * 60_000, backupPath);
        } else {
          const restored = await restoreCoordinatorApplicationBackup(d, filename);
          if (restored.format === 'legacy') await restartContainer(name);
        }
        recordContainerStart(name);

        addDeployEvent(name, { action: 'restore', username: auth.username, source: 'ui' });
        return json(res, { message: 'Backup restored and container restarted' });
      }

      // Delete backup
      const deleteBackupMatch = path.match(/^\/api\/deployments\/([^/]+)\/backups\/([^/]+)$/);

      if (deleteBackupMatch && method === 'DELETE') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = deleteBackupMatch[1];
        const filename = decodeURIComponent(deleteBackupMatch[2]);
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);

        deleteBackupFile(name, filename);
        deleteBackupRecord(name, filename);

        return json(res, { message: 'Backup deleted' });
      }
      return false;
    } catch (err: unknown) {
      console.error(err);
      error(
        res,
        (err as Error).message || 'Internal server error',
        err instanceof RequestBodyTooLargeError
          ? 413
          : (err as Error & { status?: number }).status || 500,
      );
    }
  })();
  return result !== false;
}
