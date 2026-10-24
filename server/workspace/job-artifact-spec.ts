// Shared by the coordinator and every worker distribution; keep it free of store/database imports.

/** Workers report this capability when they can collect and upload job artifacts. */
export const jobArtifactCapability = 'job-artifacts';
export const artifactLimits = {
  /** Requested path or glob entries per job. */
  entries: 20,
  /** Uploaded files per job, across every entry. */
  files: 20,
  /** Bytes per file (images, videos and text). Images are further bounded by the 20 MB media limit. */
  fileBytes: 25 * 1024 * 1024,
  /** Text artifacts are redacted in memory on the coordinator, so they are smaller. */
  textBytes: 5 * 1024 * 1024,
  /** Bytes per job, across every uploaded file. */
  jobBytes: 100 * 1024 * 1024,
  /** Files a single glob may inspect before giving up. */
  scannedEntries: 5000,
};
export type ArtifactRequest = { path: string; caption?: string };
export type ArtifactResult = {
  path: string;
  name: string;
  caption: string;
  attachmentId?: string;
  kind?: 'image' | 'video' | 'file';
  bytes?: number;
  skipped?: string;
};

const control = (character: string) =>
  character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127;
const hasControl = (value: string) => Array.from(value).some(control);

const textExtensions = new Set([
  'txt',
  'log',
  'json',
  'jsonl',
  'ndjson',
  'xml',
  'md',
  'markdown',
  'csv',
  'tsv',
  'yaml',
  'yml',
  'junit',
  'tap',
  'out',
  'err',
  'trace',
  'diff',
  'patch',
]);
const mediaExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'm4v', 'webm']);
function extension(name: string) {
  const base = name.split('/').at(-1) || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}
/** Text artifacts are recognised by extension; the coordinator still verifies UTF-8 content. */
export function isTextArtifactName(name: string) {
  return textExtensions.has(extension(name));
}
export function isMediaArtifactName(name: string) {
  return mediaExtensions.has(extension(name));
}

/**
 * Validate the agent's request. Paths are relative to the job directory and may use `*` and `?`
 * within a segment or a whole `**` segment; absolute paths, `..`, and control characters are refused.
 */
export function artifactRequests(input: unknown): ArtifactRequest[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > artifactLimits.entries)
    throw new Error(`artifacts must be an array of at most ${artifactLimits.entries} entries`);
  return input.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Each artifact must be an object with a path');
    if (Object.keys(entry).some((key) => !['path', 'caption'].includes(key)))
      throw new Error('Artifact entries accept only path and caption');
    const path = (entry as any).path,
      caption = (entry as any).caption;
    if (
      typeof path !== 'string' ||
      !path.trim() ||
      path.length > 300 ||
      hasControl(path) ||
      path.includes('\\')
    )
      throw new Error('Artifact path must be a relative path of at most 300 characters');
    const normalized = path.trim().replace(/^(?:\.\/)+/, '');
    const parts = normalized.split('/');
    if (
      normalized.startsWith('/') ||
      /^~/.test(normalized) ||
      parts.some((part) => !part || part === '..' || part === '.')
    )
      throw new Error(`Artifact path ${JSON.stringify(path)} must stay inside the job directory`);
    if (parts.filter((part) => part === '**').length > 1)
      throw new Error('Artifact globs accept at most one ** segment');
    if (
      caption !== undefined &&
      (typeof caption !== 'string' || caption.length > 300 || hasControl(caption))
    )
      throw new Error('Artifact caption must be plain text of at most 300 characters');
    return { path: normalized, ...(caption?.trim() ? { caption: caption.trim() } : {}) };
  });
}

/** Skipped entries reported by a worker are display text only; bound and sanitize them. */
export function skippedArtifacts(input: unknown): ArtifactResult[] {
  if (!Array.isArray(input)) return [];
  const clean = (value: unknown, length: number) =>
    Array.from(String(value ?? ''))
      .map((character) => (control(character) ? ' ' : character))
      .join('')
      .slice(0, length);
  return input
    .filter((entry) => entry && typeof entry === 'object' && entry.skipped)
    .slice(0, 50)
    .map((entry) => {
      const path = clean(entry.path, 300);
      return {
        path,
        name: clean(entry.name || path.split('/').at(-1), 255),
        caption: clean(entry.caption, 300),
        skipped: clean(entry.skipped, 300),
      };
    });
}

const escape = (value: string) => value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
/** `*` and `?` stay within one path segment; a `**` segment spans any number of directories. */
export function artifactPattern(pattern: string) {
  const parts = pattern.split('/');
  let source = '';
  parts.forEach((part, index) => {
    const last = index === parts.length - 1;
    if (part === '**') source += last ? '(?:[^/]+/)*[^/]+' : '(?:[^/]+/)*';
    else
      source +=
        part
          .split('')
          .map((character) =>
            character === '*' ? '[^/]*' : character === '?' ? '[^/]' : escape(character),
          )
          .join('') + (last ? '' : '/');
  });
  return new RegExp('^' + source + '$');
}
export function isArtifactGlob(pattern: string) {
  return /[*?]/.test(pattern);
}
/** The coordinator only accepts uploads whose path matches what the agent asked for. */
export function matchesArtifactRequest(path: string, requests: ArtifactRequest[]) {
  return requests.some((request) =>
    isArtifactGlob(request.path) ? artifactPattern(request.path).test(path) : request.path === path,
  );
}
