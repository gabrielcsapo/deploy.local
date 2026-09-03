import { createReadStream } from 'node:fs';
import { posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { extract, type Headers } from 'tar-stream';

const configuredUploadBytes = Number(process.env.DEPLOY_MAX_UPLOAD_ARCHIVE_BYTES);
export const MAX_UPLOAD_ARCHIVE_BYTES =
  Number.isSafeInteger(configuredUploadBytes) && configuredUploadBytes > 0
    ? configuredUploadBytes
    : 512 * 1024 * 1024;
export const MAX_UPLOAD_ARCHIVE_ENTRIES = 100_000;
export const MAX_UPLOAD_EXPANDED_BYTES = 4 * 1024 * 1024 * 1024;

const MAX_ARCHIVE_PATH_BYTES = 4096;
const REGULAR_FILE_TYPES = new Set<Headers['type']>(['file', undefined, null]);
const ALLOWED_ENTRY_TYPES = new Set<Headers['type']>([
  'file',
  'directory',
  'symlink',
  'link',
  undefined,
  null,
]);

export class UploadArchiveError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'UploadArchiveError';
    this.status = status;
  }
}

export interface UploadArchiveInspection {
  entries: number;
  expandedBytes: number;
}

export interface UploadArchiveLimits {
  entries?: number;
  expandedBytes?: number;
}

function portablePath(value: string, label: string, allowParentSegments = false): string {
  if (!value || value.includes('\0')) {
    throw new UploadArchiveError(`${label} is empty or contains a NUL byte`);
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_ARCHIVE_PATH_BYTES) {
    throw new UploadArchiveError(`${label} exceeds ${MAX_ARCHIVE_PATH_BYTES} bytes`);
  }

  // Tar paths use POSIX separators, but normalize backslashes too so an archive
  // accepted on Unix cannot become a traversal when extracted by bsdtar on
  // Windows.
  const portable = value.replaceAll('\\', '/');
  if (portable.startsWith('/') || /^[A-Za-z]:/.test(portable)) {
    throw new UploadArchiveError(`${label} must be relative`);
  }
  if (!allowParentSegments && portable.split('/').includes('..')) {
    throw new UploadArchiveError(`${label} contains parent traversal`);
  }

  const normalized = posix.normalize(portable);
  if (
    !allowParentSegments &&
    (normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized))
  ) {
    throw new UploadArchiveError(`${label} escapes the deployment root`);
  }
  return normalized;
}

function safeLinkTarget(entryName: string, target: string, hardLink: boolean): string {
  const portableTarget = portablePath(target, `Archive link target for "${entryName}"`, true);
  const resolved = hardLink
    ? posix.normalize(portableTarget)
    : posix.normalize(posix.join(posix.dirname(entryName), portableTarget));
  if (resolved === '..' || resolved.startsWith('../') || posix.isAbsolute(resolved)) {
    throw new UploadArchiveError(
      `Archive link target for "${entryName}" escapes the deployment root`,
    );
  }
  return resolved;
}

function normalizedEntryType(header: Headers) {
  return REGULAR_FILE_TYPES.has(header.type) ? 'file' : header.type;
}

/**
 * Stream and validate every header in a gzip-compressed tar archive without
 * materializing entry bodies. The caller may safely hand the same immutable
 * file to the platform tar binary only after this resolves.
 */
export async function inspectUploadArchive(
  path: string,
  limits: UploadArchiveLimits = {},
): Promise<UploadArchiveInspection> {
  const maximumEntries = limits.entries ?? MAX_UPLOAD_ARCHIVE_ENTRIES;
  const maximumExpandedBytes = limits.expandedBytes ?? MAX_UPLOAD_EXPANDED_BYTES;
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries <= 0) {
    throw new TypeError('Archive entry limit must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maximumExpandedBytes) || maximumExpandedBytes <= 0) {
    throw new TypeError('Archive expanded-byte limit must be a positive safe integer');
  }
  const extractor = extract();
  const parse = pipeline(createReadStream(path), createGunzip(), extractor);
  void parse.catch(() => {});
  const entryTypes = new Map<string, ReturnType<typeof normalizedEntryType>>();
  const hardLinks: Array<{ name: string; target: string }> = [];
  let entries = 0;
  let expandedBytes = 0;

  try {
    for await (const entry of extractor) {
      entries++;
      if (entries > maximumEntries) {
        throw new UploadArchiveError(
          `Deployment archive exceeds ${maximumEntries.toLocaleString('en-US')} entries`,
          413,
        );
      }

      const header = entry.header;
      const name = portablePath(header.name, 'Archive entry path');
      if (entryTypes.has(name)) {
        throw new UploadArchiveError(`Deployment archive contains duplicate path "${name}"`);
      }
      if (!ALLOWED_ENTRY_TYPES.has(header.type)) {
        throw new UploadArchiveError(
          `Deployment archive entry "${name}" has unsupported type "${header.type || 'unknown'}"`,
        );
      }

      const entryType = normalizedEntryType(header);
      entryTypes.set(name, entryType);
      if (entryType === 'symlink' || entryType === 'link') {
        if (!header.linkname) {
          throw new UploadArchiveError(`Deployment archive link "${name}" has no target`);
        }
        const target = safeLinkTarget(name, header.linkname, entryType === 'link');
        if (entryType === 'link') hardLinks.push({ name, target });
      }

      const declaredSize = header.size ?? 0;
      if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
        throw new UploadArchiveError(`Deployment archive entry "${name}" has an invalid size`);
      }
      if (expandedBytes + declaredSize > maximumExpandedBytes) {
        throw new UploadArchiveError(
          `Deployment archive expands beyond ${maximumExpandedBytes.toLocaleString('en-US')} bytes`,
          413,
        );
      }

      let streamedBytes = 0;
      for await (const chunk of entry) streamedBytes += chunk.length;
      if (streamedBytes !== declaredSize) {
        throw new UploadArchiveError(`Deployment archive entry "${name}" has inconsistent size`);
      }
      expandedBytes += streamedBytes;
    }
    await parse;

    if (entries === 0) throw new UploadArchiveError('Deployment archive is empty');
    for (const { name, target } of hardLinks) {
      if (entryTypes.get(target) !== 'file') {
        throw new UploadArchiveError(
          `Deployment archive hard link "${name}" does not target a regular archived file`,
        );
      }
    }
    return { entries, expandedBytes };
  } catch (error) {
    extractor.destroy();
    await parse.catch(() => {});
    if (error instanceof UploadArchiveError) throw error;
    throw new UploadArchiveError(
      `Invalid gzip-compressed deployment archive: ${(error as Error).message}`,
    );
  }
}
