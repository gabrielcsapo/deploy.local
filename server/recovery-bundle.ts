import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  scryptSync,
  verify,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { putArtifactFile } from './content-store.ts';
import { deployDataDirectory } from './data-directory.ts';
import { ensureFleetIdentity, sortableId } from './multisite.ts';
import { decryptSecret, secretAddress } from './secrets.ts';
import { ensureApplicationRevisionArtifacts, getSqlite } from './store.ts';

const RECOVERY_FORMAT_VERSION = 1;
const RECOVERY_AAD = Buffer.from('deploy.local/home-recovery/v1');
const INVENTORY_TABLES = [
  'deployments',
  'application_spec_revisions',
  'application_spec_transitions',
  'application_configuration_values',
  'fleets',
  'sites',
  'application_aliases',
  'fleet_events',
  'site_sync_cursors',
  'data_sync_policies',
  'data_checkpoints',
  'data_conflicts',
  'artifacts',
  'release_candidates',
] as const;
const SHA256_HEX = /^[a-f0-9]{64}$/;

interface RecoveryFile {
  path: string;
  mode: number;
  byteSize: number;
  digest: string;
  content: string;
}

interface RecoveryPayload {
  formatVersion: 1;
  fleetId: string;
  homeSiteId: string;
  createdAt: string;
  inventory: RecoveryInventory;
  inventoryDigest: string;
  /** Added compatibly to format v1; absent in older v1 bundles. */
  activeSuitcaseCredentials?: Array<{ siteId: string; credentialHash: string }>;
  files: RecoveryFile[];
}

interface RecoveryEnvelope {
  kind: 'deploy.local/HomeRecoveryBundle';
  formatVersion: 1;
  kdf: { name: 'scrypt'; salt: string; N: number; r: number; p: number };
  encryption: { name: 'aes-256-gcm'; nonce: string; tag: string };
  ciphertext: string;
}

export interface RecoveryInventory {
  fleetId: string;
  homeSiteId: string;
  counts: Record<string, number>;
  authority: Array<{
    appId: string;
    epoch: number;
    generation: number;
    desiredRelease: string | null;
  }>;
  sites: Array<{ id: string; status: string; revokedAt: string | null }>;
  cursors: Array<{ local: string; remote: string; stream: string; sequence: number }>;
  checkpoints: Array<{
    id: string;
    appId: string;
    parentId: string | null;
    manifestDigest: string;
  }>;
  artifacts: Array<{ digest: string; type: string; verification: string; retention: string }>;
}

export interface RecoveryRehearsalReport {
  bundleId: string;
  passed: true;
  fleetId: string;
  homeSiteId: string;
  inventoryDigest: string;
  checks: {
    inventoryTables: number;
    fleets: number;
    sites: number;
    activeSuitcaseCredentials: number;
    applicationRevisions: number;
    applicationAliases: number;
    dataPolicies: number;
    checkpoints: number;
    encryptedConfigurationValues: number;
    caKeyPair: true;
    homeSigningIdentity: true;
    secretStoreKey: 'bundle' | 'environment';
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`;
}

function digestBytes(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function digest(value: unknown): string {
  return digestBytes(Buffer.from(canonical(value)));
}

function assertRecoveryPassphrase(passphrase: string): void {
  if (passphrase.length < 12)
    throw new Error('Recovery passphrase must contain at least 12 characters');
}

function tableCount(database: InstanceType<typeof Database>, table: string): number {
  if (!(INVENTORY_TABLES as readonly string[]).includes(table)) {
    throw new Error('Unsupported recovery inventory table');
  }
  return Number(
    (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
  );
}

function buildRecoveryInventoryFromDatabase(
  sqlite: InstanceType<typeof Database>,
): RecoveryInventory {
  const fleet = sqlite
    .prepare('SELECT id, home_site_id FROM fleets ORDER BY created_at LIMIT 1')
    .get() as { id: string; home_site_id: string } | undefined;
  if (!fleet) throw new Error('Recovery inventory requires a fleet identity');
  return {
    fleetId: fleet.id,
    homeSiteId: fleet.home_site_id,
    counts: Object.fromEntries(INVENTORY_TABLES.map((table) => [table, tableCount(sqlite, table)])),
    authority: (
      sqlite
        .prepare(
          `SELECT app_id, release_authority_epoch, release_generation, desired_release_digest
             FROM deployments WHERE app_id IS NOT NULL ORDER BY app_id`,
        )
        .all() as Array<{
        app_id: string;
        release_authority_epoch: number;
        release_generation: number;
        desired_release_digest: string | null;
      }>
    ).map((row) => ({
      appId: row.app_id,
      epoch: row.release_authority_epoch,
      generation: row.release_generation,
      desiredRelease: row.desired_release_digest,
    })),
    sites: (
      sqlite
        .prepare('SELECT id, credential_status, revoked_at FROM sites ORDER BY id')
        .all() as Array<{ id: string; credential_status: string; revoked_at: string | null }>
    ).map((row) => ({ id: row.id, status: row.credential_status, revokedAt: row.revoked_at })),
    cursors: (
      sqlite
        .prepare(
          `SELECT local_site_id, remote_site_id, stream, last_accepted_sequence
             FROM site_sync_cursors ORDER BY local_site_id, remote_site_id, stream`,
        )
        .all() as Array<{
        local_site_id: string;
        remote_site_id: string;
        stream: string;
        last_accepted_sequence: number;
      }>
    ).map((row) => ({
      local: row.local_site_id,
      remote: row.remote_site_id,
      stream: row.stream,
      sequence: row.last_accepted_sequence,
    })),
    checkpoints: (
      sqlite
        .prepare(
          `SELECT id, app_id, parent_id, manifest_artifact_digest
             FROM data_checkpoints ORDER BY app_id, sequence`,
        )
        .all() as Array<{
        id: string;
        app_id: string;
        parent_id: string | null;
        manifest_artifact_digest: string;
      }>
    ).map((row) => ({
      id: row.id,
      appId: row.app_id,
      parentId: row.parent_id,
      manifestDigest: row.manifest_artifact_digest,
    })),
    artifacts: (
      sqlite
        .prepare(
          `SELECT digest, type, verification_status, retention_class
             FROM artifacts ORDER BY digest`,
        )
        .all() as Array<{
        digest: string;
        type: string;
        verification_status: string;
        retention_class: string;
      }>
    ).map((row) => ({
      digest: row.digest,
      type: row.type,
      verification: row.verification_status,
      retention: row.retention_class,
    })),
  };
}

export function buildRecoveryInventory(): RecoveryInventory {
  ensureFleetIdentity();
  return buildRecoveryInventoryFromDatabase(getSqlite()!);
}

function collectRecoveryFiles(root: string, databaseSnapshot: string): RecoveryFile[] {
  const files: Array<{ source: string; path: string }> = [
    { source: databaseSnapshot, path: 'deploy.db' },
  ];
  const snapshot = new Database(databaseSnapshot, { readonly: true, fileMustExist: true });
  try {
    const artifacts = snapshot
      .prepare(
        `SELECT DISTINCT artifact.digest, artifact.local_path
           FROM artifacts artifact
           JOIN application_spec_revisions revision
             ON artifact.digest IN
                (revision.original_artifact_digest, revision.normalized_artifact_digest)
          WHERE artifact.verification_status = 'verified'`,
      )
      .all() as Array<{ digest: string; local_path: string }>;
    for (const artifact of artifacts) {
      if (!existsSync(artifact.local_path)) {
        throw new Error(`Application revision artifact is missing: ${artifact.digest}`);
      }
      const hash = artifact.digest.replace(/^sha256:/, '');
      files.push({
        source: artifact.local_path,
        path: `blobs/sha256/${hash.slice(0, 2)}/${hash}`,
      });
    }
  } finally {
    snapshot.close();
  }
  // `certs/ca.key` is the fleet TLS trust anchor. Losing it during Home
  // recovery would force already-paired suitcases and clients to trust a new
  // fleet. Keep it inside the encrypted recovery boundary next to the signing
  // identities and secret-store key. `certificates` remains a legacy import
  // path for installations that used the old directory name.
  for (const directory of ['identities', 'secrets', 'certs', 'certificates']) {
    const sourceRoot = resolve(root, directory);
    if (!existsSync(sourceRoot)) continue;
    const queue = [sourceRoot];
    while (queue.length > 0) {
      const path = queue.pop()!;
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile()))
        throw new Error(`Recovery material contains an unsupported special file: ${path}`);
      if (metadata.isDirectory()) {
        for (const child of readdirSync(path)) queue.push(resolve(path, child));
      } else {
        files.push({ source: path, path: relative(root, path).split(sep).join('/') });
      }
    }
  }
  return files
    .map(({ source, path }) => {
      const content = readFileSync(source);
      return {
        path,
        mode: statSync(source).mode & 0o777,
        byteSize: content.length,
        digest: digestBytes(content),
        content: content.toString('base64'),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function encryptPayload(payload: RecoveryPayload, passphrase: string): RecoveryEnvelope {
  assertRecoveryPassphrase(passphrase);
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const parameters = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
  const key = scryptSync(passphrase, salt, 32, parameters);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(RECOVERY_AAD);
  const ciphertext = Buffer.concat([cipher.update(canonical(payload), 'utf8'), cipher.final()]);
  return {
    kind: 'deploy.local/HomeRecoveryBundle',
    formatVersion: RECOVERY_FORMAT_VERSION,
    kdf: {
      name: 'scrypt',
      salt: salt.toString('base64url'),
      N: parameters.N,
      r: parameters.r,
      p: parameters.p,
    },
    encryption: {
      name: 'aes-256-gcm',
      nonce: nonce.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
    },
    ciphertext: ciphertext.toString('base64url'),
  };
}

function decryptEnvelope(path: string, passphrase: string): RecoveryPayload {
  assertRecoveryPassphrase(passphrase);
  const envelope = JSON.parse(readFileSync(path, 'utf8')) as RecoveryEnvelope;
  if (
    envelope.kind !== 'deploy.local/HomeRecoveryBundle' ||
    envelope.formatVersion !== RECOVERY_FORMAT_VERSION ||
    envelope.kdf?.name !== 'scrypt' ||
    envelope.encryption?.name !== 'aes-256-gcm'
  )
    throw new Error('Unsupported recovery bundle format');
  const salt = Buffer.from(envelope.kdf.salt, 'base64url');
  const nonce = Buffer.from(envelope.encryption.nonce, 'base64url');
  const tag = Buffer.from(envelope.encryption.tag, 'base64url');
  const key = scryptSync(passphrase, salt, 32, {
    N: envelope.kdf.N,
    r: envelope.kdf.r,
    p: envelope.kdf.p,
    maxmem: 64 * 1024 * 1024,
  });
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(RECOVERY_AAD);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
    decipher.final(),
  ]);
  const payload = JSON.parse(plaintext.toString('utf8')) as RecoveryPayload;
  if (payload.formatVersion !== RECOVERY_FORMAT_VERSION)
    throw new Error('Invalid recovery payload');
  return payload;
}

function validatePayload(payload: RecoveryPayload): void {
  if (digest(payload.inventory) !== payload.inventoryDigest)
    throw new Error('Recovery inventory digest mismatch');
  if (
    payload.inventory.fleetId !== payload.fleetId ||
    payload.inventory.homeSiteId !== payload.homeSiteId
  )
    throw new Error('Recovery fleet identity does not match its inventory');
  if (payload.activeSuitcaseCredentials) {
    const siteIds = new Set<string>();
    for (const credential of payload.activeSuitcaseCredentials) {
      if (
        !credential.siteId ||
        siteIds.has(credential.siteId) ||
        !SHA256_HEX.test(credential.credentialHash)
      ) {
        throw new Error('Recovery bundle contains invalid active Suitcase credential evidence');
      }
      siteIds.add(credential.siteId);
    }
  }
  const paths = new Set<string>();
  for (const file of payload.files) {
    if (
      !file.path ||
      file.path.startsWith('/') ||
      file.path.split('/').includes('..') ||
      paths.has(file.path)
    )
      throw new Error('Recovery bundle contains an unsafe or duplicate path');
    paths.add(file.path);
    const content = Buffer.from(file.content, 'base64');
    if (content.length !== file.byteSize || digestBytes(content) !== file.digest)
      throw new Error(`Recovery file verification failed: ${file.path}`);
  }
  if (!paths.has('deploy.db'))
    throw new Error('Recovery bundle is missing the control-plane database');
  if (!paths.has(`identities/${payload.homeSiteId}.json`))
    throw new Error('Recovery bundle is missing the Home site identity');
  if (!paths.has('secrets/master.key') && !process.env.DEPLOY_SECRET_KEY)
    throw new Error('Recovery bundle is missing the secret-store recovery key');
  if (!paths.has('certs/ca.key') || !paths.has('certs/ca.crt'))
    throw new Error('Recovery bundle is missing the fleet TLS trust anchor');
}

function extractPayload(payload: RecoveryPayload, destinationDirectory: string): void {
  const destination = resolve(destinationDirectory);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const file of payload.files) {
    const path = resolve(destination, file.path);
    if (path !== destination && !path.startsWith(`${destination}${sep}`))
      throw new Error('Recovery file escapes the destination');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, Buffer.from(file.content, 'base64'), {
      mode: file.mode,
      flag: 'wx',
    });
    chmodSync(path, file.mode);
  }
}

function verifyExtractedDatabase(directory: string, payload: RecoveryPayload): void {
  const database = new Database(resolve(directory, 'deploy.db'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const integrity = database.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
      throw new Error('Recovered control-plane database failed integrity_check');
    const fleet = database
      .prepare('SELECT id, home_site_id FROM fleets WHERE id = ?')
      .get(payload.fleetId) as { id: string; home_site_id: string } | undefined;
    if (!fleet || fleet.home_site_id !== payload.homeSiteId)
      throw new Error('Recovered database does not contain the expected fleet identity');
  } finally {
    database.close();
  }
}

function publicKeyDer(value: string | Buffer | KeyObject): Buffer {
  const key = typeof value === 'string' || Buffer.isBuffer(value) ? createPublicKey(value) : value;
  return key.export({ type: 'spki', format: 'der' });
}

function readRehearsalSecretKey(directory: string): {
  key: Buffer;
  source: 'bundle' | 'environment';
} {
  const path = resolve(directory, 'secrets', 'master.key');
  if (existsSync(path)) {
    const key = readFileSync(path);
    if (key.length !== 32) throw new Error('Recovered secret-store key is invalid');
    return { key, source: 'bundle' };
  }
  const encoded = process.env.DEPLOY_SECRET_KEY?.trim();
  if (!encoded) throw new Error('Recovered Home has no secret-store recovery key');
  const key = /^[0-9a-f]{64}$/i.test(encoded)
    ? Buffer.from(encoded, 'hex')
    : Buffer.from(encoded, 'base64url');
  if (key.length !== 32) throw new Error('Recovered secret-store environment key is invalid');
  return { key, source: 'environment' };
}

function auditRecoveryMaterials(
  directory: string,
  payload: RecoveryPayload,
  database: InstanceType<typeof Database>,
): {
  encryptedConfigurationValues: number;
  secretStoreKey: 'bundle' | 'environment';
} {
  const caKey = readFileSync(resolve(directory, 'certs', 'ca.key'));
  const caCertificate = new X509Certificate(readFileSync(resolve(directory, 'certs', 'ca.crt')));
  if (!publicKeyDer(caKey).equals(publicKeyDer(caCertificate.publicKey))) {
    throw new Error('Recovered fleet CA certificate does not match its private key');
  }
  if (!caCertificate.ca || !caCertificate.verify(caCertificate.publicKey)) {
    throw new Error('Recovered fleet CA is not a self-signed certificate authority');
  }
  const now = Date.now();
  if (now < Date.parse(caCertificate.validFrom) || now > Date.parse(caCertificate.validTo)) {
    throw new Error('Recovered fleet CA is outside its validity period');
  }

  const fleet = database
    .prepare('SELECT root_public_identity FROM fleets WHERE id = ?')
    .get(payload.fleetId) as { root_public_identity: string };
  const home = database
    .prepare('SELECT public_key FROM sites WHERE id = ? AND kind = ?')
    .get(payload.homeSiteId, 'home') as { public_key: string } | undefined;
  const identity = JSON.parse(
    readFileSync(resolve(directory, 'identities', `${payload.homeSiteId}.json`), 'utf8'),
  ) as { siteId?: string; publicKey?: string; privateKey?: string };
  if (
    identity.siteId !== payload.homeSiteId ||
    !identity.publicKey ||
    !identity.privateKey ||
    !home ||
    !publicKeyDer(identity.publicKey).equals(publicKeyDer(identity.privateKey)) ||
    !publicKeyDer(identity.publicKey).equals(publicKeyDer(fleet.root_public_identity)) ||
    !publicKeyDer(identity.publicKey).equals(publicKeyDer(home.public_key))
  ) {
    throw new Error('Recovered Home signing identity does not match fleet and site identity');
  }
  const probe = Buffer.from(`deploy.local recovery rehearsal:${payload.inventoryDigest}`);
  const signature = sign(null, probe, createPrivateKey(identity.privateKey));
  if (!verify(null, probe, createPublicKey(identity.publicKey), signature)) {
    throw new Error('Recovered Home signing identity cannot sign and verify fleet events');
  }

  const secret = readRehearsalSecretKey(directory);
  const encryptedValues = database
    .prepare(
      `SELECT deployment_name, spec_digest, key, site_id, value
         FROM application_configuration_values WHERE value_type = 'secret'`,
    )
    .all() as Array<{
    deployment_name: string;
    spec_digest: string;
    key: string;
    site_id: string;
    value: string;
  }>;
  for (const value of encryptedValues) {
    decryptSecret(
      value.value,
      secret.key,
      secretAddress(value.deployment_name, value.key, value.site_id, value.spec_digest),
    );
  }
  return {
    encryptedConfigurationValues: encryptedValues.length,
    secretStoreKey: secret.source,
  };
}

function auditApplicationLineage(
  database: InstanceType<typeof Database>,
  directory: string,
): {
  applicationRevisions: number;
  applicationAliases: number;
  dataPolicies: number;
  checkpoints: number;
} {
  const deployments = database
    .prepare('SELECT name, app_id, desired_spec_digest, active_spec_digest FROM deployments')
    .all() as Array<{
    name: string;
    app_id: string | null;
    desired_spec_digest: string | null;
    active_spec_digest: string | null;
  }>;
  const applicationIds = new Set(
    deployments.map((deployment) => deployment.app_id).filter((value): value is string => !!value),
  );
  const deploymentNames = new Set(deployments.map((deployment) => deployment.name));
  const revisions = database
    .prepare(
      `SELECT deployment_name, digest, parent_digest,
              original_artifact_digest, normalized_artifact_digest
         FROM application_spec_revisions`,
    )
    .all() as Array<{
    deployment_name: string;
    digest: string;
    parent_digest: string | null;
    original_artifact_digest: string | null;
    normalized_artifact_digest: string | null;
  }>;
  const revisionSets = new Map<string, Set<string>>();
  const revisionParents = new Map<string, Map<string, string | null>>();
  for (const revision of revisions) {
    if (!deploymentNames.has(revision.deployment_name)) {
      throw new Error('Recovered application revision is detached from its deployment');
    }
    const digests = revisionSets.get(revision.deployment_name) || new Set<string>();
    digests.add(revision.digest);
    revisionSets.set(revision.deployment_name, digests);
    const parents =
      revisionParents.get(revision.deployment_name) || new Map<string, string | null>();
    parents.set(revision.digest, revision.parent_digest);
    revisionParents.set(revision.deployment_name, parents);
    if (!revision.normalized_artifact_digest) {
      throw new Error('Recovered application revision has no normalized content artifact');
    }
    if (revision.normalized_artifact_digest !== revision.digest) {
      throw new Error('Recovered application revision digest does not match normalized content');
    }
    for (const artifactDigest of [
      revision.original_artifact_digest,
      revision.normalized_artifact_digest,
    ]) {
      if (!artifactDigest) continue;
      const artifact = database
        .prepare('SELECT verification_status FROM artifacts WHERE digest = ?')
        .get(artifactDigest) as { verification_status: string } | undefined;
      const hash = artifactDigest.replace(/^sha256:/, '');
      const artifactPath = resolve(directory, 'blobs', 'sha256', hash.slice(0, 2), hash);
      if (
        !artifact ||
        artifact.verification_status !== 'verified' ||
        !existsSync(artifactPath) ||
        digestBytes(readFileSync(artifactPath)) !== artifactDigest
      ) {
        throw new Error('Recovered application revision artifact failed verification');
      }
    }
  }
  for (const deployment of deployments) {
    const known = revisionSets.get(deployment.name) || new Set<string>();
    for (const digestValue of [deployment.desired_spec_digest, deployment.active_spec_digest]) {
      if (digestValue && !known.has(digestValue)) {
        throw new Error(`Recovered application ${deployment.name} references a missing revision`);
      }
    }
  }
  for (const [deploymentName, parents] of revisionParents) {
    for (const [digestValue, parent] of parents) {
      if (parent && !parents.has(parent)) {
        throw new Error(`Recovered application ${deploymentName} has a detached revision parent`);
      }
      const seen = new Set<string>();
      let cursor: string | null = digestValue;
      while (cursor) {
        if (seen.has(cursor)) {
          throw new Error(`Recovered application ${deploymentName} has a cyclic revision lineage`);
        }
        seen.add(cursor);
        cursor = parents.get(cursor) || null;
      }
    }
  }
  const transitions = database
    .prepare(
      'SELECT deployment_name, from_digest, to_digest FROM application_spec_transitions ORDER BY id',
    )
    .all() as Array<{ deployment_name: string; from_digest: string | null; to_digest: string }>;
  for (const transition of transitions) {
    const known = revisionSets.get(transition.deployment_name);
    if (
      !deploymentNames.has(transition.deployment_name) ||
      !known?.has(transition.to_digest) ||
      (transition.from_digest && !known.has(transition.from_digest))
    ) {
      throw new Error(
        `Recovered application ${transition.deployment_name} has a broken transition`,
      );
    }
  }

  const siteIds = new Set(
    (database.prepare('SELECT id FROM sites').all() as Array<{ id: string }>).map(
      (site) => site.id,
    ),
  );
  const configurationValues = database
    .prepare('SELECT deployment_name, spec_digest, site_id FROM application_configuration_values')
    .all() as Array<{ deployment_name: string; spec_digest: string; site_id: string }>;
  for (const value of configurationValues) {
    if (
      !revisionSets.get(value.deployment_name)?.has(value.spec_digest) ||
      (value.site_id && !siteIds.has(value.site_id))
    ) {
      throw new Error('Recovered application configuration is detached from its revision or site');
    }
  }
  const aliases = database
    .prepare('SELECT fleet_id, app_id, origin_site_id FROM application_aliases')
    .all() as Array<{ fleet_id: string; app_id: string; origin_site_id: string }>;
  const fleetIds = new Set(
    (database.prepare('SELECT id FROM fleets').all() as Array<{ id: string }>).map(
      (fleet) => fleet.id,
    ),
  );
  for (const alias of aliases) {
    if (
      !fleetIds.has(alias.fleet_id) ||
      !applicationIds.has(alias.app_id) ||
      !siteIds.has(alias.origin_site_id)
    ) {
      throw new Error(
        'Recovered application alias is detached from its fleet, app, or origin site',
      );
    }
  }

  const policies = database
    .prepare(
      'SELECT app_id, site_id, policy, conflict_policy, acknowledged_risks, revision FROM data_sync_policies',
    )
    .all() as Array<{
    app_id: string;
    site_id: string;
    policy: string;
    conflict_policy: string;
    acknowledged_risks: string;
    revision: number;
  }>;
  for (const policy of policies) {
    if (
      !applicationIds.has(policy.app_id) ||
      (policy.site_id && !siteIds.has(policy.site_id)) ||
      !['automatic', 'manual', 'none'].includes(policy.policy) ||
      !['collect', 'prefer-home', 'prefer-suitcase'].includes(policy.conflict_policy) ||
      !Number.isSafeInteger(policy.revision) ||
      policy.revision < 1
    ) {
      throw new Error('Recovered data sync policy has an invalid app, site, mode, or revision');
    }
    const risks = JSON.parse(policy.acknowledged_risks) as unknown;
    if (!Array.isArray(risks) || risks.some((risk) => typeof risk !== 'string')) {
      throw new Error('Recovered data sync policy has invalid risk acknowledgements');
    }
  }

  const checkpoints = database
    .prepare(
      `SELECT id, app_id, parent_id, origin_site_id, sequence, manifest_artifact_digest
         FROM data_checkpoints`,
    )
    .all() as Array<{
    id: string;
    app_id: string;
    parent_id: string | null;
    origin_site_id: string;
    sequence: number;
    manifest_artifact_digest: string;
  }>;
  const checkpointMap = new Map(checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
  for (const checkpoint of checkpoints) {
    const parent = checkpoint.parent_id ? checkpointMap.get(checkpoint.parent_id) : undefined;
    if (
      !applicationIds.has(checkpoint.app_id) ||
      !siteIds.has(checkpoint.origin_site_id) ||
      !Number.isSafeInteger(checkpoint.sequence) ||
      checkpoint.sequence < 1 ||
      !/^sha256:[a-f0-9]{64}$/.test(checkpoint.manifest_artifact_digest) ||
      (checkpoint.parent_id &&
        (!parent || parent.app_id !== checkpoint.app_id || parent.sequence >= checkpoint.sequence))
    ) {
      throw new Error('Recovered checkpoint has an invalid app, site, sequence, digest, or parent');
    }
    const seen = new Set<string>();
    let cursor: typeof checkpoint | undefined = checkpoint;
    while (cursor) {
      if (seen.has(cursor.id)) throw new Error('Recovered checkpoint lineage contains a cycle');
      seen.add(cursor.id);
      cursor = cursor.parent_id ? checkpointMap.get(cursor.parent_id) : undefined;
    }
  }
  const replicaCheckpoints = database
    .prepare(
      `SELECT app_id, base_checkpoint_id, branch_checkpoint_id FROM app_replicas
        WHERE base_checkpoint_id IS NOT NULL OR branch_checkpoint_id IS NOT NULL`,
    )
    .all() as Array<{
    app_id: string;
    base_checkpoint_id: string | null;
    branch_checkpoint_id: string | null;
  }>;
  for (const replica of replicaCheckpoints) {
    for (const checkpointId of [replica.base_checkpoint_id, replica.branch_checkpoint_id]) {
      if (checkpointId && checkpointMap.get(checkpointId)?.app_id !== replica.app_id) {
        throw new Error('Recovered replica references a missing or foreign checkpoint');
      }
    }
  }
  return {
    applicationRevisions: revisions.length,
    applicationAliases: aliases.length,
    dataPolicies: policies.length,
    checkpoints: checkpoints.length,
  };
}

function auditRestoredRecovery(
  directory: string,
  payload: RecoveryPayload,
  bundleId: string,
): RecoveryRehearsalReport {
  const database = new Database(resolve(directory, 'deploy.db'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const integrity = database.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new Error('Rehearsed control-plane database failed integrity_check');
    }
    const restoredInventory = buildRecoveryInventoryFromDatabase(database);
    if (
      digest(restoredInventory) !== payload.inventoryDigest ||
      canonical(restoredInventory) !== canonical(payload.inventory)
    ) {
      throw new Error('Rehearsed database inventory differs from the encrypted recovery inventory');
    }
    const fleets = database
      .prepare('SELECT id, home_site_id, root_public_identity FROM fleets')
      .all() as Array<{ id: string; home_site_id: string; root_public_identity: string }>;
    if (
      fleets.length !== 1 ||
      fleets[0]?.id !== payload.fleetId ||
      fleets[0]?.home_site_id !== payload.homeSiteId
    ) {
      throw new Error('Rehearsed database does not contain exactly one expected fleet identity');
    }
    const sites = database
      .prepare(
        `SELECT id, fleet_id, kind, public_key, credential_hash, credential_status,
                revoked_at, removed_at FROM sites`,
      )
      .all() as Array<{
      id: string;
      fleet_id: string;
      kind: string;
      public_key: string;
      credential_hash: string | null;
      credential_status: string;
      revoked_at: string | null;
      removed_at: string | null;
    }>;
    if (
      new Set(sites.map((site) => site.id)).size !== sites.length ||
      sites.some((site) => site.fleet_id !== payload.fleetId) ||
      sites.filter((site) => site.kind === 'home').length !== 1 ||
      !sites.some((site) => site.id === payload.homeSiteId && site.kind === 'home')
    ) {
      throw new Error('Rehearsed database contains duplicate, foreign, or ambiguous site identity');
    }
    const activeSuitcases = sites.filter(
      (site) =>
        site.kind === 'suitcase' &&
        site.credential_status === 'active' &&
        !site.revoked_at &&
        !site.removed_at,
    );
    if (
      new Set(activeSuitcases.map((site) => site.credential_hash)).size !== activeSuitcases.length
    ) {
      throw new Error('Rehearsed active Suitcase credential hashes are not unique');
    }
    for (const site of activeSuitcases) {
      if (!site.credential_hash || !SHA256_HEX.test(site.credential_hash)) {
        throw new Error(`Rehearsed active Suitcase ${site.id} has no valid credential hash`);
      }
      createPublicKey(site.public_key);
    }
    if (payload.activeSuitcaseCredentials) {
      const restoredCredentials = activeSuitcases
        .map((site) => ({ siteId: site.id, credentialHash: site.credential_hash! }))
        .sort((left, right) => left.siteId.localeCompare(right.siteId));
      if (canonical(restoredCredentials) !== canonical(payload.activeSuitcaseCredentials)) {
        throw new Error('Rehearsed active Suitcase credential hashes differ from the bundle');
      }
    }

    const lineage = auditApplicationLineage(database, directory);
    const materials = auditRecoveryMaterials(directory, payload, database);
    return {
      bundleId,
      passed: true,
      fleetId: payload.fleetId,
      homeSiteId: payload.homeSiteId,
      inventoryDigest: payload.inventoryDigest,
      checks: {
        inventoryTables: Object.keys(payload.inventory.counts).length,
        fleets: fleets.length,
        sites: sites.length,
        activeSuitcaseCredentials: activeSuitcases.length,
        ...lineage,
        encryptedConfigurationValues: materials.encryptedConfigurationValues,
        caKeyPair: true,
        homeSigningIdentity: true,
        secretStoreKey: materials.secretStoreKey,
      },
    };
  } finally {
    database.close();
  }
}

export async function createRecoveryBundle(input: {
  outputPath: string;
  passphrase: string;
}): Promise<{ id: string; artifactDigest: string; inventoryDigest: string }> {
  ensureApplicationRevisionArtifacts();
  const fleet = ensureFleetIdentity();
  const temporary = mkdtempSync(join(tmpdir(), 'deploy-recovery-create-'));
  try {
    const databaseSnapshot = resolve(temporary, 'deploy.db');
    await getSqlite()!.backup(databaseSnapshot);
    const snapshotDatabase = new Database(databaseSnapshot, {
      readonly: true,
      fileMustExist: true,
    });
    let inventory: RecoveryInventory;
    let activeSuitcaseCredentials: Array<{ siteId: string; credentialHash: string }>;
    try {
      inventory = buildRecoveryInventoryFromDatabase(snapshotDatabase);
      activeSuitcaseCredentials = (
        snapshotDatabase
          .prepare(
            `SELECT id, credential_hash FROM sites
              WHERE kind = 'suitcase' AND credential_status = 'active'
                AND credential_hash IS NOT NULL AND revoked_at IS NULL AND removed_at IS NULL
              ORDER BY id`,
          )
          .all() as Array<{ id: string; credential_hash: string }>
      ).map((site) => ({ siteId: site.id, credentialHash: site.credential_hash }));
    } finally {
      snapshotDatabase.close();
    }
    const payload: RecoveryPayload = {
      formatVersion: RECOVERY_FORMAT_VERSION,
      fleetId: fleet.id,
      homeSiteId: fleet.homeSiteId,
      createdAt: new Date().toISOString(),
      inventory,
      inventoryDigest: digest(inventory),
      activeSuitcaseCredentials,
      files: collectRecoveryFiles(deployDataDirectory(), databaseSnapshot),
    };
    validatePayload(payload);
    const envelope = encryptPayload(payload, input.passphrase);
    const output = resolve(input.outputPath);
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    writeFileSync(output, `${JSON.stringify(envelope)}\n`, { mode: 0o600, flag: 'wx' });
    const artifact = await putArtifactFile(output, {
      type: 'home-recovery-bundle',
      mediaType: 'application/vnd.deploy.home-recovery+json',
      retentionClass: 'recovery',
    });
    const id = sortableId('recovery');
    getSqlite()!
      .prepare(
        `INSERT INTO fleet_recovery_bundles
          (id, fleet_id, format_version, artifact_digest, encryption_metadata,
           inventory_digest, verification_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending-verification', ?)`,
      )
      .run(
        id,
        fleet.id,
        RECOVERY_FORMAT_VERSION,
        artifact.digest,
        JSON.stringify({ kdf: envelope.kdf, encryption: { name: envelope.encryption.name } }),
        payload.inventoryDigest,
        payload.createdAt,
      );
    return { id, artifactDigest: artifact.digest, inventoryDigest: payload.inventoryDigest };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function verifyRecoveryBundle(input: {
  bundlePath: string;
  passphrase: string;
  bundleId?: string;
}): { fleetId: string; homeSiteId: string; inventoryDigest: string; files: number } {
  const payload = decryptEnvelope(input.bundlePath, input.passphrase);
  validatePayload(payload);
  const temporary = mkdtempSync(join(tmpdir(), 'deploy-recovery-verify-'));
  try {
    extractPayload(payload, temporary);
    verifyExtractedDatabase(temporary, payload);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  if (input.bundleId) {
    const result = getSqlite()!
      .prepare(
        `UPDATE fleet_recovery_bundles
            SET verification_status = 'verified', verified_at = ?
          WHERE id = ? AND inventory_digest = ?`,
      )
      .run(new Date().toISOString(), input.bundleId, payload.inventoryDigest);
    if (result.changes !== 1)
      throw new Error('Recovery bundle record does not match verified payload');
  }
  return {
    fleetId: payload.fleetId,
    homeSiteId: payload.homeSiteId,
    inventoryDigest: payload.inventoryDigest,
    files: payload.files.length,
  };
}

export function restoreRecoveryBundle(input: {
  bundlePath: string;
  passphrase: string;
  destinationDataDirectory: string;
}): { fleetId: string; homeSiteId: string; inventory: RecoveryInventory } {
  const destination = resolve(input.destinationDataDirectory);
  if (destination === resolve(deployDataDirectory()))
    throw new Error(
      'Online in-place restore is not allowed; restore onto a clean replacement Home',
    );
  if (existsSync(destination) && readdirSync(destination).length > 0)
    throw new Error('Recovery destination must be empty');
  const payload = decryptEnvelope(input.bundlePath, input.passphrase);
  validatePayload(payload);
  try {
    extractPayload(payload, destination);
    verifyExtractedDatabase(destination, payload);
    const restoredDatabase = new Database(join(destination, 'deploy.db'));
    try {
      const now = new Date().toISOString();
      const revisionArtifacts = restoredDatabase
        .prepare(
          `SELECT original_artifact_digest, normalized_artifact_digest
             FROM application_spec_revisions`,
        )
        .all() as Array<{
        original_artifact_digest: string | null;
        normalized_artifact_digest: string | null;
      }>;
      const updateArtifactPath = restoredDatabase.prepare(
        'UPDATE artifacts SET local_path = ?, last_access_at = ? WHERE digest = ?',
      );
      for (const digest of new Set(
        revisionArtifacts.flatMap((revision) => [
          revision.original_artifact_digest,
          revision.normalized_artifact_digest,
        ]),
      )) {
        if (!digest) continue;
        const hash = digest.replace(/^sha256:/, '');
        updateArtifactPath.run(
          resolve(destination, 'blobs', 'sha256', hash.slice(0, 2), hash),
          now,
          digest,
        );
      }
      restoredDatabase
        .prepare(
          `UPDATE sites
              SET credential_status = 'recovery-pending', mode = 'recovery',
                  quarantine_reason = ?, updated_at = ?
            WHERE kind = 'suitcase' AND revoked_at IS NULL AND removed_at IS NULL
              AND credential_hash IS NOT NULL AND credential_status != 'revoked'`,
        )
        .run(
          JSON.stringify({
            kind: 'home-recovery-readoption-required',
            message:
              'Recovered Home must verify Suitcase identity, cursors, authority, and lineage before synchronization resumes',
          }),
          now,
        );
    } finally {
      restoredDatabase.close();
    }
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
  return { fleetId: payload.fleetId, homeSiteId: payload.homeSiteId, inventory: payload.inventory };
}

export function rehearseRecoveryBundle(input: {
  bundleId: string;
  bundlePath: string;
  passphrase: string;
}): RecoveryRehearsalReport {
  const record = getSqlite()!
    .prepare(
      `SELECT fleet_id, artifact_digest, inventory_digest, verification_status
         FROM fleet_recovery_bundles WHERE id = ?`,
    )
    .get(input.bundleId) as
    | {
        fleet_id: string;
        artifact_digest: string;
        inventory_digest: string;
        verification_status: string;
      }
    | undefined;
  if (!record || record.verification_status !== 'verified') {
    throw new Error('Only a verified recovery bundle can be rehearsed');
  }
  if (digestBytes(readFileSync(input.bundlePath)) !== record.artifact_digest) {
    throw new Error('Recovery rehearsal path does not match the verified bundle record');
  }
  const payload = decryptEnvelope(input.bundlePath, input.passphrase);
  validatePayload(payload);
  if (payload.fleetId !== record.fleet_id || payload.inventoryDigest !== record.inventory_digest) {
    throw new Error('Recovery rehearsal payload does not match the verified bundle record');
  }

  const temporary = mkdtempSync(join(tmpdir(), 'deploy-recovery-rehearsal-'));
  try {
    extractPayload(payload, temporary);
    const report = auditRestoredRecovery(temporary, payload, input.bundleId);
    const updated = getSqlite()!
      .prepare(
        `UPDATE fleet_recovery_bundles
            SET rehearsal_status = 'passed', rehearsed_at = ?
          WHERE id = ? AND fleet_id = ? AND inventory_digest = ?
            AND verification_status = 'verified'`,
      )
      .run(new Date().toISOString(), input.bundleId, payload.fleetId, payload.inventoryDigest);
    if (updated.changes !== 1) {
      throw new Error('Recovery bundle record changed during its rehearsal');
    }
    return report;
  } catch (error) {
    getSqlite()!
      .prepare(
        `UPDATE fleet_recovery_bundles
            SET rehearsal_status = 'failed', rehearsed_at = ?
          WHERE id = ? AND verification_status = 'verified'`,
      )
      .run(new Date().toISOString(), input.bundleId);
    throw error;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
