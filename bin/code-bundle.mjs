import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { acceptsLauncher } from './launcher-protocol.mjs';

export const bundleDigest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink()) throw new Error('Bundle directory is a symlink');
  chmodSync(path, 0o700);
}
export function atomicJson(path, value) {
  privateDirectory(dirname(path));
  const staged = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staged, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx', flush: true });
    renameSync(staged, path);
    const fd = openSync(dirname(path), 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(staged, { force: true });
  }
}
export function readCurrentBundle(agentDir) {
  const path = join(agentDir, 'code/current.json');
  if (!existsSync(path)) return null;
  if (lstatSync(path).isSymbolicLink()) throw new Error('Bundle pointer is a symlink');
  chmodSync(path, 0o600);
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function readPreviousBundle(agentDir) {
  try {
    return JSON.parse(readFileSync(join(agentDir, 'code/previous.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
export function verifiedBundle(agentDir, pointer, protocol) {
  if (!acceptsLauncher(pointer?.launcherProtocol, protocol))
    throw new Error('Unsupported launcher protocol');
  if (
    typeof pointer.version !== 'string' ||
    !/^[\w.+-]+$/.test(pointer.version) ||
    ['.', '..'].includes(pointer.version) ||
    pointer.file !== `${pointer.version}/deploy.cjs`
  )
    throw new Error('Invalid bundle path');
  const root = resolve(agentDir, 'code');
  const file = resolve(root, pointer.file);
  if (!realpathSync(file).startsWith(realpathSync(root) + sep) || lstatSync(file).isSymbolicLink())
    throw new Error('Invalid bundle path');
  if (!/^[a-f0-9]{64}$/.test(pointer.sha256) || bundleDigest(readFileSync(file)) !== pointer.sha256)
    throw new Error('Bundle SHA-256 mismatch');
  privateDirectory(root);
  privateDirectory(dirname(file));
  chmodSync(file, 0o600);
  return file;
}
export function switchCodeBundle(agentDir, pointer) {
  const path = join(agentDir, 'code/current.json');
  if (pointer) atomicJson(path, pointer);
  else if (existsSync(path)) {
    rmSync(path);
    const fd = openSync(dirname(path), 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
export function installCodeBundle({
  agentDir,
  bytes,
  sha256,
  size,
  version,
  launcherProtocol,
  executableProtocol,
}) {
  if (!acceptsLauncher(launcherProtocol, executableProtocol))
    throw new Error('Unsupported launcher protocol');
  if (!/^[\w.+-]+$/.test(version) || ['.', '..'].includes(version))
    throw new Error('Invalid bundle version');
  if (bytes.length !== size || !/^[a-f0-9]{64}$/.test(sha256) || bundleDigest(bytes) !== sha256)
    throw new Error('Worker checksum or size mismatch; the installed code was kept.');
  const root = join(agentDir, 'code');
  privateDirectory(root);
  const previous = readCurrentBundle(agentDir);
  const folder = join(root, version);
  privateDirectory(folder);
  // A published version is immutable. Never overwrite the currently running bundle.
  const file = join(folder, 'deploy.cjs');
  if (existsSync(file) && bundleDigest(readFileSync(file)) !== sha256)
    throw new Error('Bundle version already contains different code');
  if (!existsSync(file)) writeFileSync(file, bytes, { mode: 0o600, flag: 'wx', flush: true });
  chmodSync(file, 0o600);
  const pointer = { version, file: `${version}/deploy.cjs`, sha256, launcherProtocol };
  verifiedBundle(agentDir, pointer, executableProtocol);
  atomicJson(join(root, 'previous.json'), previous);
  switchCodeBundle(agentDir, pointer);
  return pointer;
}
export function pruneCodeBundles(agentDir) {
  const root = join(agentDir, 'code');
  const current = readCurrentBundle(agentDir);
  let previous;
  try {
    previous = JSON.parse(readFileSync(join(root, 'previous.json'), 'utf8'));
  } catch {}
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && ![current?.version, previous?.version].includes(entry.name))
      rmSync(join(root, entry.name), { recursive: true });
  }
}
