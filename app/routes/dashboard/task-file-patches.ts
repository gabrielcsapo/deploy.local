import { parseTaskDiff, type TaskFileDiff } from './task-diff';

/** One file's on-demand full patch: `/tasks/<id>/diff/file`, or why it is unavailable. */
export interface FilePatchState {
  patch?: string;
  /** Bytes of the complete patch, even when `patch` holds only the first of them. */
  bytes?: number;
  truncated?: boolean;
  omitted?: string;
  error?: string;
  loading?: boolean;
}
export type FilePatches = Record<string, FilePatchState>;

/**
 * The summary patch with every loaded full patch swapped in for its file, keeping the summary's
 * order and appending files the summary patch had no room for.
 */
export function mergeFilePatches(patch: string, patches: FilePatches): TaskFileDiff[] {
  const full = new Map<string, TaskFileDiff[]>();
  for (const [path, state] of Object.entries(patches))
    if (state.patch) full.set(path, parseTaskDiff(state.patch));
  if (!full.size) return parseTaskDiff(patch);
  const merged: TaskFileDiff[] = [];
  const used = new Set<string>();
  for (const file of parseTaskDiff(patch)) {
    const replacement = full.get(file.path);
    if (!replacement) merged.push(file);
    else if (!used.has(file.path)) {
      merged.push(...replacement);
      used.add(file.path);
    }
  }
  for (const [path, files] of full)
    if (!used.has(path)) {
      merged.push(...files);
      used.add(path);
    }
  return merged;
}

/** Whether a file's own patch can still be loaded: the summary may have clipped or skipped it. */
export function canLoadFilePatch(
  state: FilePatchState | undefined,
  inSummaryPatch: boolean,
  summaryTruncated: boolean,
) {
  if (state?.loading) return false;
  if (state?.patch || state?.omitted) return false;
  return !inSummaryPatch || summaryTruncated;
}

/** Patch sizes for buttons and notices, in the units a reviewer judges a download by. */
export function patchSize(bytes: number | undefined) {
  if (!bytes || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
