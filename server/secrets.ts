import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const FORMAT = 'v1';

function decodeKey(value: string): Buffer {
  const trimmed = value.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64url');
  if (key.length !== KEY_BYTES) {
    throw new Error('DEPLOY_SECRET_KEY must encode exactly 32 bytes');
  }
  return key;
}

/**
 * Load the Home secret-store key, creating it with owner-only permissions on a
 * fresh installation. DEPLOY_SECRET_KEY is primarily for restored/container
 * installations where the key is supplied by a separate secret mechanism.
 */
export function loadOrCreateSecretKey(dataDir?: string): Buffer {
  if (process.env.DEPLOY_SECRET_KEY) return decodeKey(process.env.DEPLOY_SECRET_KEY);

  const root = dataDir || process.env.DEPLOY_DATA_DIR || resolve(process.cwd(), '.deploy-data');
  const directory = resolve(root, 'secrets');
  const path = resolve(directory, 'master.key');
  if (existsSync(path)) {
    const key = readFileSync(path);
    if (key.length !== KEY_BYTES) throw new Error('Invalid deploy.local secret-store key');
    return key;
  }

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(path, key, { mode: 0o600, flag: 'wx' });
  return key;
}

/** Encrypt a secret with its application/configuration address as AAD. */
export function encryptSecret(plaintext: string, key: Buffer, address: string): string {
  if (key.length !== KEY_BYTES) throw new Error('Secret encryption key must be 32 bytes');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(address, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    FORMAT,
    nonce.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function decryptSecret(envelope: string, key: Buffer, address: string): string {
  if (key.length !== KEY_BYTES) throw new Error('Secret encryption key must be 32 bytes');
  const [format, nonceValue, tagValue, ciphertextValue, ...extra] = envelope.split(':');
  if (
    format !== FORMAT ||
    !nonceValue ||
    !tagValue ||
    ciphertextValue === undefined ||
    extra.length > 0
  ) {
    throw new Error('Invalid encrypted secret envelope');
  }
  const nonce = Buffer.from(nonceValue, 'base64url');
  const tag = Buffer.from(tagValue, 'base64url');
  const ciphertext = Buffer.from(ciphertextValue, 'base64url');
  if (nonce.length !== NONCE_BYTES || tag.length !== 16) {
    throw new Error('Invalid encrypted secret envelope');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(address, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function secretAddress(
  deploymentName: string,
  key: string,
  siteId = '',
  specDigest = '',
): string {
  return `deploy.local/configuration/${deploymentName}/${specDigest || 'unversioned'}/${siteId || 'application'}/${key}`;
}
