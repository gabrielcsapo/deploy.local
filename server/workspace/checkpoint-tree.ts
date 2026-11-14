import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repositoryGit } from './repository-git.ts';

type TreeOptions = {
  signal?: AbortSignal;
  timeout?: number;
  authentication?: { origin: string; header: string };
};
/** Where a worker can fetch a checkpoint's base commit: the coordinator pins each base under
 * its own ref, so a worker never has to ask for a bare object ID. */
export type CheckpointBase = { commit: string; ref: string; location: string };

/** Writes `commit`'s tree into an existing directory, using a repository this computer has.
 * Git writes modes and symlinks exactly as recorded; the delta is applied on top. */
export async function extractBaseTree(
  repository: string,
  commit: string,
  destination: string,
  options: TreeOptions = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'deploy-base-'));
  const git = {
    ...options,
    timeout: options.timeout ?? 600000,
    indexFile: join(directory, 'index'),
  };
  try {
    // Snapshot validation already proved the commit is a plain object ID, never an option.
    await repositoryGit(repository, ['read-tree', commit], git);
    // The hosted repository is bare, so the destination is supplied as the work tree.
    await repositoryGit(
      repository,
      [`--work-tree=${destination}`, 'checkout-index', '--all', '--force'],
      git,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Fetches a checkpoint's base commit through its pinned ref, then writes its tree out.
 * Workers already read assigned repositories over /api/git with their token. */
export async function fetchBaseTree(
  base: CheckpointBase,
  destination: string,
  options: TreeOptions = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'deploy-base-repository-'));
  const git = { ...options, timeout: options.timeout ?? 600000 };
  try {
    await repositoryGit(directory, ['init', '--template=', '--bare', '--quiet'], git);
    await repositoryGit(
      directory,
      ['fetch', '--depth=1', '--no-tags', '--', base.location, `+${base.ref}:refs/deploy/base`],
      git,
    );
    const fetched = (await repositoryGit(directory, ['rev-parse', 'refs/deploy/base'], git))
      .toString()
      .trim();
    if (fetched !== base.commit)
      throw new Error('The checkpoint base commit changed; ask the agent to capture a new one');
    await extractBaseTree(directory, base.commit, destination, git);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
