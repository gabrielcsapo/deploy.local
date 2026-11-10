/**
 * Size-capped rotation for the log files the service manager points stdout and stderr at
 * (systemd `append:`, launchd StandardOutPath; scripts/service.mjs). Nothing else bounds them,
 * and they sit on the data disk.
 *
 * The supervisor holds the file open and cannot reopen it, so this copies the file aside and
 * truncates it in place through the descriptor. Both service managers open the file in append
 * mode, so writing continues at the new end. A few lines written between the copy and the
 * truncate can be lost; that is the price of not restarting anything to rotate.
 *
 * Node built-ins only: the supervisor imports this and must stay tiny.
 */
import { copyFileSync, fstatSync, ftruncateSync, renameSync, rmSync, statSync } from 'node:fs';

export interface LogRotation {
  /** The open descriptor being written: 1 for stdout, 2 for stderr. */
  fd: number;
  /** Where that file is expected to live. Rotation is skipped unless the descriptor is this file. */
  path: string;
  maxBytes?: number;
  /** Older copies kept as `<path>.1` … `<path>.<keep>`. */
  keep?: number;
}

export const LOG_MAX_BYTES = 20 * 1024 * 1024;
export const LOG_KEEP = 3;

/** Rotate when the file has reached its cap. Returns whether it rotated; never throws. */
export function rotateLogIfLarge({
  fd,
  path,
  maxBytes = LOG_MAX_BYTES,
  keep = LOG_KEEP,
}: LogRotation): boolean {
  try {
    const open = fstatSync(fd);
    // A terminal, pipe or journal socket is someone else's to bound.
    if (!open.isFile() || open.size < maxBytes) return false;
    const named = statSync(path);
    if (named.ino !== open.ino || named.dev !== open.dev) return false;
    rmSync(`${path}.${keep}`, { force: true });
    for (let index = keep - 1; index >= 1; index--) {
      try {
        renameSync(`${path}.${index}`, `${path}.${index + 1}`);
      } catch {
        // no copy at this position yet
      }
    }
    copyFileSync(path, `${path}.1`);
    ftruncateSync(fd, 0);
    return true;
  } catch {
    // Rotation is housekeeping; it must never take the supervisor down.
    return false;
  }
}
