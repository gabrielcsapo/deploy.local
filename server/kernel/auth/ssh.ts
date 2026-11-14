import { createHash } from 'node:crypto';
import { namedDatabase } from '../db/named-store.ts';
import type { PrincipalOf } from './principal.ts';

export const sshFingerprint = (blob: Buffer) =>
  'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
export function findSshKey(fingerprint: string): { owner: string; key: any } | null {
  const row = namedDatabase('workspace')
    .prepare(
      "SELECT owner,data FROM records WHERE kind='ssh-key' AND json_extract(data,'$.fingerprint')=?",
    )
    .get(fingerprint) as { owner: string; data: string } | undefined;
  return row ? { owner: row.owner, key: JSON.parse(row.data) } : null;
}
/** ssh2 parsing and public-key probes belong to the transport. Only signatures yield identity. */
export function verifySshSignature(
  found: { owner: string; key: { id: string } },
  key: { verify(data: Buffer, signature: Buffer, algo?: string): boolean | Error },
  blob: Buffer | undefined,
  signature: Buffer,
  hashAlgo?: string,
): PrincipalOf<'ssh'> | null {
  if (!blob || key.verify(blob, signature, hashAlgo) !== true) return null;
  return { kind: 'ssh', owner: found.owner, keyId: found.key.id };
}
