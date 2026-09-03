import { createHash } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { deployDataPath } from './data-directory.ts';
import { sortableId } from './multisite.ts';
import { getSqlite } from './store.ts';

const DIGEST_PATTERN = /^sha256:([a-f0-9]{64})$/;

export interface ArtifactMetadata {
  type: string;
  mediaType?: string;
  architecture?: string;
  createdByEventId?: string;
  retentionClass?: 'temporary' | 'release' | 'checkpoint' | 'recovery';
}

function artifactPath(digest: string): string {
  const match = digest.match(DIGEST_PATTERN);
  if (!match) throw new Error('Invalid SHA-256 artifact digest');
  return deployDataPath('blobs', 'sha256', match[1].slice(0, 2), match[1]);
}

function temporaryArtifactPath(label: string): string {
  if (!/^[a-zA-Z0-9_.-]+$/.test(label)) throw new Error('Invalid artifact transfer label');
  return deployDataPath('transfers', `${label}.partial`);
}

function digestBytes(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return `sha256:${hash.digest('hex')}`;
}

function recordArtifact(digest: string, path: string, metadata: ArtifactMetadata): void {
  const now = new Date().toISOString();
  getSqlite()!
    .prepare(
      `INSERT INTO artifacts
        (digest, type, byte_size, media_type, architecture, local_path,
         verification_status, created_by_event_id, retention_class, pin_count,
         created_at, last_access_at)
       VALUES (?, ?, ?, ?, ?, ?, 'verified', ?, ?, 0, ?, ?)
       ON CONFLICT(digest) DO UPDATE SET
         verification_status = 'verified', last_access_at = excluded.last_access_at`,
    )
    .run(
      digest,
      metadata.type,
      statSync(path).size,
      metadata.mediaType || 'application/octet-stream',
      metadata.architecture || null,
      path,
      metadata.createdByEventId || null,
      metadata.retentionClass || 'temporary',
      now,
      now,
    );
}

function materializeImmutable(source: string, digest: string): string {
  const destination = artifactPath(digest);
  if (existsSync(destination)) return destination;
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, readFileSync(source), { mode: 0o600 });
  try {
    renameSync(temporary, destination);
  } catch (error) {
    if (!existsSync(destination)) throw error;
    unlinkSync(temporary);
  }
  chmodSync(destination, 0o400);
  return destination;
}

export function putArtifactBytes(bytes: Buffer, metadata: ArtifactMetadata) {
  const digest = digestBytes(bytes);
  const destination = artifactPath(digest);
  if (!existsSync(destination)) {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, bytes, { mode: 0o600 });
    try {
      renameSync(temporary, destination);
    } catch (error) {
      if (!existsSync(destination)) throw error;
      unlinkSync(temporary);
    }
    chmodSync(destination, 0o400);
  }
  recordArtifact(digest, destination, metadata);
  return { digest, path: destination, byteSize: bytes.length };
}

export async function putArtifactFile(path: string, metadata: ArtifactMetadata) {
  const digest = await digestFile(path);
  const destination = materializeImmutable(path, digest);
  recordArtifact(digest, destination, metadata);
  return { digest, path: destination, byteSize: statSync(destination).size };
}

export async function verifyArtifact(digest: string): Promise<boolean> {
  const path = artifactPath(digest);
  const valid = existsSync(path) && (await digestFile(path)) === digest;
  getSqlite()!
    .prepare('UPDATE artifacts SET verification_status = ?, last_access_at = ? WHERE digest = ?')
    .run(valid ? 'verified' : 'corrupt', new Date().toISOString(), digest);
  return valid;
}

export function getArtifact(digest: string) {
  const record = getSqlite()!.prepare('SELECT * FROM artifacts WHERE digest = ?').get(digest) as
    | Record<string, unknown>
    | undefined;
  if (!record || !existsSync(String(record.local_path))) return null;
  getSqlite()!
    .prepare('UPDATE artifacts SET last_access_at = ? WHERE digest = ?')
    .run(new Date().toISOString(), digest);
  return { ...record, localPath: String(record.local_path) };
}

export function pinArtifact(digest: string, delta = 1): number {
  if (!Number.isInteger(delta) || delta === 0)
    throw new Error('Pin delta must be a non-zero integer');
  const result = getSqlite()!
    .prepare(
      `UPDATE artifacts
          SET pin_count = MAX(0, pin_count + ?), last_access_at = ?
        WHERE digest = ?`,
    )
    .run(delta, new Date().toISOString(), digest);
  if (result.changes === 0) throw new Error('Artifact not found');
  return Number(
    (
      getSqlite()!.prepare('SELECT pin_count FROM artifacts WHERE digest = ?').get(digest) as {
        pin_count: number;
      }
    ).pin_count,
  );
}

export function beginArtifactTransfer(input: {
  sourceSiteId: string;
  destinationSiteId: string;
  digest: string;
  expectedSize: number;
}) {
  artifactPath(input.digest);
  if (!Number.isSafeInteger(input.expectedSize) || input.expectedSize < 0) {
    throw new Error('Artifact size must be a non-negative safe integer');
  }
  const existing = getSqlite()!
    .prepare(
      `SELECT * FROM artifact_transfers
        WHERE source_site_id = ? AND destination_site_id = ? AND digest = ?
          AND status IN ('pending', 'transferring')
        ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(input.sourceSiteId, input.destinationSiteId, input.digest) as
    | Record<string, unknown>
    | undefined;
  if (existing) return existing;

  const id = sortableId('transfer');
  const temporaryPath = temporaryArtifactPath(id);
  mkdirSync(dirname(temporaryPath), { recursive: true, mode: 0o700 });
  if (!existsSync(temporaryPath)) writeFileSync(temporaryPath, Buffer.alloc(0), { mode: 0o600 });
  getSqlite()!
    .prepare(
      `INSERT INTO artifact_transfers
        (id, source_site_id, destination_site_id, digest, expected_size,
         verified_offset, status, attempts, temporary_path, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 'pending', 0, ?, ?)`,
    )
    .run(
      id,
      input.sourceSiteId,
      input.destinationSiteId,
      input.digest,
      input.expectedSize,
      temporaryPath,
      new Date().toISOString(),
    );
  return getSqlite()!.prepare('SELECT * FROM artifact_transfers WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;
}

export async function appendArtifactTransferChunk(
  transferId: string,
  offset: number,
  chunk: Buffer,
  metadata: ArtifactMetadata,
) {
  const sqlite = getSqlite()!;
  const transfer = sqlite
    .prepare('SELECT * FROM artifact_transfers WHERE id = ?')
    .get(transferId) as Record<string, unknown> | undefined;
  if (!transfer) throw new Error('Artifact transfer not found');
  if (transfer.status === 'complete') return transfer;
  const verifiedOffset = Number(transfer.verified_offset);
  const expectedSize = Number(transfer.expected_size);
  const path = String(transfer.temporary_path);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid transfer offset');
  if (offset + chunk.length > expectedSize) throw new Error('Artifact chunk exceeds expected size');

  if (offset < verifiedOffset) {
    if (offset + chunk.length > verifiedOffset)
      throw new Error('Artifact chunk overlaps resume cursor');
    const existing = Buffer.alloc(chunk.length);
    const descriptor = openSync(path, 'r');
    try {
      readSync(descriptor, existing, 0, chunk.length, offset);
    } finally {
      closeSync(descriptor);
    }
    if (!existing.equals(chunk)) throw new Error('Replayed artifact chunk does not match');
    return transfer;
  }
  if (offset !== verifiedOffset) throw new Error(`Expected artifact offset ${verifiedOffset}`);

  const descriptor = openSync(path, 'r+');
  try {
    writeSync(descriptor, chunk, 0, chunk.length, offset);
  } finally {
    closeSync(descriptor);
  }
  const nextOffset = offset + chunk.length;
  sqlite
    .prepare(
      `UPDATE artifact_transfers
          SET verified_offset = ?, status = ?, attempts = attempts + 1, updated_at = ?
        WHERE id = ?`,
    )
    .run(
      nextOffset,
      nextOffset === expectedSize ? 'verifying' : 'transferring',
      new Date().toISOString(),
      transferId,
    );
  if (nextOffset !== expectedSize) {
    return sqlite.prepare('SELECT * FROM artifact_transfers WHERE id = ?').get(transferId);
  }

  const actualDigest = await digestFile(path);
  if (actualDigest !== transfer.digest) {
    sqlite
      .prepare(
        `UPDATE artifact_transfers SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
      )
      .run('Artifact digest mismatch', new Date().toISOString(), transferId);
    throw new Error('Artifact digest mismatch');
  }
  const destination = materializeImmutable(path, String(transfer.digest));
  unlinkSync(path);
  recordArtifact(String(transfer.digest), destination, metadata);
  sqlite
    .prepare(
      `UPDATE artifact_transfers
          SET status = 'complete', temporary_path = NULL, error = NULL, updated_at = ?
        WHERE id = ?`,
    )
    .run(new Date().toISOString(), transferId);
  return sqlite.prepare('SELECT * FROM artifact_transfers WHERE id = ?').get(transferId);
}

export function contentStoreStats() {
  const records = getSqlite()!
    .prepare(
      `SELECT COUNT(*) AS artifacts, COALESCE(SUM(byte_size), 0) AS logical_bytes,
              COALESCE(SUM(CASE WHEN pin_count > 0 THEN byte_size ELSE 0 END), 0) AS pinned_bytes
         FROM artifacts`,
    )
    .get() as { artifacts: number; logical_bytes: number; pinned_bytes: number };
  return {
    artifacts: records.artifacts,
    logicalBytes: records.logical_bytes,
    pinnedBytes: records.pinned_bytes,
    root: resolve(deployDataPath('blobs')),
    layout: basename(artifactPath(`sha256:${'0'.repeat(64)}`)),
  };
}
