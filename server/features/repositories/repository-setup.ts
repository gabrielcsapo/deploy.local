import { access, statfs } from 'node:fs/promises';
import { constants } from 'node:fs';
import { root, db, list } from '../../workspace/store.ts';
import { gitText } from '../../workspace/repository-git.ts';

export async function repositorySetup(owner?: string) {
  const [version, writable, disk] = await Promise.all([
    gitText(root, ['--version'], { timeout: 5000 }).catch(() => null),
    access(root, constants.W_OK).then(
      () => true,
      () => false,
    ),
    statfs(root).catch(() => null),
  ]);
  const service = db.prepare('SELECT heartbeat FROM worker WHERE id=?').get('repositories') as any;
  const online = !!service && Date.now() - Date.parse(service.heartbeat) < 10000;
  const operations = owner ? list('repository-operation', owner) : [];
  return {
    ready: !!version && writable && online,
    git: { available: !!version, version },
    storage: { path: root, writable, availableBytes: disk ? disk.bavail * disk.bsize : null },
    service: { online, heartbeat: service?.heartbeat || null },
    ...(owner
      ? {
          operations: Object.fromEntries(
            ['queued', 'running', 'failed', 'unknown'].map((status) => [
              status,
              operations.filter((operation) => operation.status === status).length,
            ]),
          ),
        }
      : {}),
  };
}
