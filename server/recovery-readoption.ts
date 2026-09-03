import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import {
  canonicalFleetPayload,
  ensureFleetIdentity,
  MULTISITE_PROTOCOL_VERSION,
} from './multisite.ts';
import { getSqlite } from './store.ts';
import { SuitcaseProtocolError } from './suitcase-transport.ts';

const SHA256_HEX = /^[a-f0-9]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{20,160}$/;
const PROOF_MAX_AGE_MS = 10 * 60_000;

export type SiteCredentialProofPurpose = 'home-recovery-readoption' | 'credential-rotation';

export interface SiteApplicationRecoveryEvidence {
  appId: string;
  authorityEpoch: number;
  generation: number;
  baseCheckpointId: string | null;
  branchCheckpointId: string | null;
}

export interface SiteCredentialProof {
  schemaVersion: 1;
  purpose: SiteCredentialProofPurpose;
  siteId: string;
  fleetId: string;
  homeSiteId: string;
  protocolVersion: number;
  acknowledgedLocalSequence: number;
  acknowledgedLocalTelemetrySequence: number;
  cursors: Record<string, number>;
  applications: SiteApplicationRecoveryEvidence[];
  proposedCredentialHash: string;
  nonce: string;
  createdAt: string;
}

interface RecoverableSiteRow {
  id: string;
  fleet_id: string;
  public_key: string;
  credential_hash: string | null;
  credential_status: string;
  revoked_at: string | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function equalDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function requiredSafeSequence(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new SuitcaseProtocolError(`${path} must be a non-negative safe integer`);
  }
  return Number(value);
}

function requireProof(input: unknown): SiteCredentialProof {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SuitcaseProtocolError('Re-adoption proof must be an object');
  }
  const proof = input as Record<string, unknown>;
  if (proof.schemaVersion !== 1) {
    throw new SuitcaseProtocolError('Re-adoption proof schema version 1 is required');
  }
  if (proof.purpose !== 'home-recovery-readoption' && proof.purpose !== 'credential-rotation') {
    throw new SuitcaseProtocolError('Re-adoption proof purpose is invalid');
  }
  for (const field of ['siteId', 'fleetId', 'homeSiteId', 'nonce', 'createdAt'] as const) {
    if (typeof proof[field] !== 'string' || !proof[field]) {
      throw new SuitcaseProtocolError(`Re-adoption proof ${field} is required`);
    }
  }
  if (!SHA256_HEX.test(String(proof.proposedCredentialHash))) {
    throw new SuitcaseProtocolError('Proposed credential hash must be a SHA-256 digest');
  }
  if (!NONCE.test(String(proof.nonce))) {
    throw new SuitcaseProtocolError('Re-adoption proof nonce is invalid');
  }
  const createdAt = Date.parse(String(proof.createdAt));
  if (!Number.isFinite(createdAt) || Math.abs(Date.now() - createdAt) > PROOF_MAX_AGE_MS) {
    throw new SuitcaseProtocolError(
      'Re-adoption proof has expired; synchronize the Suitcase clock and retry',
      409,
      'readoption_proof_expired',
    );
  }
  if (!proof.cursors || typeof proof.cursors !== 'object' || Array.isArray(proof.cursors)) {
    throw new SuitcaseProtocolError('Re-adoption proof cursors must be an object');
  }
  const cursors: Record<string, number> = {};
  for (const [origin, sequence] of Object.entries(proof.cursors as Record<string, unknown>)) {
    if (!origin) throw new SuitcaseProtocolError('Re-adoption cursor origin is required');
    cursors[origin] = requiredSafeSequence(sequence, `cursors.${origin}`);
  }
  if (!Array.isArray(proof.applications)) {
    throw new SuitcaseProtocolError('Re-adoption proof applications must be an array');
  }
  const applications = proof.applications.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new SuitcaseProtocolError(`applications.${index} must be an object`);
    }
    const application = value as Record<string, unknown>;
    if (typeof application.appId !== 'string' || !application.appId) {
      throw new SuitcaseProtocolError(`applications.${index}.appId is required`);
    }
    for (const key of ['baseCheckpointId', 'branchCheckpointId'] as const) {
      if (application[key] !== null && typeof application[key] !== 'string') {
        throw new SuitcaseProtocolError(`applications.${index}.${key} must be a string or null`);
      }
    }
    return {
      appId: application.appId,
      authorityEpoch: requiredSafeSequence(
        application.authorityEpoch,
        `applications.${index}.authorityEpoch`,
      ),
      generation: requiredSafeSequence(application.generation, `applications.${index}.generation`),
      baseCheckpointId: application.baseCheckpointId as string | null,
      branchCheckpointId: application.branchCheckpointId as string | null,
    };
  });
  if (new Set(applications.map((application) => application.appId)).size !== applications.length) {
    throw new SuitcaseProtocolError('Re-adoption proof contains duplicate application identities');
  }
  return {
    schemaVersion: 1,
    purpose: proof.purpose,
    siteId: String(proof.siteId),
    fleetId: String(proof.fleetId),
    homeSiteId: String(proof.homeSiteId),
    protocolVersion: requiredSafeSequence(proof.protocolVersion, 'protocolVersion'),
    acknowledgedLocalSequence: requiredSafeSequence(
      proof.acknowledgedLocalSequence,
      'acknowledgedLocalSequence',
    ),
    acknowledgedLocalTelemetrySequence: requiredSafeSequence(
      proof.acknowledgedLocalTelemetrySequence,
      'acknowledgedLocalTelemetrySequence',
    ),
    cursors,
    applications,
    proposedCredentialHash: String(proof.proposedCredentialHash),
    nonce: String(proof.nonce),
    createdAt: String(proof.createdAt),
  };
}

function recoverableSite(siteId: string): RecoverableSiteRow {
  const row = getSqlite()!
    .prepare(
      `SELECT id, fleet_id, public_key, credential_hash, credential_status, revoked_at
         FROM sites WHERE id = ? AND kind = 'suitcase'`,
    )
    .get(siteId) as RecoverableSiteRow | undefined;
  if (!row) throw new SuitcaseProtocolError('Unknown suitcase identity', 401, 'invalid_credential');
  if (row.revoked_at || row.credential_status === 'revoked') {
    throw new SuitcaseProtocolError('Suitcase identity has been revoked', 403, 'site_revoked');
  }
  return row;
}

function authenticatePendingSite(row: RecoverableSiteRow, credential: string): void {
  if (
    !credential ||
    !row.credential_hash ||
    !equalDigest(row.credential_hash, sha256(credential))
  ) {
    throw new SuitcaseProtocolError('Invalid suitcase credential', 401, 'invalid_credential');
  }
}

function checkpointAncestors(appId: string, checkpointId: string): Set<string> {
  const sqlite = getSqlite()!;
  const ancestors = new Set<string>();
  let current: string | null = checkpointId;
  while (current && !ancestors.has(current)) {
    const checkpoint = sqlite
      .prepare('SELECT parent_id FROM data_checkpoints WHERE id = ? AND app_id = ?')
      .get(current, appId) as { parent_id: string | null } | undefined;
    if (!checkpoint) break;
    ancestors.add(current);
    current = checkpoint.parent_id;
  }
  return ancestors;
}

function lineageCompatible(appId: string, left: string, right: string): boolean {
  return checkpointAncestors(appId, left).has(right) || checkpointAncestors(appId, right).has(left);
}

function recoveryCompatibilityBlockers(siteId: string, proof: SiteCredentialProof): string[] {
  const sqlite = getSqlite()!;
  const fleet = ensureFleetIdentity();
  const blockers: string[] = [];
  const accepted = sqlite
    .prepare(
      `SELECT COALESCE(
                MAX(CASE WHEN stream = ? THEN last_accepted_sequence END),
                MAX(CASE WHEN stream = 'control' THEN last_accepted_sequence END),
                0
              ) AS sequence
         FROM site_sync_cursors WHERE local_site_id = ? AND remote_site_id = ?`,
    )
    .get(`events:${siteId}`, fleet.homeSiteId, siteId) as { sequence: number };
  if (proof.acknowledgedLocalSequence > Number(accepted.sequence)) {
    blockers.push(
      `Suitcase believes Home accepted event ${proof.acknowledgedLocalSequence}, but the recovered Home only records ${accepted.sequence}`,
    );
  }
  const telemetry = sqlite
    .prepare(
      `SELECT COALESCE(MAX(origin_sequence), 0) AS sequence
         FROM fleet_telemetry_records WHERE origin_site_id = ?`,
    )
    .get(siteId) as { sequence: number };
  if (proof.acknowledgedLocalTelemetrySequence > Number(telemetry.sequence)) {
    blockers.push(
      `Suitcase believes Home accepted telemetry ${proof.acknowledgedLocalTelemetrySequence}, but the recovered Home only records ${telemetry.sequence}`,
    );
  }
  for (const [originSiteId, sequence] of Object.entries(proof.cursors)) {
    const restored = sqlite
      .prepare(
        `SELECT COALESCE(MAX(origin_sequence), 0) AS sequence
           FROM fleet_events WHERE origin_site_id = ?`,
      )
      .get(originSiteId) as { sequence: number };
    if (sequence > Number(restored.sequence)) {
      blockers.push(
        `Suitcase cursor for ${originSiteId} is ${sequence}, but the recovered Home only retains event ${restored.sequence}`,
      );
    }
  }

  const expectedApps = sqlite
    .prepare(
      `SELECT app_id, base_checkpoint_id
         FROM app_replicas WHERE site_id = ? AND removed_at IS NULL ORDER BY app_id`,
    )
    .all(siteId) as Array<{ app_id: string; base_checkpoint_id: string | null }>;
  const evidence = new Map(
    proof.applications.map((application) => [application.appId, application]),
  );
  for (const expected of expectedApps) {
    if (!evidence.has(expected.app_id)) {
      blockers.push(`Suitcase did not attest to expected application ${expected.app_id}`);
    }
  }
  for (const application of proof.applications) {
    const home = sqlite
      .prepare(
        `SELECT release_authority_epoch, release_generation
           FROM deployments WHERE app_id = ?`,
      )
      .get(application.appId) as
      | { release_authority_epoch: number; release_generation: number }
      | undefined;
    if (!home) {
      blockers.push(`Recovered Home does not recognize application ${application.appId}`);
      continue;
    }
    if (
      application.authorityEpoch > Number(home.release_authority_epoch) ||
      (application.authorityEpoch === Number(home.release_authority_epoch) &&
        application.generation > Number(home.release_generation))
    ) {
      blockers.push(
        `${application.appId} is ahead of recovered Home authority ${home.release_authority_epoch}/${home.release_generation} at ${application.authorityEpoch}/${application.generation}`,
      );
    }
    if (application.branchCheckpointId && !application.baseCheckpointId) {
      blockers.push(
        `${application.appId} has branch checkpoint ${application.branchCheckpointId} without a shared base checkpoint`,
      );
    }
    if (application.baseCheckpointId) {
      const checkpoint = sqlite
        .prepare('SELECT id, verification_status FROM data_checkpoints WHERE id = ? AND app_id = ?')
        .get(application.baseCheckpointId, application.appId) as
        | { id: string; verification_status: string }
        | undefined;
      if (!checkpoint) {
        blockers.push(
          `${application.appId} base checkpoint ${application.baseCheckpointId} is absent from recovered Home`,
        );
      } else if (checkpoint.verification_status !== 'verified') {
        blockers.push(
          `${application.appId} base checkpoint ${application.baseCheckpointId} is not verified on recovered Home`,
        );
      }
      const expected = expectedApps.find((candidate) => candidate.app_id === application.appId);
      if (
        checkpoint &&
        expected?.base_checkpoint_id &&
        !lineageCompatible(
          application.appId,
          application.baseCheckpointId,
          expected.base_checkpoint_id,
        )
      ) {
        blockers.push(
          `${application.appId} base checkpoint ${application.baseCheckpointId} diverges from recovered lineage ${expected.base_checkpoint_id}`,
        );
      }
    }
  }
  return blockers;
}

export function completeSiteCredentialProof(input: {
  siteId: string;
  credential: string;
  proof: unknown;
  signature: string;
  expectedPurpose: SiteCredentialProofPurpose;
}) {
  const row = recoverableSite(input.siteId);
  const expectedStatus =
    input.expectedPurpose === 'home-recovery-readoption' ? 'recovery-pending' : 'rotation-required';
  if (row.credential_status !== expectedStatus) {
    throw new SuitcaseProtocolError(
      `Suitcase is not awaiting ${input.expectedPurpose}`,
      409,
      'credential_transition_not_pending',
    );
  }
  authenticatePendingSite(row, input.credential);
  const proof = requireProof(input.proof);
  const fleet = ensureFleetIdentity();
  if (
    proof.purpose !== input.expectedPurpose ||
    proof.siteId !== row.id ||
    proof.fleetId !== row.fleet_id ||
    proof.fleetId !== fleet.id ||
    proof.homeSiteId !== fleet.homeSiteId ||
    proof.protocolVersion !== MULTISITE_PROTOCOL_VERSION
  ) {
    throw new SuitcaseProtocolError(
      'Signed proof does not match this fleet, Home, Suitcase, purpose, or protocol',
      403,
      'readoption_identity_mismatch',
    );
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(input.signature, 'base64url');
  } catch {
    throw new SuitcaseProtocolError('Re-adoption signature is invalid', 403, 'invalid_signature');
  }
  if (
    !signature.length ||
    !verify(
      null,
      Buffer.from(canonicalFleetPayload(proof)),
      createPublicKey(row.public_key),
      signature,
    )
  ) {
    throw new SuitcaseProtocolError('Re-adoption signature is invalid', 403, 'invalid_signature');
  }

  const blockers =
    proof.purpose === 'home-recovery-readoption'
      ? recoveryCompatibilityBlockers(row.id, proof)
      : [];
  if (blockers.length) {
    const reason = JSON.stringify({ kind: 'recovery-review-required', blockers });
    getSqlite()!
      .prepare('UPDATE sites SET quarantine_reason = ?, updated_at = ? WHERE id = ?')
      .run(reason, new Date().toISOString(), row.id);
    throw new SuitcaseProtocolError(
      'Recovered Home cannot safely re-adopt this Suitcase without administrator review',
      409,
      'recovery_review_required',
      { blockers, siteId: row.id },
    );
  }

  const now = new Date().toISOString();
  const updated = getSqlite()!
    .prepare(
      `UPDATE sites
          SET credential_hash = ?, credential_status = 'active', mode = 'rejoining',
              quarantine_reason = NULL, updated_at = ?
        WHERE id = ? AND credential_status = ? AND revoked_at IS NULL`,
    )
    .run(proof.proposedCredentialHash, now, row.id, expectedStatus);
  if (updated.changes !== 1) {
    throw new SuitcaseProtocolError(
      'Suitcase credential state changed during re-adoption',
      409,
      'credential_transition_raced',
    );
  }
  return {
    siteId: row.id,
    fleetId: fleet.id,
    homeSiteId: fleet.homeSiteId,
    credentialStatus: 'active' as const,
    mode: 'rejoining' as const,
    rotated: true,
  };
}

export function requestSiteCredentialRotation(input: { siteId?: string; actor: string }) {
  const sqlite = getSqlite()!;
  const now = new Date().toISOString();
  const reason = `Credential rotation requested by ${input.actor}`;
  let siteIds: string[];
  if (input.siteId) {
    const site = sqlite
      .prepare(
        `SELECT id, credential_status, revoked_at FROM sites
          WHERE id = ? AND kind = 'suitcase'`,
      )
      .get(input.siteId) as
      | { id: string; credential_status: string; revoked_at: string | null }
      | undefined;
    if (!site || site.revoked_at) throw new Error('Active suitcase site not found');
    if (site.credential_status === 'recovery-pending') {
      throw new Error('Recovery re-adoption must complete before credential rotation');
    }
    if (site.credential_status !== 'active' && site.credential_status !== 'rotation-required') {
      throw new Error(`Suitcase credential cannot rotate from ${site.credential_status}`);
    }
    siteIds = [site.id];
  } else {
    siteIds = (
      sqlite
        .prepare(
          `SELECT id FROM sites WHERE kind = 'suitcase' AND revoked_at IS NULL
             AND credential_status IN ('active', 'rotation-required') ORDER BY id`,
        )
        .all() as Array<{ id: string }>
    ).map((site) => site.id);
  }
  const rotate = sqlite.transaction(() => {
    for (const siteId of siteIds) {
      sqlite
        .prepare(
          `UPDATE sites SET credential_status = 'rotation-required', quarantine_reason = ?,
                            updated_at = ?
            WHERE id = ? AND revoked_at IS NULL
              AND credential_status IN ('active', 'rotation-required')`,
        )
        .run(reason, now, siteId);
    }
  });
  rotate.immediate();
  return {
    siteIds,
    count: siteIds.length,
    credentialStatus: 'rotation-required' as const,
    requestedAt: now,
  };
}
