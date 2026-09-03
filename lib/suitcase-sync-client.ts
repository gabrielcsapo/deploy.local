import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  createPrivateKey,
  createPublicKey,
} from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { arch, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildFleetEventBody, canonicalFleetPayload } from '../server/multisite.ts';
import { getSqlite } from '../server/store.ts';
import type {
  SiteApplicationRecoveryEvidence,
  SiteCredentialProof,
  SiteCredentialProofPurpose,
} from '../server/recovery-readoption.ts';
import type { WireFleetEvent } from '../server/suitcase-transport.ts';
import type { WireFleetTelemetryRecord } from '../server/fleet-telemetry.ts';
import type { AdministratorProjection } from '../server/offline-auth.ts';
import { suitcaseTargetPaths } from './suitcase-target.ts';

const PROTOCOL_VERSION = 1;
const CHUNK_BYTES = 1024 * 1024;
const DIGEST_PATTERN = /^sha256:([a-f0-9]{64})$/;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface QueuedArtifact {
  digest: string;
  path: string;
  type: string;
  mediaType?: string;
  retentionClass?: string;
}

export interface SuitcaseMembership {
  schemaVersion: 1;
  targetId: string;
  coordinatorUrl: string;
  siteId: string;
  fleetId: string;
  homeSiteId: string;
  credential: string;
  protocolVersion: number;
  name: string;
  defaultDataPolicy: 'automatic' | 'manual' | 'none';
  accessMode: string;
  securityProfile: string;
  publicKey: string;
  privateKey: string;
  tls?: {
    privateKey: string;
    intermediateCertificate: string;
    rootCertificate: string;
  };
  siteKeys: Record<string, string>;
  mode: 'docked' | 'away' | 'rejoining';
  nextOriginSequence: number;
  acknowledgedLocalSequence: number;
  cursors: Record<string, number>;
  outbox: WireFleetEvent[];
  inbox: WireFleetEvent[];
  projectedEventIds: string[];
  telemetryCursors: Record<string, number>;
  telemetryInbox: WireFleetTelemetryRecord[];
  projectedTelemetryIds: string[];
  acknowledgedLocalTelemetrySequence: number;
  outgoingArtifacts: QueuedArtifact[];
  pairedAt: string;
  lastSyncAt?: string;
  lastSyncError?: string;
}

function withTlsScratch<T>(operation: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'deploy-suitcase-tls-'));
  try {
    return operation(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function openssl(args: string[], encoding?: BufferEncoding): Buffer | string {
  try {
    return execFileSync('openssl', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding,
    });
  } catch (error) {
    throw new Error(
      `Unable to prepare suitcase TLS identity: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function keyDer(value: string | Buffer): Buffer {
  return createPublicKey(value).export({ type: 'spki', format: 'der' });
}

function generateSuitcaseIntermediateRequest(): { privateKey: string; csr: string } {
  return withTlsScratch((directory) => {
    const privateKeyPath = join(directory, 'issuer.key');
    const csrPath = join(directory, 'issuer.csr');
    openssl([
      'req',
      '-new',
      '-newkey',
      'rsa:3072',
      '-nodes',
      '-keyout',
      privateKeyPath,
      '-out',
      csrPath,
      '-subj',
      '/CN=deploy.local Suitcase Intermediate',
      '-sha256',
    ]);
    const privateKey = readFileSync(privateKeyPath, 'utf8');
    const csr = readFileSync(csrPath, 'utf8');
    const csrPublicKey = openssl(['req', '-in', csrPath, '-pubkey', '-noout']) as Buffer;
    if (!keyDer(privateKey).equals(keyDer(csrPublicKey))) {
      throw new Error('Suitcase intermediate CSR does not match its locally generated private key');
    }
    return { privateKey, csr };
  });
}

function validatePairedTlsIdentity(input: {
  privateKey: string;
  intermediateCertificate: string;
  rootCertificate: string;
}): void {
  const rootCount = input.rootCertificate?.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0;
  const intermediateCount =
    input.intermediateCertificate?.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0;
  if (
    typeof input.rootCertificate !== 'string' ||
    typeof input.intermediateCertificate !== 'string' ||
    rootCount !== 1 ||
    intermediateCount !== 1 ||
    Buffer.byteLength(input.rootCertificate) > 64 * 1024 ||
    Buffer.byteLength(input.intermediateCertificate) > 64 * 1024 ||
    input.rootCertificate.includes('PRIVATE KEY') ||
    input.intermediateCertificate.includes('PRIVATE KEY')
  ) {
    throw new Error('Coordinator returned invalid suitcase certificate material');
  }
  withTlsScratch((directory) => {
    const rootPath = join(directory, 'ca.crt');
    const intermediatePath = join(directory, 'issuer.crt');
    writeFileSync(rootPath, input.rootCertificate);
    writeFileSync(intermediatePath, input.intermediateCertificate);
    openssl(['verify', '-CAfile', rootPath, rootPath]);
    openssl(['verify', '-CAfile', rootPath, intermediatePath]);
    const certificatePublicKey = openssl([
      'x509',
      '-in',
      intermediatePath,
      '-pubkey',
      '-noout',
    ]) as Buffer;
    if (!keyDer(input.privateKey).equals(keyDer(certificatePublicKey))) {
      throw new Error('Coordinator certificate does not match the suitcase intermediate key');
    }
    const description = openssl(['x509', '-in', intermediatePath, '-noout', '-text'], 'utf8');
    if (
      !/Basic Constraints:\s*critical[\s\S]*?CA:TRUE,\s*pathlen:0/.test(description as string) ||
      !/Key Usage:\s*critical[\s\S]*?Certificate Sign/.test(description as string) ||
      !/Name Constraints:\s*critical/.test(description as string) ||
      !/DNS:\.local/.test(description as string) ||
      !/DNS:localhost/.test(description as string)
    ) {
      throw new Error('Coordinator certificate is not a constrained suitcase intermediate');
    }
  });
}

export interface ClientOptions {
  directory?: string;
  membershipFile?: string;
  fetch?: FetchLike;
  now?: () => Date;
  manualSync?: boolean;
  manualSyncAppIds?: string[];
  /** Authenticated target facts refreshed with every successful exchange. */
  capabilities?: Record<string, unknown>;
  telemetry?: WireFleetTelemetryRecord[];
  telemetryArtifacts?: QueuedArtifact[];
  projectEvent?: (
    event: WireFleetEvent,
    artifactPaths: Record<string, string>,
    membership: SuitcaseMembership,
  ) => Promise<void> | void;
  projectTelemetry?: (
    records: WireFleetTelemetryRecord[],
    membership: SuitcaseMembership,
  ) => Promise<void> | void;
}

export async function withSuitcaseMembershipLock<T>(
  membershipFile: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  const lockPath = `${resolve(membershipFile)}.lock`;
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let owner = 0;
    try {
      owner = Number(JSON.parse(readFileSync(lockPath, 'utf8')).pid);
    } catch {
      // A partially written lock is treated as busy rather than deleted.
    }
    if (owner > 0) {
      try {
        process.kill(owner, 0);
      } catch (ownerError) {
        if ((ownerError as NodeJS.ErrnoException).code === 'ESRCH') {
          unlinkSync(lockPath);
          return withSuitcaseMembershipLock(membershipFile, operation);
        }
      }
    }
    throw new Error('Suitcase membership is busy with another core operation; retry shortly', {
      cause: error,
    });
  }
  try {
    writeSync(
      descriptor,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    );
    return await operation();
  } finally {
    closeSync(descriptor);
    if (existsSync(lockPath)) unlinkSync(lockPath);
  }
}

function administratorProjectionPath(directory?: string, membershipFile?: string): string {
  return join(
    dirname(membershipPath(directory, membershipFile)),
    'administrator-projection.pending.json',
  );
}

export function readPendingAdministratorProjection(
  directory?: string,
  membershipFile?: string,
): AdministratorProjection | undefined {
  const path = administratorProjectionPath(directory, membershipFile);
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as AdministratorProjection)
    : undefined;
}

export function clearPendingAdministratorProjection(
  directory?: string,
  membershipFile?: string,
): void {
  const path = administratorProjectionPath(directory, membershipFile);
  if (existsSync(path)) unlinkSync(path);
}

function membershipPath(directory?: string, membershipFile?: string): string {
  return membershipFile
    ? resolve(membershipFile)
    : join(suitcaseTargetPaths(directory).directory, 'fleet-membership.json');
}

function normalizeCoordinatorUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Coordinator URL must use HTTP or HTTPS');
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function loadJson(path: string): SuitcaseMembership {
  const value = JSON.parse(readFileSync(path, 'utf8')) as SuitcaseMembership;
  if (
    value.schemaVersion !== 1 ||
    !value.targetId ||
    !value.siteId ||
    !value.fleetId ||
    !value.credential ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    !value.publicKey ||
    !value.privateKey
  ) {
    throw new Error(`Suitcase fleet membership at ${path} is invalid`);
  }
  if (
    value.tls &&
    (!value.tls.privateKey ||
      !value.tls.intermediateCertificate ||
      !value.tls.rootCertificate ||
      value.tls.rootCertificate.includes('PRIVATE KEY') ||
      value.tls.intermediateCertificate.includes('PRIVATE KEY'))
  ) {
    throw new Error(`Suitcase fleet TLS membership at ${path} is invalid`);
  }
  value.cursors ??= {};
  value.outbox ??= [];
  value.inbox ??= [];
  value.projectedEventIds ??= [];
  value.telemetryCursors ??= {};
  value.telemetryInbox ??= [];
  value.projectedTelemetryIds ??= [];
  value.acknowledgedLocalTelemetrySequence ??= 0;
  value.outgoingArtifacts ??= [];
  value.acknowledgedLocalSequence ??= 0;
  value.siteKeys ??= {};
  return value;
}

function saveJson(path: string, membership: SuitcaseMembership): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(membership, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readSuitcaseMembership(
  directory?: string,
  membershipFile?: string,
): SuitcaseMembership | undefined {
  const path = membershipPath(directory, membershipFile);
  return existsSync(path) ? loadJson(path) : undefined;
}

/** Seed named-volume state once from the host pairing exchange. */
export function bootstrapSuitcaseMembershipFile(
  authoritativeFile: string,
  pairingExchangeFile: string,
): boolean {
  const authoritative = resolve(authoritativeFile);
  if (existsSync(authoritative)) return false;
  const exchange = resolve(pairingExchangeFile);
  if (!existsSync(exchange)) return false;
  loadJson(exchange);
  mkdirSync(dirname(authoritative), { recursive: true, mode: 0o700 });
  copyFileSync(exchange, authoritative);
  chmodSync(authoritative, 0o600);
  return true;
}

export function publicSuitcaseMembership(membership: SuitcaseMembership) {
  return {
    targetId: membership.targetId,
    coordinatorUrl: membership.coordinatorUrl,
    siteId: membership.siteId,
    fleetId: membership.fleetId,
    homeSiteId: membership.homeSiteId,
    name: membership.name,
    protocolVersion: membership.protocolVersion,
    defaultDataPolicy: membership.defaultDataPolicy,
    accessMode: membership.accessMode,
    securityProfile: membership.securityProfile,
    mode: membership.mode,
    cursors: membership.cursors,
    pendingEvents: membership.outbox.length,
    acknowledgedLocalSequence: membership.acknowledgedLocalSequence,
    receivedEvents: membership.inbox.length,
    pendingProjection: membership.inbox.length - membership.projectedEventIds.length,
    pendingTelemetryProjection:
      membership.telemetryInbox.length - membership.projectedTelemetryIds.length,
    pendingArtifacts: membership.outgoingArtifacts.length,
    pairedAt: membership.pairedAt,
    lastSyncAt: membership.lastSyncAt,
    lastSyncError: membership.lastSyncError,
  };
}

async function jsonRequest<T>(fetcher: FetchLike, url: string, init: RequestInit): Promise<T> {
  const response = await fetcher(url, init);
  const text = await response.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text };
    }
  }
  if (!response.ok) {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const error = new Error(String(record.error || `HTTP ${response.status}`)) as Error & {
      status?: number;
      code?: string;
      details?: Record<string, unknown>;
    };
    error.status = response.status;
    error.code = typeof record.code === 'string' ? record.code : undefined;
    error.details = record;
    throw error;
  }
  return body as T;
}

function siteHeaders(membership: SuitcaseMembership): Record<string, string> {
  return {
    'X-Deploy-Site-Id': membership.siteId,
    'X-Deploy-Site-Credential': membership.credential,
    'X-Deploy-Suitcase-Protocol': String(membership.protocolVersion),
  };
}

function localRecoveryEvidence(siteId: string): SiteApplicationRecoveryEvidence[] {
  return (
    getSqlite()!
      .prepare(
        `SELECT d.app_id, d.release_authority_epoch, d.release_generation,
                r.base_checkpoint_id, r.branch_checkpoint_id
           FROM deployments d
           LEFT JOIN app_replicas r
             ON r.app_id = d.app_id AND r.site_id = ? AND r.removed_at IS NULL
          WHERE d.app_id IS NOT NULL ORDER BY d.app_id`,
      )
      .all(siteId) as Array<{
      app_id: string;
      release_authority_epoch: number;
      release_generation: number;
      base_checkpoint_id: string | null;
      branch_checkpoint_id: string | null;
    }>
  ).map((application) => ({
    appId: application.app_id,
    authorityEpoch: Number(application.release_authority_epoch),
    generation: Number(application.release_generation),
    baseCheckpointId: application.base_checkpoint_id,
    branchCheckpointId: application.branch_checkpoint_id,
  }));
}

async function completePendingCredentialTransition(
  membership: SuitcaseMembership,
  purpose: SiteCredentialProofPurpose,
  fetcher: FetchLike,
  now: () => Date,
): Promise<void> {
  const credential = `site_secret_${randomBytes(32).toString('base64url')}`;
  const proof: SiteCredentialProof = {
    schemaVersion: 1,
    purpose,
    siteId: membership.siteId,
    fleetId: membership.fleetId,
    homeSiteId: membership.homeSiteId,
    protocolVersion: membership.protocolVersion,
    acknowledgedLocalSequence: membership.acknowledgedLocalSequence,
    acknowledgedLocalTelemetrySequence: membership.acknowledgedLocalTelemetrySequence,
    cursors: membership.cursors,
    applications: localRecoveryEvidence(membership.siteId),
    proposedCredentialHash: createHash('sha256').update(credential).digest('hex'),
    nonce: randomBytes(24).toString('base64url'),
    createdAt: now().toISOString(),
  };
  const signature = sign(
    null,
    Buffer.from(canonicalFleetPayload(proof)),
    createPrivateKey(membership.privateKey),
  ).toString('base64url');
  const endpoint =
    purpose === 'home-recovery-readoption'
      ? '/api/suitcases/recovery/readopt'
      : '/api/suitcases/credentials/complete';
  const result = await jsonRequest<{
    siteId: string;
    fleetId: string;
    homeSiteId: string;
    credentialStatus: string;
    rotated: boolean;
  }>(fetcher, `${membership.coordinatorUrl}${endpoint}`, {
    method: 'POST',
    headers: { ...siteHeaders(membership), 'Content-Type': 'application/json' },
    body: JSON.stringify({ proof, signature }),
  });
  if (
    result.siteId !== membership.siteId ||
    result.fleetId !== membership.fleetId ||
    result.homeSiteId !== membership.homeSiteId ||
    result.credentialStatus !== 'active' ||
    result.rotated !== true
  ) {
    throw new Error('Coordinator returned a mismatched credential transition result');
  }
  membership.credential = credential;
  membership.mode = 'rejoining';
}

export async function pairSuitcase(
  input: {
    coordinatorUrl: string;
    code: string;
    targetId: string;
    capabilities?: Record<string, unknown>;
    version?: string;
  },
  options: ClientOptions = {},
) {
  const path = membershipPath(options.directory, options.membershipFile);
  if (existsSync(path))
    throw new Error('This target is already paired; revoke or remove its membership first');
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const intermediate = generateSuitcaseIntermediateRequest();
  const coordinatorUrl = normalizeCoordinatorUrl(input.coordinatorUrl);
  const fetcher = options.fetch ?? fetch;
  const result = await jsonRequest<{
    siteId: string;
    fleetId: string;
    homeSiteId: string;
    credential: string;
    name: string;
    defaultDataPolicy: 'automatic' | 'manual' | 'none';
    accessMode: string;
    securityProfile: string;
    protocolVersion: number;
    rootPublicIdentity: string;
    rootCertificate: string;
    intermediateCertificate: string;
    administratorProjection?: AdministratorProjection;
  }>(fetcher, `${coordinatorUrl}/api/suitcases/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: input.code,
      publicKey,
      intermediateCsr: intermediate.csr,
      targetId: input.targetId,
      platform: platform(),
      architecture: arch(),
      version: input.version ?? 'source',
      protocolVersion: PROTOCOL_VERSION,
      capabilities: input.capabilities ?? {},
    }),
  });
  if (result.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`Coordinator requires unsupported suitcase protocol ${result.protocolVersion}`);
  }
  validatePairedTlsIdentity({
    privateKey: intermediate.privateKey,
    intermediateCertificate: result.intermediateCertificate,
    rootCertificate: result.rootCertificate,
  });
  const now = (options.now ?? (() => new Date()))().toISOString();
  const membership: SuitcaseMembership = {
    schemaVersion: 1,
    targetId: input.targetId,
    coordinatorUrl,
    siteId: result.siteId,
    fleetId: result.fleetId,
    homeSiteId: result.homeSiteId,
    credential: result.credential,
    protocolVersion: result.protocolVersion,
    name: result.name,
    defaultDataPolicy: result.defaultDataPolicy,
    accessMode: result.accessMode,
    securityProfile: result.securityProfile,
    publicKey,
    privateKey,
    tls: {
      privateKey: intermediate.privateKey,
      intermediateCertificate: result.intermediateCertificate,
      rootCertificate: result.rootCertificate,
    },
    siteKeys: { [result.siteId]: publicKey, [result.homeSiteId]: result.rootPublicIdentity },
    mode: 'docked',
    nextOriginSequence: 1,
    acknowledgedLocalSequence: 0,
    cursors: {},
    outbox: [],
    inbox: [],
    projectedEventIds: [],
    telemetryCursors: {},
    telemetryInbox: [],
    projectedTelemetryIds: [],
    acknowledgedLocalTelemetrySequence: 0,
    outgoingArtifacts: [],
    pairedAt: now,
  };
  saveJson(path, membership);
  if (result.administratorProjection) {
    const projectionPath = administratorProjectionPath(options.directory, options.membershipFile);
    writeFileSync(projectionPath, `${JSON.stringify(result.administratorProjection)}\n`, {
      mode: 0o600,
    });
    chmodSync(projectionPath, 0o600);
  }
  return publicSuitcaseMembership(membership);
}

export async function setSuitcaseMode(
  mode: 'docked' | 'away' | 'rejoining',
  options: ClientOptions = {},
) {
  const path = membershipPath(options.directory, options.membershipFile);
  const membership = loadJson(path);
  await jsonRequest(options.fetch ?? fetch, `${membership.coordinatorUrl}/api/suitcases/presence`, {
    method: 'POST',
    headers: { ...siteHeaders(membership), 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, mode }),
  });
  membership.mode = mode;
  saveJson(path, membership);
  return publicSuitcaseMembership(membership);
}

/**
 * Record an observed connectivity mode without requiring Home to be reachable.
 * The next successful exchange reports the observation and then promotes the
 * site back to docked. This is deliberately separate from the administrator
 * command above, which still confirms the requested mode with Home.
 */
export function setSuitcaseLocalMode(
  mode: 'docked' | 'away' | 'rejoining',
  options: Pick<ClientOptions, 'directory' | 'membershipFile'> = {},
) {
  const path = membershipPath(options.directory, options.membershipFile);
  const membership = loadJson(path);
  membership.mode = mode;
  saveJson(path, membership);
  return publicSuitcaseMembership(membership);
}

function sortableClientEventId(now: Date): string {
  const random = createHash('sha256')
    .update(`${now.toISOString()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 24);
  return `event_${now.getTime().toString(36).padStart(10, '0')}_${random}`;
}

export function queueSuitcaseCommandCandidate(
  input: {
    appId: string;
    command: string;
    actor?: string;
    payload?: Record<string, unknown>;
    authorityEpoch?: number;
    generation?: number;
  },
  options: ClientOptions = {},
): WireFleetEvent {
  const path = membershipPath(options.directory, options.membershipFile);
  const membership = loadJson(path);
  const now = (options.now ?? (() => new Date()))();
  const eventBase = {
    id: sortableClientEventId(now),
    fleetId: membership.fleetId,
    originSiteId: membership.siteId,
    originSequence: membership.nextOriginSequence,
    appId: input.appId,
    authorityEpoch: input.authorityEpoch ?? null,
    generation: input.generation ?? null,
    actor: input.actor ?? `admin@${membership.siteId}`,
    operation: 'application.command.candidate',
    schemaVersion: 1,
    payload: { command: input.command, ...(input.payload ?? {}) },
    artifactDigests: [] as string[],
    parentEventId: null,
    createdAt: now.toISOString(),
  };
  const body = buildFleetEventBody(eventBase);
  const authenticatedDigest = sign(
    null,
    Buffer.from(body),
    createPrivateKey(membership.privateKey),
  ).toString('base64url');
  const event: WireFleetEvent = { ...eventBase, body, authenticatedDigest };
  membership.nextOriginSequence += 1;
  membership.outbox.push(event);
  saveJson(path, membership);
  return event;
}

export function enqueueSuitcaseDatabaseEvent(
  event: WireFleetEvent,
  artifacts: QueuedArtifact[],
  options: Pick<ClientOptions, 'directory' | 'membershipFile'> = {},
): boolean {
  const path = membershipPath(options.directory, options.membershipFile);
  const membership = loadJson(path);
  if (event.fleetId !== membership.fleetId || event.originSiteId !== membership.siteId) {
    throw new Error('Local database event does not match this suitcase fleet identity');
  }
  if (event.originSequence <= membership.acknowledgedLocalSequence) return false;
  const collision = membership.outbox.find(
    (candidate) => candidate.originSequence === event.originSequence,
  );
  if (collision && collision.id !== event.id) {
    throw new Error(
      `Suitcase event sequence ${event.originSequence} has conflicting local sources`,
    );
  }
  if (!collision) membership.outbox.push(event);
  membership.outbox.sort((left, right) => left.originSequence - right.originSequence);
  membership.nextOriginSequence = Math.max(membership.nextOriginSequence, event.originSequence + 1);
  for (const artifact of artifacts) {
    if (!membership.outgoingArtifacts.some((candidate) => candidate.digest === artifact.digest)) {
      membership.outgoingArtifacts.push({ ...artifact, path: resolve(artifact.path) });
    }
  }
  saveJson(path, membership);
  return !collision;
}

export function queueSuitcaseArtifact(
  artifact: QueuedArtifact,
  options: Pick<ClientOptions, 'directory' | 'membershipFile'> = {},
) {
  if (!DIGEST_PATTERN.test(artifact.digest)) throw new Error('Invalid artifact digest');
  const bytes = readFileSync(resolve(artifact.path));
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (digest !== artifact.digest) throw new Error('Artifact does not match its digest');
  const path = membershipPath(options.directory, options.membershipFile);
  const membership = loadJson(path);
  if (!membership.outgoingArtifacts.some((candidate) => candidate.digest === artifact.digest)) {
    membership.outgoingArtifacts.push({ ...artifact, path: resolve(artifact.path) });
    saveJson(path, membership);
  }
  return artifact;
}

function verifyIncomingEvent(event: WireFleetEvent, membership: SuitcaseMembership): void {
  const key = membership.siteKeys[event.originSiteId];
  if (!key) throw new Error(`Coordinator did not provide a public key for ${event.originSiteId}`);
  if (event.fleetId !== membership.fleetId || buildFleetEventBody(event) !== event.body) {
    throw new Error('Received event envelope does not match its signed body');
  }
  if (canonicalFleetPayload(JSON.parse(event.body)) !== event.body) {
    throw new Error('Received event body is not canonical');
  }
  if (
    !verify(
      null,
      Buffer.from(event.body),
      createPublicKey(key),
      Buffer.from(event.authenticatedDigest, 'base64url'),
    )
  ) {
    throw new Error(`Received event ${event.id} has an invalid signature`);
  }
}

function acceptIncomingEvents(
  events: WireFleetEvent[],
  skippedSequences: Record<string, number[]>,
  membership: SuitcaseMembership,
): void {
  const origins = new Set([
    ...events.map((event) => event.originSiteId),
    ...Object.keys(skippedSequences),
  ]);
  for (const origin of origins) {
    const originEvents = events
      .filter((event) => event.originSiteId === origin)
      .sort((left, right) => left.originSequence - right.originSequence);
    const skipped = new Set(skippedSequences[origin] ?? []);
    const maximum = Math.max(
      membership.cursors[origin] ?? 0,
      ...originEvents.map((event) => event.originSequence),
      ...skipped,
    );
    const bySequence = new Map(originEvents.map((event) => [event.originSequence, event]));
    for (let sequence = (membership.cursors[origin] ?? 0) + 1; sequence <= maximum; sequence += 1) {
      const event = bySequence.get(sequence);
      if (!event) {
        if (!skipped.has(sequence))
          throw new Error(`Expected ${origin} event sequence ${sequence}`);
        membership.cursors[origin] = sequence;
        continue;
      }
      verifyIncomingEvent(event, membership);
      const existing = membership.inbox.find((candidate) => candidate.id === event.id);
      if (existing && existing.authenticatedDigest !== event.authenticatedDigest) {
        throw new Error(`Received event ${event.id} conflicts with the local inbox`);
      }
      if (!existing) membership.inbox.push(event);
      membership.cursors[origin] = sequence;
    }
  }
}

function acceptAdministrativeControlEvents(
  events: WireFleetEvent[],
  membership: SuitcaseMembership,
): number {
  let accepted = 0;
  for (const event of events) {
    if (
      event.operation !== 'suitcase.data.sync.requested' &&
      event.operation !== 'fleet.mutation.requested'
    ) {
      throw new Error('Coordinator returned an unknown suitcase control request');
    }
    const targets =
      event.operation === 'suitcase.data.sync.requested'
        ? event.payload && typeof event.payload.targetSiteId === 'string'
          ? [event.payload.targetSiteId]
          : []
        : event.payload && Array.isArray(event.payload.targetSiteIds)
          ? event.payload.targetSiteIds.filter(
              (candidate): candidate is string => typeof candidate === 'string',
            )
          : [];
    if (!targets.includes(membership.siteId)) {
      throw new Error('Coordinator returned a suitcase control request for another site');
    }
    verifyIncomingEvent(event, membership);
    const existing = membership.inbox.find((candidate) => candidate.id === event.id);
    if (existing && existing.authenticatedDigest !== event.authenticatedDigest) {
      throw new Error(`Received control event ${event.id} conflicts with the local inbox`);
    }
    if (!existing) {
      membership.inbox.push(event);
      accepted += 1;
    }
  }
  return accepted;
}

function acceptIncomingTelemetry(
  records: WireFleetTelemetryRecord[],
  membership: SuitcaseMembership,
): void {
  const byOrigin = new Map<string, WireFleetTelemetryRecord[]>();
  for (const record of records) {
    if (
      record.fleetId !== membership.fleetId ||
      !record.id.startsWith('telemetry_') ||
      !Number.isSafeInteger(record.originSequence) ||
      record.originSequence < 1 ||
      !Array.isArray(record.artifactDigests)
    ) {
      throw new Error('Received fleet telemetry record is invalid');
    }
    const list = byOrigin.get(record.originSiteId) ?? [];
    list.push(record);
    byOrigin.set(record.originSiteId, list);
  }
  for (const [origin, originRecords] of byOrigin) {
    originRecords.sort((left, right) => left.originSequence - right.originSequence);
    let cursor = membership.telemetryCursors[origin] ?? 0;
    for (const record of originRecords) {
      if (record.originSequence <= cursor) continue;
      if (record.originSequence !== cursor + 1) {
        throw new Error(`Expected ${origin} telemetry sequence ${cursor + 1}`);
      }
      const existing = membership.telemetryInbox.find((candidate) => candidate.id === record.id);
      if (!existing) membership.telemetryInbox.push(record);
      cursor = record.originSequence;
    }
    membership.telemetryCursors[origin] = cursor;
  }
}

async function uploadArtifact(
  membership: SuitcaseMembership,
  artifact: QueuedArtifact,
  fetcher: FetchLike,
): Promise<void> {
  const size = statSync(artifact.path).size;
  const begin = await jsonRequest<{ id: string; verifiedOffset: number; status: string }>(
    fetcher,
    `${membership.coordinatorUrl}/api/suitcases/sync/artifacts/${encodeURIComponent(artifact.digest)}/begin`,
    {
      method: 'POST',
      headers: { ...siteHeaders(membership), 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedSize: size }),
    },
  );
  let offset = begin.verifiedOffset;
  const descriptor = openSync(artifact.path, 'r');
  try {
    if (size === 0 && begin.status !== 'complete') {
      await jsonRequest(
        fetcher,
        `${membership.coordinatorUrl}/api/suitcases/sync/artifacts/${encodeURIComponent(artifact.digest)}?transferId=${encodeURIComponent(begin.id)}&offset=0`,
        {
          method: 'PUT',
          headers: {
            ...siteHeaders(membership),
            'Content-Type': 'application/octet-stream',
            'X-Deploy-Artifact-Type': artifact.type,
            'X-Deploy-Artifact-Media-Type': artifact.mediaType ?? 'application/octet-stream',
            'X-Deploy-Artifact-Retention': artifact.retentionClass ?? 'temporary',
          },
          body: Buffer.alloc(0),
        },
      );
    }
    while (offset < size) {
      const length = Math.min(CHUNK_BYTES, size - offset);
      const bytes = Buffer.alloc(length);
      readSync(descriptor, bytes, 0, length, offset);
      const response = await jsonRequest<{ verifiedOffset: number; status: string }>(
        fetcher,
        `${membership.coordinatorUrl}/api/suitcases/sync/artifacts/${encodeURIComponent(artifact.digest)}?transferId=${encodeURIComponent(begin.id)}&offset=${offset}`,
        {
          method: 'PUT',
          headers: {
            ...siteHeaders(membership),
            'Content-Type': 'application/octet-stream',
            'X-Deploy-Artifact-Type': artifact.type,
            'X-Deploy-Artifact-Media-Type': artifact.mediaType ?? 'application/octet-stream',
            'X-Deploy-Artifact-Retention': artifact.retentionClass ?? 'temporary',
          },
          body: bytes,
        },
      );
      if (response.verifiedOffset <= offset) throw new Error('Artifact upload did not advance');
      offset = response.verifiedOffset;
    }
  } finally {
    closeSync(descriptor);
  }
}

async function downloadArtifact(
  membership: SuitcaseMembership,
  digest: string,
  fetcher: FetchLike,
  directory?: string,
): Promise<string> {
  const match = digest.match(DIGEST_PATTERN);
  if (!match) throw new Error('Invalid artifact digest');
  const root = join(suitcaseTargetPaths(directory).directory, 'sync-artifacts', 'sha256');
  const destination = join(root, match[1]);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (existsSync(destination)) {
    const existingDigest = `sha256:${createHash('sha256').update(readFileSync(destination)).digest('hex')}`;
    if (existingDigest === digest) return destination;
    chmodSync(destination, 0o600);
  }
  let offset = existsSync(destination) ? statSync(destination).size : 0;
  const descriptor = openSync(destination, offset === 0 ? 'w' : 'r+', 0o600);
  try {
    let complete = false;
    while (!complete) {
      const response = await fetcher(
        `${membership.coordinatorUrl}/api/suitcases/sync/artifacts/${encodeURIComponent(digest)}?offset=${offset}&limit=${CHUNK_BYTES}`,
        { headers: siteHeaders(membership) },
      );
      if (!response.ok) throw new Error(`Artifact download failed: HTTP ${response.status}`);
      const expectedOffset = Number(response.headers.get('x-deploy-artifact-offset'));
      const nextOffset = Number(response.headers.get('x-deploy-artifact-next-offset'));
      const totalSize = Number(response.headers.get('x-deploy-artifact-size'));
      if (expectedOffset !== offset || !Number.isSafeInteger(nextOffset) || nextOffset < offset) {
        throw new Error('Artifact download cursor is invalid');
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (nextOffset !== offset + bytes.length || nextOffset > totalSize) {
        throw new Error('Artifact download length does not match its cursor');
      }
      if (bytes.length) writeSync(descriptor, bytes, 0, bytes.length, offset);
      offset = nextOffset;
      complete = response.headers.get('x-deploy-artifact-complete') === '1';
      if (!complete && bytes.length === 0) throw new Error('Artifact download did not advance');
    }
  } finally {
    closeSync(descriptor);
  }
  const actual = `sha256:${createHash('sha256').update(readFileSync(destination)).digest('hex')}`;
  if (actual !== digest) throw new Error('Downloaded artifact digest mismatch');
  chmodSync(destination, 0o400);
  return destination;
}

export async function syncSuitcaseNow(options: ClientOptions = {}) {
  const path = membershipPath(options.directory, options.membershipFile);
  const membership = loadJson(path);
  const fetcher = options.fetch ?? fetch;
  for (const artifact of options.telemetryArtifacts ?? []) {
    if (!membership.outgoingArtifacts.some((candidate) => candidate.digest === artifact.digest)) {
      membership.outgoingArtifacts.push({ ...artifact, path: resolve(artifact.path) });
    }
  }
  saveJson(path, membership);
  let received = 0;
  let replayed = 0;
  let sent = 0;
  try {
    let hasMore = true;
    while (hasMore) {
      const response = await jsonRequest<{
        protocolVersion: number;
        fleetId: string;
        homeSiteId: string;
        siteId: string;
        acceptedThrough: number;
        replayed: number;
        acceptedTelemetryThrough?: number;
        telemetryReplayed?: number;
        events: WireFleetEvent[];
        controlRequests?: WireFleetEvent[];
        telemetry?: WireFleetTelemetryRecord[];
        skippedSequences?: Record<string, number[]>;
        hasMore: boolean;
        missingArtifacts: string[];
        sitePublicKeys?: Record<string, string>;
      }>(fetcher, `${membership.coordinatorUrl}/api/suitcases/sync/exchange`, {
        method: 'POST',
        headers: { ...siteHeaders(membership), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: membership.protocolVersion,
          fleetId: membership.fleetId,
          mode: membership.mode,
          capabilities: options.capabilities,
          manualSync: options.manualSync !== false,
          manualSyncAppIds: options.manualSyncAppIds,
          cursors: membership.cursors,
          telemetryCursors: membership.telemetryCursors,
          events: membership.outbox.slice(0, 200),
          telemetry: (options.telemetry ?? [])
            .filter(
              (record) => record.originSequence > membership.acknowledgedLocalTelemetrySequence,
            )
            .slice(0, 200),
        }),
      });
      if (
        response.protocolVersion !== membership.protocolVersion ||
        response.fleetId !== membership.fleetId ||
        response.siteId !== membership.siteId ||
        response.homeSiteId !== membership.homeSiteId
      ) {
        throw new Error('Coordinator returned a mismatched fleet identity or protocol');
      }
      Object.assign(membership.siteKeys, response.sitePublicKeys ?? {});
      const sentBatch = membership.outbox.slice(0, 200);
      sent += sentBatch.length;
      membership.outbox = membership.outbox.filter(
        (event) => event.originSequence > response.acceptedThrough,
      );
      membership.acknowledgedLocalSequence = Math.max(
        membership.acknowledgedLocalSequence,
        response.acceptedThrough,
      );
      membership.acknowledgedLocalTelemetrySequence = Math.max(
        membership.acknowledgedLocalTelemetrySequence,
        response.acceptedTelemetryThrough ?? membership.acknowledgedLocalTelemetrySequence,
      );
      if (sentBatch.length && response.acceptedThrough < sentBatch[0].originSequence - 1) {
        throw new Error('Coordinator acknowledgement moved backwards');
      }
      acceptIncomingEvents(response.events, response.skippedSequences ?? {}, membership);
      const acceptedControls = acceptAdministrativeControlEvents(
        response.controlRequests ?? [],
        membership,
      );
      acceptIncomingTelemetry(response.telemetry ?? [], membership);
      received += response.events.length + acceptedControls;
      replayed += response.replayed;
      hasMore = response.hasMore || response.missingArtifacts.length > 0;
      saveJson(path, membership);

      for (const digest of response.missingArtifacts) {
        const artifact = membership.outgoingArtifacts.find(
          (candidate) => candidate.digest === digest,
        );
        if (!artifact) throw new Error(`Coordinator requested unavailable artifact ${digest}`);
        await uploadArtifact(membership, artifact, fetcher);
        membership.outgoingArtifacts = membership.outgoingArtifacts.filter(
          (candidate) => candidate.digest !== digest,
        );
        saveJson(path, membership);
      }
    }

    // Upload only content the coordinator explicitly requested for an event
    // or telemetry record it is allowed to accept. Proactively draining this
    // queue would leak manual/no-sync database or backup content even when the
    // corresponding semantic record was correctly deferred. Once every local
    // reference is acknowledged, the coordinator either already has the
    // artifact or requested it above, so the queue entry can be forgotten.
    const retainedArtifactDigests = new Set([
      ...membership.outbox.flatMap((event) => event.artifactDigests ?? []),
      ...(options.telemetry ?? [])
        .filter((record) => record.originSequence > membership.acknowledgedLocalTelemetrySequence)
        .flatMap((record) => record.artifactDigests ?? []),
    ]);
    membership.outgoingArtifacts = membership.outgoingArtifacts.filter((artifact) =>
      retainedArtifactDigests.has(artifact.digest),
    );
    saveJson(path, membership);

    const requiredDigests = [
      ...new Set([
        ...membership.inbox.flatMap((event) => event.artifactDigests ?? []),
        ...membership.telemetryInbox.flatMap((record) => record.artifactDigests ?? []),
      ]),
    ];
    const downloaded: string[] = [];
    const artifactPaths: Record<string, string> = {};
    for (const digest of requiredDigests) {
      const artifactPath = await downloadArtifact(membership, digest, fetcher, options.directory);
      downloaded.push(artifactPath);
      artifactPaths[digest] = artifactPath;
    }
    if (options.projectEvent) {
      for (const event of membership.inbox) {
        if (membership.projectedEventIds.includes(event.id)) continue;
        await options.projectEvent(event, artifactPaths, membership);
        membership.projectedEventIds.push(event.id);
        saveJson(path, membership);
      }
    }
    if (options.projectTelemetry) {
      const pending = membership.telemetryInbox.filter(
        (record) => !membership.projectedTelemetryIds.includes(record.id),
      );
      if (pending.length) {
        await options.projectTelemetry(pending, membership);
        membership.projectedTelemetryIds.push(...pending.map((record) => record.id));
        saveJson(path, membership);
      }
    }
    membership.lastSyncAt = (options.now ?? (() => new Date()))().toISOString();
    delete membership.lastSyncError;
    saveJson(path, membership);
    return {
      ...publicSuitcaseMembership(membership),
      sent,
      received,
      replayed,
      downloaded,
    };
  } catch (caught) {
    let error: unknown = caught;
    const code =
      caught instanceof Error && 'code' in caught
        ? String((caught as Error & { code?: string }).code || '')
        : '';
    if (code === 'recovery_readoption_required' || code === 'credential_rotation_required') {
      try {
        await completePendingCredentialTransition(
          membership,
          code === 'recovery_readoption_required'
            ? 'home-recovery-readoption'
            : 'credential-rotation',
          fetcher,
          options.now ?? (() => new Date()),
        );
        delete membership.lastSyncError;
        saveJson(path, membership);
        return syncSuitcaseNow(options);
      } catch (transitionError) {
        error = transitionError;
      }
    }
    membership.lastSyncError = error instanceof Error ? error.message : String(error);
    saveJson(path, membership);
    throw error;
  }
}

export async function suitcaseClientSyncStatus(options: ClientOptions = {}) {
  const membership = readSuitcaseMembership(options.directory, options.membershipFile);
  if (!membership) return { paired: false, connected: false };
  try {
    const remote = await jsonRequest<Record<string, unknown>>(
      options.fetch ?? fetch,
      `${membership.coordinatorUrl}/api/suitcases/sync/status`,
      { method: 'GET', headers: siteHeaders(membership) },
    );
    return { paired: true, connected: true, local: publicSuitcaseMembership(membership), remote };
  } catch (error) {
    return {
      paired: true,
      connected: false,
      local: publicSuitcaseMembership(membership),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function forgetSuitcaseMembership(directory?: string): void {
  const path = membershipPath(directory);
  if (existsSync(path)) writeFileSync(path, '', { mode: 0o600 });
}
