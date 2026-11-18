import { createHash, randomBytes } from 'node:crypto';
import { get, list, remove, save } from '../../kernel/db/records.ts';

/**
 * Short-lived HTTP credentials for Git LFS over SSH remotes. `git-lfs-authenticate <path>
 * <operation>` on the SSH server mints one for the SSH key's owner and one repository; Git LFS
 * then sends it as `Authorization: RemoteAuth <token>` to the HTTP LFS API.
 *
 * The token is `<base64url owner>.<32 random bytes>`. Only a SHA-256 of the secret is stored
 * (kind `lfs-ssh-credential`, under the owner), with the repository, operation and expiry, so a
 * leaked database row cannot be replayed and a restart keeps credentials Git LFS still holds.
 */
export const lfsCredentialLifetimeSeconds = 10 * 60;
const scheme = 'RemoteAuth ';
export type LfsOperation = 'upload' | 'download';
export type LfsCredential = { owner: string; projectId: string; operation: LfsOperation };
const digest = (secret: string) => createHash('sha256').update(secret).digest('hex');

/** The address other computers reach this server at, the same origin setup and passkeys use. */
export function lfsPublicOrigin() {
  return (process.env.DEPLOY_PUBLIC_ORIGIN || 'https://deploy.local').replace(/\/+$/, '');
}

export function mintLfsCredential(
  owner: string,
  projectId: string,
  operation: LfsOperation,
  at = Date.now(),
) {
  for (const stale of list('lfs-ssh-credential', owner))
    if (!(stale.expiresAt > at)) remove('lfs-ssh-credential', owner, stale.id);
  const secret = randomBytes(32).toString('base64url');
  save('lfs-ssh-credential', owner, {
    id: digest(secret),
    projectId,
    operation,
    expiresAt: at + lfsCredentialLifetimeSeconds * 1000,
  });
  return {
    authorization: scheme + Buffer.from(owner).toString('base64url') + '.' + secret,
    expiresIn: lfsCredentialLifetimeSeconds,
  };
}

/** The credential an `Authorization: RemoteAuth …` header carries, or null when absent/invalid/expired. */
export function lfsCredential(header: unknown, at = Date.now()): LfsCredential | null {
  if (typeof header !== 'string' || !header.startsWith(scheme)) return null;
  const match = header.slice(scheme.length).match(/^([A-Za-z0-9_-]{1,512})\.([A-Za-z0-9_-]{43})$/);
  if (!match) return null;
  const owner = Buffer.from(match[1], 'base64url').toString();
  let record;
  try {
    record = get('lfs-ssh-credential', owner, digest(match[2]));
  } catch {
    return null;
  }
  if (!(record.expiresAt > at)) {
    remove('lfs-ssh-credential', owner, record.id);
    return null;
  }
  return { owner, projectId: record.projectId, operation: record.operation };
}
