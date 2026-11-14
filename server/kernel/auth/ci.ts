import { createHash } from 'node:crypto';
import { authDatabase } from './database.ts';
import type { PrincipalOf } from './principal.ts';

export function verifyCi(token: unknown): PrincipalOf<'ci'> & { expiresAt: number } {
  if (typeof token !== 'string' || !/^ci_[a-f0-9]{64}$/.test(token)) unauthorized();
  const credential = authDatabase()
    .prepare(
      'SELECT id,username,application,expires_at FROM ci_credentials WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?',
    )
    .get(createHash('sha256').update(token).digest('hex'), Date.now()) as
    | { id: string; username: string; application: string; expires_at: number }
    | undefined;
  if (!credential) unauthorized();
  return {
    kind: 'ci',
    username: credential.username,
    application: credential.application,
    credentialId: credential.id,
    expiresAt: credential.expires_at,
  };
}
function unauthorized(): never {
  throw Object.assign(new Error('Unauthorized'), { status: 401 });
}
