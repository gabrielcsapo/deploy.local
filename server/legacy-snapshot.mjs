import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
  fsyncSync,
} from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
const durablePaths = ['data', 'uploads', '.ssh-host-keys'];
/** Never call getVolumeDir here: its create-on-read behavior can manufacture an
 * empty replacement and make missing production data look like first install. */
function assertExistingDirectories(directory) {
  if (
    !existsSync(directory) ||
    !lstatSync(directory).isDirectory() ||
    lstatSync(directory).isSymbolicLink()
  )
    throw new Error('Existing legacy volume directory required');
  for (const path of durablePaths) {
    const target = join(directory, path);
    if (
      !existsSync(target) ||
      !lstatSync(target).isDirectory() ||
      lstatSync(target).isSymbolicLink()
    )
      throw new Error(`Missing existing durable directory: ${path}`);
  }
}

export function assertExistingLegacyData(directory) {
  assertExistingDirectories(directory);
  if (!readdirSync(join(directory, 'data')).length) throw new Error('Refusing empty legacy data');
  existingHostKeyPaths(directory);
}

// Groffee's embedded SSH server uses the key in /app/data. The separate
// /etc/ssh layout remains supported; neither path is created or relocated.
function existingHostKeyPaths(directory) {
  const dataKey = join(directory, 'data', 'ssh_host_ed25519_key');
  const separate = readdirSync(join(directory, '.ssh-host-keys'))
    .filter((name) => /^ssh_host_(ed25519|rsa|ecdsa)_key$/.test(name))
    .map((name) => join(directory, '.ssh-host-keys', name));
  const hasDataKey = readdirSync(join(directory, 'data')).includes('ssh_host_ed25519_key');
  const recognized = [...(hasDataKey ? [dataKey] : []), ...separate];
  if (!recognized.length) throw new Error('Existing SSH host identity required');
  for (const path of recognized) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.mode & 0o077)
      throw new Error('Existing SSH host identity must be a nonempty private regular file');
  }
  return recognized;
}

/** Derive only a public-identity digest in the restricted helper. Never log
 * private key bytes, public key bytes, or ssh-keygen failure output. */
export function legacyHostIdentityDigest(directory) {
  assertExistingLegacyData(directory);
  const identities = existingHostKeyPaths(directory).map((path) => {
    try {
      const publicKey = execFileSync('ssh-keygen', ['-y', '-P', '', '-f', path], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 5000,
      })
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .join(' ');
      if (
        !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/=]+$/.test(publicKey)
      )
        throw new Error('Invalid derived public identity');
      return { path, publicKey };
    } catch {
      throw new Error('Existing SSH host identity derivation failed');
    }
  });
  const dataKey = join(directory, 'data', 'ssh_host_ed25519_key');
  const active = identities.some((identity) => identity.path === dataKey)
    ? identities.filter((identity) => identity.path === dataKey)
    : identities;
  return createHash('sha256')
    .update([...new Set(active.map((identity) => identity.publicKey))].sort().join('\n'))
    .digest('hex');
}

// Hash file bytes and numeric ownership/modes without following symlinks or
// printing database, environment or key contents. Include empty directories.
function fileDigest(path) {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  const fd = openSync(path, 'r');
  try {
    let bytes;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, bytes));
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

function inventory(directory) {
  const hash = createHash('sha256');
  const visit = (entry) => {
    const path = join(directory, entry);
    const stat = lstatSync(path);
    if (!stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink())
      throw new Error(`Unsupported durable entry: ${entry}`);
    hash.update(
      JSON.stringify([
        entry,
        stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file',
        stat.uid,
        stat.gid,
        stat.mode & 0o7777,
      ]),
    );
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      const destination = relative(directory, resolve(path, '..', target));
      let namedComponent = false;
      const traversesNamedParent = target.split('/').some((component) => {
        if (component === '..') return namedComponent;
        if (component && component !== '.') namedComponent = true;
        return false;
      });
      if (
        isAbsolute(target) ||
        traversesNamedParent ||
        !durablePaths.some((root) => destination === root || destination.startsWith(root + sep))
      )
        throw new Error(`Unsupported escaping durable symlink: ${entry}`);
      hash.update(target);
    } else if (stat.isFile()) hash.update(fileDigest(path));
    else for (const name of readdirSync(path).sort()) visit(join(entry, name));
  };
  for (const path of durablePaths) visit(path);
  return hash.digest('hex');
}

/** Only after the writer is stopped. Private recovery directory is retained
 * on every outcome, and success requires a full isolated restore rehearsal. */
export function snapshotStoppedLegacyData(volumeDirectory, recoveryRoot) {
  assertExistingLegacyData(volumeDirectory);
  mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(recoveryRoot, 'legacy-update-'));
  const contentsDigest = inventory(volumeDirectory);
  const archive = join(directory, 'data.tar');
  execFileSync(
    'tar',
    ['--numeric-owner', '-cpf', archive, '-C', volumeDirectory, ...durablePaths],
    { stdio: 'pipe' },
  );
  const archiveDigest = fileDigest(archive);
  const snapshot = { directory, archiveDigest, contentsDigest };
  writeFileSync(join(directory, 'snapshot.json'), JSON.stringify(snapshot), {
    mode: 0o600,
    flag: 'wx',
  });
  verifyLegacySnapshot(snapshot);
  if (inventory(volumeDirectory) !== contentsDigest)
    throw new Error('Stopped data changed during snapshot');
  for (const file of [archive, join(directory, 'snapshot.json')]) {
    const fd = openSync(file, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  const dirFd = openSync(directory, 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  return snapshot;
}

export function verifyLegacySnapshot(snapshot) {
  const archive = join(snapshot.directory, 'data.tar');
  if (fileDigest(archive) !== snapshot.archiveDigest)
    throw new Error('Snapshot archive digest mismatch');
  const restored = mkdtempSync(join(snapshot.directory, 'verify-'));
  try {
    execFileSync('tar', ['--numeric-owner', '-xpf', archive, '-C', restored], { stdio: 'pipe' });
    assertExistingLegacyData(restored);
    if (inventory(restored) !== snapshot.contentsDigest)
      throw new Error('Snapshot restored content or ownership mismatch');
  } finally {
    rmSync(restored, { recursive: true, force: true });
  }
}

export function syncRestoredLegacyData(directory) {
  const visit = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
    const fd = openSync(path, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  for (const path of durablePaths) visit(join(directory, path));
  const rootFd = openSync(directory, 'r');
  try {
    fsyncSync(rootFd);
  } finally {
    closeSync(rootFd);
  }
}

/** All writers must still be stopped. Keep bind directory inodes stable. */
export function restoreStoppedLegacyData(volumeDirectory, snapshot) {
  verifyLegacySnapshot(snapshot); // verify BEFORE touching original data
  assertExistingDirectories(volumeDirectory);
  for (const path of durablePaths) {
    for (const entry of readdirSync(join(volumeDirectory, path)))
      rmSync(join(volumeDirectory, path, entry), { recursive: true, force: true });
  }
  execFileSync(
    'tar',
    ['--numeric-owner', '-xpf', join(snapshot.directory, 'data.tar'), '-C', volumeDirectory],
    { stdio: 'pipe' },
  );
  if (inventory(volumeDirectory) !== snapshot.contentsDigest)
    throw new Error('Rollback data verification failed; leave writers stopped');
  syncRestoredLegacyData(volumeDirectory);
}
