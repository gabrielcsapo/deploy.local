import { createHash } from 'node:crypto';
import { namedDatabase } from '../db/named-store.ts';
import type { PrincipalOf } from './principal.ts';

type RunCredential = {
  owner: string;
  credential: { taskId: string; runId: string; expiresAt: number };
};
/** Unverified record: the adapter must load the run before checking expiry, as before. */
export function readRunCredential(token: string): RunCredential | null {
  if (!token || token.length > 200) return null;
  const row = namedDatabase('workspace')
    .prepare("SELECT owner,data FROM records WHERE kind='agent-credential' AND id=?")
    .get(createHash('sha256').update(token).digest('hex')) as
    | { owner: string; data: string }
    | undefined;
  if (!row) return null;
  return { owner: row.owner, credential: JSON.parse(row.data) };
}
/** Called only after the feature's run read, before its live-run policy. */
export function verifyRunCredential(record: RunCredential): PrincipalOf<'run'> | null {
  const { owner, credential } = record;
  if (credential.expiresAt < Date.now()) return null;
  return { kind: 'run', owner, taskId: credential.taskId, runId: credential.runId };
}
