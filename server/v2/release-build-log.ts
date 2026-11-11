import { db } from '../workspace/store.ts';

/**
 * The build log an uploaded release writes to, or null for a release that has none (one started
 * from a pull request, say). The upload saves the pairing when it starts the release.
 */
export function releaseBuildLogId(releaseId: unknown): number | null {
  if (typeof releaseId !== 'string' || !releaseId) return null;
  const row = db
    .prepare(
      "SELECT json_extract(data,'$.id') AS id FROM records WHERE kind='v2-upload-release' AND json_extract(data,'$.releaseId')=? ORDER BY CAST(json_extract(data,'$.id') AS INTEGER) DESC LIMIT 1",
    )
    .get(releaseId) as { id?: string } | undefined;
  const id = Number(row?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
