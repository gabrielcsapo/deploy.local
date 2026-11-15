import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Database } from '../../kernel/db/sqlite.ts';

import { checkpointInfo } from './checkpoint-metadata.ts';

type SnapshotBlob = { digest: string; byteSize: number };
const digest = (bytes: Buffer) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

export function checkpointBlobPath(workspaceRoot: string, blob: SnapshotBlob): string {
  if (
    !/^sha256:[a-f0-9]{64}$/.test(blob?.digest) ||
    !Number.isSafeInteger(blob.byteSize) ||
    blob.byteSize < 0
  )
    throw new Error('Invalid checkpoint snapshot reference');
  const hash = blob.digest.slice(7);
  return join(workspaceRoot, 'blobs', 'sha256', hash.slice(0, 2), hash);
}

function verifiedBytes(workspaceRoot: string, blob: SnapshotBlob) {
  const bytes = readFileSync(checkpointBlobPath(workspaceRoot, blob));
  if (bytes.length !== blob.byteSize || digest(bytes) !== blob.digest)
    throw new Error('Checkpoint snapshot failed integrity verification');
  return bytes;
}

/** The serialized-body hash includes exclusions and is distinct from the tree/content digest. */
export function externalizeCheckpoint(workspaceRoot: string, row: any): any {
  if (!row.snapshot) return row;
  const bytes = Buffer.from(JSON.stringify(row.snapshot));
  const snapshotBlob = { digest: digest(bytes), byteSize: bytes.length };
  const destination = checkpointBlobPath(workspaceRoot, snapshotBlob);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  if (!existsSync(destination)) {
    const temporary = destination + '.' + randomUUID() + '.tmp';
    const fd = openSync(temporary, 'wx', 0o400);
    try {
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // Publish without replacing an existing immutable file, including a concurrent writer.
      try {
        linkSync(temporary, destination);
      } catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
      }
    } finally {
      unlinkSync(temporary);
    }
  }
  verifiedBytes(workspaceRoot, snapshotBlob);
  // Make directory entries durable before SQLite can commit a reference to this file.
  for (const directory of [
    dirname(destination),
    dirname(dirname(destination)),
    join(workspaceRoot, 'blobs'),
    workspaceRoot,
  ]) {
    const fd = openSync(directory, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  const { snapshot: _, ...metadata } = row;
  return { ...metadata, snapshotInfo: checkpointInfo({ snapshot: row.snapshot }), snapshotBlob };
}

export function materializeCheckpoint(workspaceRoot: string, row: any): any {
  if (row.snapshot || !row.snapshotBlob) return row;
  return {
    ...row,
    snapshot: JSON.parse(verifiedBytes(workspaceRoot, row.snapshotBlob).toString('utf8')),
  };
}

/** References come from the database snapshot, never the changing live records table. */
export function checkpointBlobReferences(database: Database): SnapshotBlob[] {
  return (
    database
      .prepare(`SELECT DISTINCT json_extract(data,'$.snapshotBlob') AS blob
    FROM records WHERE kind='checkpoint' AND json_type(data,'$.snapshotBlob')='object'`)
      .all() as { blob: string }[]
  ).map((row) => JSON.parse(row.blob));
}

export function verifyCheckpointBlobs(database: Database, workspaceRoot: string) {
  for (const blob of checkpointBlobReferences(database)) verifiedBytes(workspaceRoot, blob);
}

/** Bounded, yielding migration. A failed write leaves the original row intact. */
export async function migrateCheckpointSnapshots(
  database: Database,
  workspaceRoot: string,
  { maxRows = 8, maxBytes = 16 * 1024 * 1024 } = {},
) {
  const rows = database
    .prepare(`SELECT id,owner FROM records
    WHERE kind='checkpoint' AND json_type(data,'$.snapshot')='object' ORDER BY rowid LIMIT ?`)
    .all(maxRows) as { id: string; owner: string }[];
  let migrated = 0,
    bytes = 0;
  for (const { id, owner } of rows) {
    if (bytes >= maxBytes) break;
    // No await between read and compare/update; compare also protects other processes.
    const old = database
      .prepare("SELECT data FROM records WHERE kind='checkpoint' AND id=? AND owner=?")
      .get(id, owner) as { data: string } | undefined;
    if (!old) continue;
    const row = JSON.parse(old.data);
    if (!row.snapshot) continue;
    const stored = externalizeCheckpoint(workspaceRoot, row);
    migrated += database
      .prepare("UPDATE records SET data=? WHERE kind='checkpoint' AND id=? AND owner=? AND data=?")
      .run(JSON.stringify(stored), id, owner, old.data).changes;
    bytes += Buffer.byteLength(old.data);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return migrated;
}
