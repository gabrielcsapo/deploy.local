import { open } from 'node:fs/promises';
import { buildLogFilePath } from '../store.ts';
import { db } from '../workspace/store.ts';

/**
 * The build log an uploaded release writes to, or null for a release that has none (one started
 * from a pull request, say). The upload saves the pairing when it starts the release.
 */
export function releaseBuildLogId(releaseId: unknown, owner?: string): number | null {
  if (typeof releaseId !== 'string' || !releaseId) return null;
  const row = db
    .prepare(
      "SELECT json_extract(data,'$.id') AS id FROM records WHERE kind='v2-upload-release' AND json_extract(data,'$.releaseId')=? AND (? IS NULL OR owner=?) ORDER BY CAST(json_extract(data,'$.id') AS INTEGER) DESC LIMIT 1",
    )
    .get(releaseId, owner ?? null, owner ?? null) as { id?: string } | undefined;
  const id = Number(row?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * The build log for a release job on a computer. The job does not carry the release's ID: it
 * carries the ID of the release's plan (`plan.runtime.id`), which the release record holds.
 */
export function releaseJobBuildLogId(planId: unknown): number | null {
  if (typeof planId !== 'string' || !planId) return null;
  const row = db
    .prepare(
      "SELECT json_extract(data,'$.id') AS id FROM records WHERE kind='v2-release' AND json_extract(data,'$.plan.runtime.id')=? LIMIT 1",
    )
    .get(planId) as { id?: string } | undefined;
  return releaseBuildLogId(row?.id ?? planId);
}

/** Read only a bounded suffix, even when the append-only log is many gigabytes. */
export async function releaseBuildOutput(owner: string, releaseId: string): Promise<string> {
  const id = releaseBuildLogId(releaseId, owner);
  if (id === null) return '';
  let file;
  try {
    file = await open(buildLogFilePath(id), 'r');
    const { size } = await file.stat();
    const start = Math.max(0, size - 64 * 1024);
    const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    let offset = 0;
    // A byte cap can start inside a UTF-8 code point. Never emit a broken prefix.
    if (start) while (offset < bytesRead && (buffer[offset] & 0xc0) === 0x80) offset++;
    let text = new TextDecoder().decode(buffer.subarray(offset, bytesRead), { stream: true });
    if (start && text.includes('\n')) text = text.slice(text.indexOf('\n') + 1);
    return text.replace(/\n$/, '').split('\n').slice(-200).join('\n');
  } catch (error: any) {
    if (error.code === 'ENOENT') return '';
    throw error;
  } finally {
    await file?.close();
  }
}
