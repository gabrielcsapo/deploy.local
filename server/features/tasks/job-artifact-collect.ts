// Worker side of job artifacts: find the requested files inside the finished job's isolated
// directory and stream each one to the coordinator. Never imports the coordinator store.
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import type { Readable } from 'node:stream';
import { basename, resolve, sep } from 'node:path';
import {
  artifactLimits,
  artifactPattern,
  isArtifactGlob,
  isMediaArtifactName,
  isTextArtifactName,
  type ArtifactRequest,
  type ArtifactResult,
} from './job-artifact-spec.ts';
import { sniffImage } from './media-files.ts';
import { sniffVideo } from './video-files.ts';

export type ResolvedArtifact = {
  path: string;
  realPath: string;
  name: string;
  caption: string;
  size: number;
};
export type ArtifactUpload = (
  file: { path: string; name: string; caption: string; size: number },
  body: Readable,
  signal: AbortSignal,
) => Promise<ArtifactResult>;

/** JPEG frame headers may sit beyond the prefix; the coordinator reads the whole file to verify. */
export function looksLikeMedia(prefix: Buffer) {
  return Boolean(
    sniffImage(prefix) || sniffVideo(prefix) || (prefix[0] === 0xff && prefix[1] === 0xd8),
  );
}
const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
const skip = (path: string, caption: string, skipped: string): ArtifactResult => ({
  path,
  name: basename(path),
  caption,
  skipped,
});

/**
 * Resolve requested paths and globs to regular files whose real path stays inside `directory`.
 * Directory symlinks are not walked; file symlinks are allowed only when they resolve inside.
 */
export function resolveArtifacts(directory: string, requests: ArtifactRequest[]) {
  const root = realpathSync(directory);
  const inside = (path: string) => path.startsWith(root + sep);
  const files: ResolvedArtifact[] = [],
    skipped: ArtifactResult[] = [],
    seen = new Set<string>();
  const consider = (relative: string, caption: string, explicit: boolean) => {
    let real: string;
    try {
      real = realpathSync(resolve(root, relative));
    } catch {
      if (explicit) skipped.push(skip(relative, caption, 'File not found'));
      return;
    }
    if (!inside(real)) {
      skipped.push(skip(relative, caption, 'Refused: the path resolves outside the job directory'));
      return;
    }
    const stat = statSync(real);
    if (!stat.isFile()) {
      if (explicit) skipped.push(skip(relative, caption, 'Not a regular file'));
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    files.push({
      path: relative,
      realPath: real,
      name: basename(relative),
      caption,
      size: stat.size,
    });
  };
  for (const request of requests) {
    const caption = request.caption || '';
    if (!isArtifactGlob(request.path)) {
      consider(request.path, caption, true);
      continue;
    }
    const parts = request.path.split('/');
    const first = parts.findIndex((part) => isArtifactGlob(part));
    const prefix = parts.slice(0, first).join('/');
    const depth = parts.includes('**') ? Infinity : parts.length - first;
    const pattern = artifactPattern(request.path);
    const before = files.length + skipped.length;
    let start: string;
    try {
      start = realpathSync(resolve(root, prefix || '.'));
    } catch {
      skipped.push(skip(request.path, caption, 'No files matched'));
      continue;
    }
    if (start !== root && !inside(start)) {
      skipped.push(
        skip(request.path, caption, 'Refused: the path resolves outside the job directory'),
      );
      continue;
    }
    let scanned = 0;
    const matches: string[] = [];
    const walk = (absolute: string, relative: string, level: number) => {
      let entries: string[];
      try {
        entries = readdirSync(absolute).sort();
      } catch {
        return;
      }
      for (const entry of entries) {
        if (++scanned > artifactLimits.scannedEntries) return;
        if (entry === '.git') continue;
        const childRelative = relative ? relative + '/' + entry : entry;
        const stat = lstatSync(resolve(absolute, entry));
        if (stat.isDirectory()) {
          if (level + 1 < depth) walk(resolve(absolute, entry), childRelative, level + 1);
        } else if (pattern.test(childRelative)) matches.push(childRelative);
      }
    };
    walk(start, prefix, 0);
    for (const match of matches) consider(match, caption, false);
    if (scanned > artifactLimits.scannedEntries)
      skipped.push(
        skip(
          request.path,
          caption,
          `Stopped after inspecting ${artifactLimits.scannedEntries} entries; use a narrower path`,
        ),
      );
    else if (files.length + skipped.length === before)
      skipped.push(skip(request.path, caption, 'No files matched'));
  }
  return { files, skipped };
}

function readPrefix(fd: number, size: number) {
  const prefix = Buffer.alloc(Math.min(size, 65536));
  let length = 0;
  for (let n = 1; n && length < prefix.length; length += n)
    n = readSync(fd, prefix, length, prefix.length - length, length);
  return prefix.subarray(0, length);
}

/** Apply the shared caps, then upload one file at a time with bounded memory. */
export async function collectJobArtifacts(
  directory: string,
  requests: ArtifactRequest[],
  upload: ArtifactUpload | undefined,
  signal: AbortSignal,
): Promise<ArtifactResult[]> {
  if (!requests.length) return [];
  if (!upload)
    return requests.map((request) =>
      skip(request.path, request.caption || '', 'This worker cannot upload job artifacts'),
    );
  let resolved: ReturnType<typeof resolveArtifacts>;
  try {
    resolved = resolveArtifacts(directory, requests);
  } catch (error: any) {
    return requests.map((request) =>
      skip(request.path, request.caption || '', `Artifacts unavailable: ${error.message}`),
    );
  }
  const results: ArtifactResult[] = [...resolved.skipped];
  let uploaded = 0,
    bytes = 0;
  for (const file of resolved.files) {
    const refuse = (reason: string) => results.push(skip(file.path, file.caption, reason));
    if (signal.aborted) {
      refuse('The job was cancelled or timed out before this artifact was uploaded');
      continue;
    }
    const text = isTextArtifactName(file.name);
    const limit = text ? artifactLimits.textBytes : artifactLimits.fileBytes;
    if (!file.size) {
      refuse('File is empty');
      continue;
    }
    if (file.size > limit) {
      refuse(`File is ${megabytes(file.size)}; the limit for this kind is ${megabytes(limit)}`);
      continue;
    }
    if (bytes + file.size > artifactLimits.jobBytes) {
      refuse(`Per-job artifact limit of ${megabytes(artifactLimits.jobBytes)} reached`);
      continue;
    }
    let fd: number;
    try {
      fd = openSync(
        file.realPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error: any) {
      refuse(`Could not open file: ${error.code || error.message}`);
      continue;
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size !== file.size) {
        refuse('File changed while collecting artifacts');
        continue;
      }
      if (!text) {
        const prefix = readPrefix(fd, stat.size);
        if (!looksLikeMedia(prefix)) {
          refuse(
            isMediaArtifactName(file.name)
              ? 'Unrecognised image or video data'
              : 'Unsupported file type: only images, videos and text files can be returned',
          );
          continue;
        }
      }
      if (uploaded >= artifactLimits.files) {
        refuse(`Artifact limit of ${artifactLimits.files} files per job reached`);
        continue;
      }
      const body = createReadStream('', { fd, autoClose: false, start: 0, end: stat.size - 1 });
      const result = await upload(
        { path: file.path, name: file.name, caption: file.caption, size: stat.size },
        body,
        signal,
      );
      if (result.attachmentId) {
        uploaded++;
        bytes += result.bytes ?? stat.size;
        results.push(result);
      } else refuse(result.skipped || 'The coordinator did not store this artifact');
    } catch (error: any) {
      refuse(String(error?.message || error).slice(0, 300));
    } finally {
      closeSync(fd);
    }
  }
  return results;
}
