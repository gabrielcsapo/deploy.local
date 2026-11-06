import { revokeComputerPackageKey } from '../packages/keys.ts';
import { workerComputerId } from './computer-role-policy.ts';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { terminalRelay } from './terminal-service.ts';
import { db, save, now, remove } from './store.ts';
export function enrollWorker(owner: string, input: any) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(input.workerId) || input.workerId === 'local')
    throw new Error('Unique non-local workerId required');
  // A new credential must never inherit an earlier computer's shell consent.
  remove('terminal-permission', owner, input.workerId);
  terminalRelay.disable(owner, input.workerId);
  revokeComputerPackageKey(owner, workerComputerId(owner, input.workerId));
  const workerToken = randomBytes(32).toString('hex');
  save('worker-credential', owner, {
    id: input.workerId,
    hash: createHash('sha256').update(workerToken).digest('hex'),
    createdAt: now(),
  });
  return { workerId: input.workerId, workerToken };
}
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
  const rows = db
    .prepare("SELECT owner,data FROM records WHERE kind='worker-credential' AND id=?")
    .all(workerId) as any[];
  for (const row of rows) {
    const expected = Buffer.from(JSON.parse(row.data).hash, 'hex');
    if (expected.length === hash.length && timingSafeEqual(expected, hash))
      return { owner: row.owner, workerId };
  }
  return null;
}
