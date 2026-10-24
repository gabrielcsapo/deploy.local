import { createHash, createPublicKey } from 'node:crypto';
import ssh2 from 'ssh2';
const { utils } = ssh2;
import { db, event, get, id, now, remove, save } from './store.ts';

const allowed = new Set([
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'ssh-rsa',
]);
const invalid = (message: string) => Object.assign(new Error(message), { status: 400 });
export const sshFingerprint = (blob: Buffer) =>
  'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');

export function parsePublicKey(input: unknown) {
  if (typeof input !== 'string' || input.length > 16384) throw invalid('Enter an SSH public key');
  if (/PRIVATE KEY/.test(input))
    throw invalid('Private keys cannot be added. Paste the public key (.pub file) instead.');
  const match = input.trim().match(/^(\S+)\s+([A-Za-z0-9+/]+={0,2})(?:\s+([^\r\n]*))?$/);
  if (!match || !allowed.has(match[1]))
    throw invalid('Use an Ed25519, ECDSA, or RSA SSH public key');
  const key = utils.parseKey(`${match[1]} ${match[2]}`);
  if (key instanceof Error || Array.isArray(key) || key.isPrivateKey() || key.type !== match[1])
    throw invalid('Invalid SSH public key');
  if (
    key.type === 'ssh-rsa' &&
    (createPublicKey(key.getPublicPEM()).asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  )
    throw invalid('RSA keys must have at least 2048 bits');
  const blob = key.getPublicSSH();
  // Reject trailing data and noncanonical base64 instead of silently parsing a different key.
  if (blob.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, ''))
    throw invalid('Invalid SSH public key');
  return {
    publicKey: `${key.type} ${blob.toString('base64')}`,
    fingerprint: sshFingerprint(blob),
    type: key.type,
    comment: match[3]?.trim() || '',
  };
}

export function findSshKey(fingerprint: string): { owner: string; key: any } | null {
  const row = db
    .prepare(
      "SELECT owner,data FROM records WHERE kind='ssh-key' AND json_extract(data,'$.fingerprint')=?",
    )
    .get(fingerprint) as { owner: string; data: string } | undefined;
  return row ? { owner: row.owner, key: JSON.parse(row.data) } : null;
}

export function addSshKey(owner: string, input: { name?: unknown; publicKey?: unknown }) {
  const { comment, ...parsed } = parsePublicKey(input.publicKey);
  if (input.name !== undefined && typeof input.name !== 'string')
    throw invalid('Key name must be text');
  const name = (input.name as string | undefined)?.trim() || comment || 'SSH key';
  if (name.length > 80) throw invalid('Key name must be 80 characters or fewer');
  return db
    .transaction(() => {
      if (findSshKey(parsed.fingerprint))
        throw Object.assign(new Error('This SSH key has already been added to an account'), {
          status: 409,
        });
      const key = save('ssh-key', owner, {
        id: id(),
        name,
        ...parsed,
        createdAt: now(),
        lastUsedAt: null,
      });
      event(owner, '', null, 'ssh-key.added', { keyId: key.id });
      return key;
    })
    .immediate();
}

export function deleteSshKey(owner: string, keyId: string) {
  get('ssh-key', owner, keyId);
  remove('ssh-key', owner, keyId);
  event(owner, '', null, 'ssh-key.deleted', { keyId });
  return { deleted: true };
}
