import { createHash } from 'node:crypto';
import { authDatabase } from './database.ts';
import { namedDatabase } from '../db/named-store.ts';
import type { PrincipalOf } from './principal.ts';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
export function verifyComputerPackageKey(
  token: string,
): (PrincipalOf<'package-computer'> & { lastUsedAt: string | null }) | null {
  const computer = authDatabase()
    .prepare('SELECT username,computer_id,last_used_at FROM package_computer_keys WHERE hash=?')
    .get(digest(token)) as
    | { username: string; computer_id: string; last_used_at: string | null }
    | undefined;
  return computer
    ? {
        kind: 'package-computer',
        username: computer.username,
        computerId: computer.computer_id,
        lastUsedAt: computer.last_used_at,
      }
    : null;
}
export function verifyPackageKey(
  token: string,
): (PrincipalOf<'package-key'> & { keyId: string; lastUsedAt: string | null }) | null {
  const key = authDatabase()
    .prepare('SELECT id,username,scope,last_used_at FROM package_keys WHERE hash=?')
    .get(digest(token)) as
    | { id: string; username: string; scope: string; last_used_at: string | null }
    | undefined;
  return key
    ? {
        kind: 'package-key',
        username: key.username,
        credential: 'package-key:' + key.id,
        scope: key.scope,
        keyId: key.id,
        lastUsedAt: key.last_used_at,
      }
    : null;
}

export type PipelinePackageCredential = {
  owner: string;
  projectId: string;
  pipelineId: string;
  jobId: string;
  name: string;
  version: string;
  commit: string;
  generation: number;
  expiresAt: number;
};
/** Parse outside the feature's policy catch, preserving malformed-record errors. */
export function readPipelinePackageCredential(token: string): PipelinePackageCredential | null {
  const row = namedDatabase('workspace')
    .prepare("SELECT data FROM records WHERE kind='pipeline-package-token' AND id=? AND owner=''")
    .get(digest(token)) as { data: string } | undefined;
  return row ? JSON.parse(row.data) : null;
}
export function verifyPipelinePackageCredential(
  scope: PipelinePackageCredential,
): PrincipalOf<'package-pipeline'> | null {
  if (scope.expiresAt <= Date.now()) return null;
  return {
    kind: 'package-pipeline',
    owner: scope.owner,
    projectId: scope.projectId,
    pipelineId: scope.pipelineId,
    jobId: scope.jobId,
    name: scope.name,
    version: scope.version,
    commit: scope.commit,
  };
}
