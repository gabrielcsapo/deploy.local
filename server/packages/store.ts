import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, readdir, lstat, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getSqlite } from '../store.ts';
import { deployDataDirectory } from '../data-directory.ts';
import type { ServerResponse, IncomingMessage } from 'node:http';

export const MAX_FILE = 200 * 1024 * 1024;
export const MAX_UPSTREAM_DOC = 256 * 1024 * 1024;
export const MAX_DOC = 10 * 1024 * 1024;
export const db = () => getSqlite()!;
export const now = () => new Date().toISOString();
export function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}
export function nameOf(value: string) {
  if (value.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value))
    fail('Invalid package name');
  return value;
}
export function fileOf(value: string) {
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.tgz$/.test(value) || value.includes('..'))
    fail('Invalid tarball filename');
  return value;
}
export function versionOf(value: string) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value) || value.length > 100)
    fail('Invalid package version');
  return value;
}
export function tagOf(value: string) {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/.test(value)) fail('Invalid dist-tag');
  return value;
}
export function objectPath(area: 'hosted' | 'cache' | 'docs', hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) fail('Invalid package hash');
  return join(
    deployDataDirectory(),
    'packages',
    area === 'docs' ? 'cache' : area,
    area === 'docs' ? 'docs' : 'sha256',
    hash.slice(0, 2),
    hash,
  );
}
export const tempRoot = () => join(deployDataDirectory(), 'packages', 'tmp');
export function limiter(max: number, onChunk?: (chunk: Buffer) => void) {
  let size = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > max)
        return callback(Object.assign(new Error('Package body too large'), { status: 413 }));
      onChunk?.(chunk);
      callback(null, chunk);
    },
  });
}
/** Only verified bytes become addressable. Temp names never contain request input. */
export async function storeFile(
  source: Readable,
  area: 'hosted' | 'cache' | 'docs',
  integrity: string,
  max = MAX_FILE,
  promote?: (
    file: { sha256: string; size: number; integrity: string },
    move: () => Promise<void>,
  ) => Promise<void>,
) {
  const matches = integrity
    .split(/\s+/)
    .map((value) => /^(sha512|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(value))
    .filter(Boolean);
  const match =
    matches.find((m) => m![1] === 'sha512') ||
    matches.find((m) => m![1] === 'sha256') ||
    matches[0];
  if (!match) fail('Missing or invalid tarball integrity', 422);
  await mkdir(tempRoot(), { recursive: true, mode: 0o700 });
  const temp = join(tempRoot(), randomUUID());
  const sha = createHash('sha256'),
    expected = createHash(match[1]);
  let size = 0;
  try {
    await pipeline(
      source,
      limiter(max, (chunk) => {
        sha.update(chunk);
        expected.update(chunk);
        size += chunk.length;
      }),
      createWriteStream(temp, { flags: 'wx', mode: 0o600 }),
    );
    if (expected.digest('base64') !== match[2]) fail('Tarball integrity check failed', 422);
    const hash = sha.digest('hex');
    const path = objectPath(area, hash);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = { sha256: hash, size, integrity };
    if (promote) await promote(file, () => rename(temp, path));
    else await rename(temp, path);
    return file;
  } finally {
    await rm(temp, { force: true });
  }
}
export async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  area: 'hosted' | 'cache' | 'docs',
  file: { sha256: string; size: number },
  contentType = 'application/octet-stream',
  handle?: FileHandle,
) {
  // Shared downloads finish even if their initiating client has disconnected.
  if (req.aborted || res.destroyed) return;
  const etag = `"${file.sha256}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': file.size,
    ETag: etag,
    'Cache-Control': 'private, no-cache',
  });
  await pipeline(
    handle ? handle.createReadStream() : createReadStream(objectPath(area, file.sha256)),
    res,
  );
}
export type Package = {
  id: string;
  name: string;
  ecosystem: string;
  created_by: string;
  project_id: string | null;
  created_at: string;
};
export type Version = {
  package_id: string;
  version: string;
  sha256: string;
  size: number;
  integrity: string;
  manifest: string;
  deprecated: string | null;
  published_by: string;
  published_via: string;
  created_at: string;
};
export const packageByName = (name: string) =>
  db().prepare("SELECT * FROM packages WHERE ecosystem='npm' AND name=?").get(name) as
    | Package
    | undefined;
export const versions = (id: string) =>
  db()
    .prepare(
      'SELECT * FROM package_versions WHERE package_id=? ORDER BY created_at DESC, rowid DESC',
    )
    .all(id) as Version[];
const servedDatabases = new WeakSet<object>();
export function served() {
  const database = db();
  if (servedDatabases.has(database)) return;
  database
    .prepare(
      "INSERT INTO system_settings(key,value,updated_at) VALUES('packages.served','true',?) ON CONFLICT(key) DO NOTHING",
    )
    .run(now());
  servedDatabases.add(database);
}

/** Startup best-effort cleanup uses async filesystem calls and never follows links. */
export async function cleanTemporaryFiles(root = tempRoot(), clock = Date.now()) {
  const names = await readdir(root).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const name of names) {
    const path = join(root, name);
    const metadata = await lstat(path).catch(() => null);
    if (metadata && clock - metadata.mtimeMs > 60 * 60 * 1000)
      await rm(path, { recursive: true, force: true });
  }
}
export const recentlyUsed = (timestamp: string | null) =>
  timestamp !== null && Date.now() - Date.parse(timestamp) < 60000;
