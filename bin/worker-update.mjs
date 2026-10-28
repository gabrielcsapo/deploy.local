import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  chmodSync,
  existsSync,
  linkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Verify before executing, and keep the old inode until the replacement passes its probe. */
export function installWorkerBuild({
  path,
  bytes,
  sha256,
  size,
  version,
  platform = process.platform,
  probe = probeWorker,
}) {
  if (
    !/^[a-f0-9]{64}$/.test(sha256) ||
    createHash('sha256').update(bytes).digest('hex') !== sha256 ||
    bytes.length !== size
  )
    throw new Error('Worker checksum or size mismatch; the installed build was kept.');
  if (!['darwin', 'linux'].includes(platform))
    throw new Error('Windows computers use the desktop app.');
  const syncDirectory = () => {
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  };
  const staged = `${path}.stage-${process.pid}`;
  const previous = `${path}.previous`;
  let swapped = false;
  const hadPrevious = existsSync(path);
  try {
    writeFileSync(staged, bytes, { mode: 0o700, flag: 'wx', flush: true });
    chmodSync(staged, 0o755);
    if (platform === 'darwin') {
      const signed = spawnSync('codesign', ['--sign', '-', '--force', staged], {
        encoding: 'utf8',
      });
      if (signed.status !== 0)
        throw new Error('Unable to sign the worker build; the installed build was kept.');
    }
    probe(staged, version);
    if (hadPrevious) {
      rmSync(previous, { force: true });
      linkSync(path, previous);
      syncDirectory();
    }
    renameSync(staged, path);
    swapped = true;
    syncDirectory();
    probe(path, version);
    return { version, previous: hadPrevious ? previous : undefined };
  } catch (error) {
    if (swapped) {
      if (hadPrevious) renameSync(previous, path);
      else rmSync(path, { force: true });
      syncDirectory();
    }
    throw error;
  } finally {
    rmSync(staged, { force: true });
  }
}
function probeWorker(path, version) {
  const result = spawnSync(path, ['version', '--json'], { encoding: 'utf8', timeout: 30_000 });
  if (result.error || result.status !== 0)
    throw new Error('The worker build failed its startup check.');
  let info;
  try {
    info = JSON.parse(result.stdout);
  } catch {
    throw new Error('The worker build returned an invalid version.');
  }
  if (info.version !== version)
    throw new Error('The worker build does not match the coordinator release.');
}
export async function downloadWorkerBuild(serverUrl, path, expectedVersion) {
  const response = await fetch(`${serverUrl}/cli/version`);
  if (!response.ok) throw new Error('The coordinator worker manifest is unavailable.');
  const manifest = await response.json();
  if (expectedVersion && manifest.version !== expectedVersion)
    throw new Error('The coordinator release changed. Try again.');
  const target = manifest.targets?.[`${process.platform}-${process.arch}`];
  if (!target) throw new Error('No matching worker build is available for this computer.');
  const artifact = await fetch(
    `${serverUrl}/cli?os=${process.platform}&arch=${process.arch}&version=${encodeURIComponent(manifest.version)}`,
  );
  if (!artifact.ok) throw new Error('The coordinator worker build is unavailable.');
  return installWorkerBuild({
    path,
    bytes: Buffer.from(await artifact.arrayBuffer()),
    sha256: target.sha256,
    size: target.size,
    version: manifest.version,
  });
}
