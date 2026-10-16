import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export const snapshotLimit = 8 * 1024 * 1024;
export type Snapshot = {
  files: { path: string; content: string; executable: boolean }[];
  excluded: string[];
  digest: string;
};
const privatePath = (path: string) =>
  path
    .split('/')
    .map((part) => part.normalize('NFC').toLowerCase())
    .some(
      (p) =>
        p === '.git' ||
        p === '.ssh' ||
        p === '.aws' ||
        p === '.npmrc' ||
        p === '.netrc' ||
        /^(\.env($|\.)|id_rsa|id_ed25519)/i.test(p) ||
        /\.(pem|key|p12|pfx)$/i.test(p),
    );
const validPath = (path: string) =>
  typeof path === 'string' &&
  path.length > 0 &&
  path.length < 1024 &&
  !path.includes('\\') &&
  !path.includes('\0') &&
  !path.startsWith('/') &&
  path.split('/').every((p) => p !== '.' && p !== '..' && p !== '') &&
  !privatePath(path);
function digest(files: Snapshot['files']) {
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}
export function validateSnapshot(value: Snapshot): Snapshot {
  if (
    !Array.isArray(value?.files) ||
    value.files.length > 10000 ||
    !Array.isArray(value.excluded) ||
    value.excluded.length > 10000
  )
    throw new Error('Invalid checkpoint');
  const seen = new Set<string>();
  const portableKey = (path: string) => path.normalize('NFC').toLowerCase();
  let size = 0;
  const files = value.files
    .map((f) => {
      if (
        !f ||
        !validPath(f.path) ||
        seen.has(portableKey(f.path)) ||
        typeof f.content !== 'string' ||
        typeof f.executable !== 'boolean'
      )
        throw new Error('Unsafe checkpoint path or entry');
      seen.add(portableKey(f.path));
      const bytes = Buffer.from(f.content, 'base64');
      if (bytes.toString('base64') !== f.content) throw new Error('Invalid checkpoint encoding');
      size += bytes.length;
      if (size > snapshotLimit) throw new Error('Checkpoint exceeds 8 MiB');
      return { path: f.path, content: f.content, executable: f.executable };
    })
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));
  for (const f of files) {
    const parts = f.path.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (seen.has(portableKey(parts.join('/'))))
        throw new Error('Checkpoint file/directory collision');
    }
  }
  const excluded = value.excluded.map((p) => String(p).slice(0, 1024));
  const hash = digest(files);
  if (value.digest !== hash) throw new Error('Checkpoint digest mismatch');
  return { files, excluded, digest: hash };
}
export function captureSnapshot(cwd: string): Snapshot {
  const result = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10000,
    },
  );
  if (result.status !== 0) throw new Error('Checkpoint requires a Git workspace');
  const files: Snapshot['files'] = [],
    excluded: string[] = [];
  let total = 0;
  for (const path of [...new Set(result.stdout.split('\0').filter(Boolean))].sort()) {
    if (!validPath(path)) {
      excluded.push(path);
      continue;
    }
    let stat;
    try {
      // Never follow symlink parents (including submodules or replaced directories).
      let parent = cwd;
      for (const part of path.split('/')) {
        parent = resolve(parent, part);
        if (lstatSync(parent).isSymbolicLink()) throw new Error('Symlink');
      }
      stat = lstatSync(resolve(cwd, path));
    } catch {
      excluded.push(path);
      continue;
    }
    if (!stat.isFile()) {
      excluded.push(path);
      continue;
    }
    if (stat.size + total > snapshotLimit)
      throw new Error('Checkpoint exceeds 8 MiB; reduce the workspace before retrying');
    const bytes = readFileSync(resolve(cwd, path));
    total += bytes.length;
    files.push({ path, content: bytes.toString('base64'), executable: Boolean(stat.mode & 0o111) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return validateSnapshot({ files, excluded, digest: digest(files) });
}
export function restoreSnapshot(value: Snapshot, destination: string) {
  const snapshot = validateSnapshot(value);
  // A fresh directory is mandatory; never reuse a possibly modified job checkout.
  mkdirSync(destination, { recursive: false, mode: 0o700 });
  for (const file of snapshot.files) {
    const path = resolve(destination, file.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, Buffer.from(file.content, 'base64'), {
      flag: 'wx',
      mode: file.executable ? 0o700 : 0o600,
    });
  }
}
