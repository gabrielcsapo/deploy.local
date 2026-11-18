import { revokeComputerPackageKey } from '../../packages/keys.ts';
import { workerComputerId } from '../../workspace/computer-role-policy.ts';
import { randomBytes, createHash } from 'node:crypto';
import { terminalRelay } from '../../workspace/terminal-service.ts';
import { save, now, remove } from '../../workspace/store.ts';
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
export { workerAuthentication } from '../../kernel/auth/worker.ts';
