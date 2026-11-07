import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const FORMAT = 'v1';

/**
 * Every database row this key encrypts. Read only when the key file is missing, to tell a fresh
 * install from a data directory that lost its key. A new encryptSecret caller adds its store here
 * (or to encryptedReleaseFiles); secrets.test.ts fails until it does.
 */
const ENCRYPTED_ROWS: Record<string, Array<{ label: string; sql: string }>> = {
  'deploy.db': [
    {
      label: 'application secrets',
      sql: "SELECT 1 FROM application_configuration_values WHERE value_type='secret' LIMIT 1",
    },
    {
      label: 'project secrets',
      sql: "SELECT 1 FROM project_configuration WHERE value_type='secret' AND deleted=0 LIMIT 1",
    },
    {
      label: 'component secrets',
      sql: 'SELECT 1 FROM component_profile_values WHERE secret=1 LIMIT 1',
    },
    {
      label: 'worker job payloads',
      sql: "SELECT 1 FROM agent_jobs WHERE payload LIKE 'v1:%' LIMIT 1",
    },
    { label: 'computer package keys', sql: 'SELECT 1 FROM package_computer_keys LIMIT 1' },
  ],
  'workspace/workspace.db': [
    {
      label: 'provider keys and managed worker tokens',
      sql: `SELECT 1 FROM records WHERE kind IN ('provider-connection','managed-worker')
              AND json_extract(data,'$.secret') IS NOT NULL LIMIT 1`,
    },
  ],
};

function encryptedReleaseFiles(root: string): string[] {
  const releases = resolve(root, 'project-releases');
  if (!existsSync(releases)) return [];
  const journals = resolve(releases, 'journals');
  return [
    ...(existsSync(journals) && readdirSync(journals).some((name) => name.endsWith('.json'))
      ? ['project-releases/journals (release journals)']
      : []),
    ...(readdirSync(releases).some((name) => existsSync(resolve(releases, name, 'receipt.json')))
      ? ['project-releases (release receipts)']
      : []),
  ];
}

/**
 * What in this data directory only the missing key can open. A database that cannot be read counts:
 * it can't be ruled out, and guessing wrong loses every secret in it.
 */
function encryptedDataEvidence(root: string): string[] {
  const evidence = encryptedReleaseFiles(root);
  for (const [file, stores] of Object.entries(ENCRYPTED_ROWS)) {
    const path = resolve(root, file);
    if (!existsSync(path)) continue;
    try {
      // Loaded here, not imported: the CLI bundles this file for release jobs on other computers,
      // where there is no native SQLite and no database to look at.
      const Database = createRequire(import.meta.url)(
        'better-sqlite3',
      ) as typeof import('better-sqlite3');
      const database = new Database(path, { readonly: true, fileMustExist: true });
      try {
        for (const { label, sql } of stores) {
          try {
            if (database.prepare(sql).get()) evidence.push(`${file} (${label})`);
          } catch (error) {
            // A database older than this table has nothing encrypted in it.
            if (!/no such (table|column)/.test((error as Error).message)) throw error;
          }
        }
      } finally {
        database.close();
      }
    } catch (error) {
      evidence.push(`${file} (could not be read: ${(error as Error).message})`);
    }
  }
  return evidence;
}

function missingSecretKeyError(path: string, evidence: string[]) {
  return Object.assign(
    new Error(
      [
        `The secret-store key is missing: ${path}`,
        `This data directory already has data encrypted with it: ${evidence.join(', ')}.`,
        'A new key could never open that data, so deploy.local did not create one and will not start.',
        `To fix this, put the original master.key back at that path with mode 600, from a backup or a recovery bundle, or set DEPLOY_SECRET_KEY to the original key.`,
        `If the key is truly gone, those secrets cannot be recovered. To start anyway, create a new key yourself with: mkdir -p "${resolve(path, '..')}" && openssl rand -out "${path}" 32 && chmod 600 "${path}". Then enter each secret again.`,
      ].join('\n'),
    ),
    { code: 'DEPLOY_SECRET_KEY_MISSING' },
  );
}

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
 * Throws instead of creating a key when data encrypted with the old one exists.
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

  const evidence = encryptedDataEvidence(root);
  if (evidence.length > 0) throw missingSecretKeyError(path, evidence);

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

export function projectSecretAddress(owner: string, project: string, app: string, key: string) {
  return `deploy.local/project-configuration/${JSON.stringify([owner, project, app, key])}`;
}
