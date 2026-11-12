import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gitString } from '../git.ts';

/** A project with years of history and design renders takes minutes to copy over a slow link. */
export const CLONE_TIMEOUT_MS = 15 * 60_000;

/** A folder left by a copy that failed has no repository in it and must be copied again. */
export function needsClone(path: string) {
  return !existsSync(join(path, '.git'));
}

/**
 * Copy a project's repository into a task's folder without blocking the worker, which goes on
 * answering the coordinator. A failed copy leaves no folder behind, so the next try starts clean.
 */
export async function cloneTaskRepository(
  path: string,
  url: string,
  options: {
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    run?: (cwd: string, args: string[], timeout: number) => Promise<unknown>;
  } = {},
) {
  const timeout = options.timeout ?? CLONE_TIMEOUT_MS;
  const run =
    options.run ??
    ((cwd, args, limit) =>
      gitString(cwd, args, { timeout: limit, maxBuffer: 1024 * 1024, env: options.env }));
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  const started = Date.now();
  try {
    await run(path, ['clone', url, '.'], timeout);
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    if (Date.now() - started >= timeout)
      throw new Error(
        `Copying the repository took longer than ${Math.round(timeout / 60_000)} minutes`,
      );
    // Git prints "Cloning into '.'..." before the reason; the last line is the reason.
    const reason = String((error as Error).message || '')
      .trim()
      .split('\n')
      .filter((line) => !/^Cloning into /.test(line))
      .at(-1);
    throw new Error(`Could not copy the repository${reason ? `: ${reason}` : ''}`);
  }
}
