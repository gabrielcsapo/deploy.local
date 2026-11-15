import { execFile } from 'node:child_process';
import { cp, lstat } from 'node:fs/promises';
import { promisify } from 'node:util';

/**
 * Copy an app's data for Verify, a backup or a restore. Where the filesystem can
 * clone (APFS, Btrfs, XFS) the copy shares blocks with the original until either
 * side writes, so a library of hundreds of gigabytes copies in seconds and takes
 * no extra space. Node can't clone on macOS, so the system cp does the work; it
 * falls back to a plain copy wherever cloning isn't available.
 */
export async function copyAppData(from: string, to: string, platform = process.platform) {
  // cp -R into an existing directory nests the copy inside it instead of failing.
  if (
    await lstat(to).then(
      () => true,
      () => false,
    )
  )
    throw new Error(`Release data copy already exists: ${to}`);
  const args = cloneArgs(platform, from, to);
  if (args) await promisify(execFile)('cp', args);
  // Without verbatimSymlinks, Node turns relative links into absolute ones that
  // point back into the original, so the copy could write to live data.
  else
    await cp(from, to, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
}

export function cloneArgs(platform: string, from: string, to: string): string[] | null {
  // Both keep symlinks exactly as written and keep file modes.
  if (platform === 'darwin') return ['-c', '-R', '-p', from, to];
  if (platform === 'linux') return ['-R', '--reflink=auto', '--preserve=mode,timestamps', from, to];
  return null;
}
