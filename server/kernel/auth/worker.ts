import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { namedDatabase } from '../db/named-store.ts';

export function workerAuthentication(
  req: IncomingMessage,
): { owner: string; workerId: string } | null {
  let workerId = String(req.headers['x-deploy-worker-id'] || ''),
    token = String(req.headers['x-deploy-worker-token'] || '');
  const basic = req.headers.authorization;
  if (basic?.startsWith('Basic ')) {
    const decoded = Buffer.from(basic.slice(6), 'base64').toString(),
      n = decoded.indexOf(':');
    if (decoded.slice(0, n).startsWith('workspace-worker.')) {
      workerId = decoded.slice('workspace-worker.'.length, n);
      token = decoded.slice(n + 1);
    }
  }
  if (!workerId || !token) return null;
  const hash = createHash('sha256').update(token).digest();
  const rows = namedDatabase('workspace')
    .prepare("SELECT owner,data FROM records WHERE kind='worker-credential' AND id=?")
    .all(workerId) as any[];
  for (const row of rows) {
    const expected = Buffer.from(JSON.parse(row.data).hash, 'hex');
    if (expected.length === hash.length && timingSafeEqual(expected, hash))
      return { owner: row.owner, workerId };
  }
  return null;
}
