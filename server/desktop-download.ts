import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deployDataPath } from './data-directory.ts';

export interface DesktopBuildManifest {
  version: string;
  commit: string;
  buildTime: string;
  targets: Record<string, { file: string; size: number; sha256: string }>;
}

/** The file name a browser saves, for example deploy.local-Desktop-2.0.0-mac-arm64.zip. */
export function desktopDownloadFilename(version: string, os: string, arch: string): string {
  const platform = os === 'darwin' ? 'mac' : os === 'win32' ? 'windows' : os;
  return `deploy.local-Desktop-${version.replace(/[^A-Za-z0-9._-]/g, '-')}-${platform}-${arch}.zip`;
}

/**
 * Where the desktop app builds this server hands out live. Like the CLI, a
 * release serves its own `dist/desktop` when a build was copied into it, and
 * `<data>/desktop` outlives releases. The newer build wins.
 */
export function desktopDirectory(
  candidates = [resolve(process.cwd(), 'dist/desktop'), deployDataPath('desktop')],
): string {
  let chosen = candidates[0];
  let newest = '';
  for (const directory of candidates) {
    const built = readDesktopManifest(directory)?.buildTime ?? '';
    if (built > newest) {
      newest = built;
      chosen = directory;
    }
  }
  return chosen;
}

/** Written by scripts/build-desktop-download.mjs next to the archive it made. */
export function readDesktopManifest(directory = desktopDirectory()): DesktopBuildManifest | null {
  try {
    const manifest = JSON.parse(
      readFileSync(resolve(directory, 'build-info.json'), 'utf-8'),
    ) as DesktopBuildManifest;
    return manifest && typeof manifest === 'object' && manifest.targets ? manifest : null;
  } catch {
    return null;
  }
}

/** Routes /desktop/version and /desktop. Anything else under the prefix is not ours. */
export function isDesktopDownloadPath(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0];
  return path === '/desktop' || path === '/desktop/version';
}

export function serveDesktopRequest(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url ?? '').split('?')[0];
  if (path === '/desktop/version') {
    serveDesktopVersion(res);
    return;
  }
  void serveDesktopDownload(req, res);
}

const notPublished =
  "The desktop app isn't published on this coordinator. Run 'pnpm build:desktop-download' and copy dist/desktop to desktop/ in the server's data directory.";

/**
 * GET /desktop/version
 * Which desktop app builds this coordinator serves, so the docs and the Add a
 * computer dialog only offer downloads that exist.
 */
export function serveDesktopVersion(res: ServerResponse, directory = desktopDirectory()): void {
  const manifest = readDesktopManifest(directory);
  if (!manifest) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'no-desktop-build', message: notPublished }));
    return;
  }
  const body = JSON.stringify(manifest);
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Hashing a desktop archive reads ~100 MB, so a verified digest is remembered
// for as long as the file keeps its size and modification time.
const verifiedDigests = new Map<string, string>();

function sha256(path: string): Promise<string> {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolveDigest(hash.digest('hex')));
  });
}

/**
 * GET /desktop?os=<os>&arch=<arch>
 * Streams the zipped desktop app for one platform after checking it against
 * the size and SHA-256 recorded in its manifest.
 */
export async function serveDesktopDownload(
  req: IncomingMessage,
  res: ServerResponse,
  directory = desktopDirectory(),
): Promise<void> {
  const url = new URL(req.url ?? '/desktop', 'http://deploy.local');
  const os = url.searchParams.get('os');
  const arch = url.searchParams.get('arch');
  const text = (status: number, message: string) => {
    res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end(message);
  };

  if (!os || !arch) return text(400, 'Missing os and arch query parameters');
  if (!/^[a-z0-9]+$/.test(os) || !/^[a-z0-9]+$/.test(arch)) return text(400, 'Invalid os or arch');

  const manifest = readDesktopManifest(directory);
  if (!manifest) return text(404, notPublished);
  const target = manifest.targets[`${os}-${arch}`];
  if (!target) return text(404, `No desktop app build for ${os}-${arch} on this coordinator.`);
  // The manifest names the archive; it must stay a bare file inside the folder.
  if (
    typeof target.file !== 'string' ||
    basename(target.file) !== target.file ||
    !target.file.endsWith('.zip')
  ) {
    return text(409, 'Desktop app build does not match its manifest.');
  }
  if (url.searchParams.has('version') && url.searchParams.get('version') !== manifest.version) {
    return text(409, 'Desktop app build does not match its manifest. Try again after the release.');
  }

  const path = resolve(directory, target.file);
  let size: number;
  let digest: string;
  try {
    const stat = statSync(path);
    size = stat.size;
    const key = `${path}:${stat.size}:${stat.mtimeMs}`;
    digest = verifiedDigests.get(key) ?? (await sha256(path));
    if (size === target.size && digest === target.sha256) verifiedDigests.set(key, digest);
  } catch {
    return text(404, `No desktop app build for ${os}-${arch} on this coordinator.`);
  }
  if (size !== target.size || digest !== target.sha256) {
    return text(409, 'Desktop app build does not match its manifest. Try again after the release.');
  }

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${desktopDownloadFilename(manifest.version, os, arch)}"`,
    'Content-Length': size,
    'Cache-Control': 'no-store',
    'X-Deploy-Desktop-Version': manifest.version,
    'X-Deploy-Desktop-Sha256': target.sha256,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(path)
    .on('error', () => res.destroy())
    .pipe(res);
}
