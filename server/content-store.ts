import { createHash } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { deployDataPath } from './kernel/files/data-directory.ts';
import { getSqlite } from './store.ts';

const DIGEST_PATTERN = /^sha256:([a-f0-9]{64})$/;

export interface ArtifactMetadata {
  type: string;
  mediaType?: string;
  architecture?: string;
  retentionClass?: 'temporary' | 'release' | 'checkpoint' | 'recovery';
}

function artifactPath(digest: string): string {
  const match = digest.match(DIGEST_PATTERN);
  if (!match) throw new Error('Invalid SHA-256 artifact digest');
  return deployDataPath('blobs', 'sha256', match[1].slice(0, 2), match[1]);
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
         verification_status, retention_class, pin_count,
         created_at, last_access_at)
       VALUES (?, ?, ?, ?, ?, ?, 'verified', ?, 0, ?, ?)
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
