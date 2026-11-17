import { usageCache } from './project-index.ts';
export { LockfileCache, readLockfile, usageCache } from './project-index.ts';
import { repositoryFolderName } from '../../shared/repository-address.ts';
import { posix } from 'node:path';
import { list } from '../workspace/store.ts';
import { repositoryGit } from '../workspace/repository-git.ts';
import { repositoryWebURL, repositoryClonePath } from '../workspace/repositories.ts';
export { lockfileVersions } from './lockfiles.ts';

export async function packageProject(owner: string, repository: unknown): Promise<string | null> {
  const input = typeof repository === 'string' ? repository : (repository as any)?.url;
  if (typeof input !== 'string') return null;
  let url: URL;
  try {
    url = new URL(
      input.replace(/^git\+/, '').replace(/^git@deploy\.local:/, 'ssh://git@deploy.local/'),
    );
  } catch {
    return null;
  }
  if (url.hostname !== 'deploy.local') return null;
  const matches = list('project', owner).filter((p) =>
    [
      new URL(repositoryWebURL(owner, p)).pathname,
      repositoryClonePath(owner, p),
      '/' + repositoryFolderName(p.name) + '.git',
      // The address `git remote get-url origin` gives for a hosted repository.
      '/api/git/' + p.id,
      '/api/git/' + p.id + '.git',
    ].includes(url.pathname),
  );
  return matches.length === 1 ? matches[0].id : null;
}
/** The commit each project's default branch is on. One Git call per project, made at
 * the same time, so a page listing many packages asks once instead of once per package. */
export async function projectHeads(owner: string) {
  const heads = await Promise.all(
    list('project', owner)
      .filter((project) => project.repositoryPath)
      .map(async (project) => {
        try {
          const commit = (
            await repositoryGit(
              project.repositoryPath,
              ['rev-parse', `refs/heads/${project.defaultBranch || 'main'}`],
              { limit: 1024, timeout: 5000 },
            )
          )
            .toString()
            .trim();
          return { project, commit };
        } catch {
          return null;
        }
      }),
  );
  return heads.filter((head) => head !== null);
}
/** Read only the default branch. No warming, pins, or Ready-state inference in this slice. */
export async function usedBy(
  owner: string,
  name: string,
  cache = usageCache,
  ecosystem = 'npm',
  heads?: Awaited<ReturnType<typeof projectHeads>>,
) {
  const result: {
    id: string;
    name: string;
    versions: string[];
    sameRepository: boolean;
  }[] = [];
  for (const { project, commit } of heads ?? (await projectHeads(owner))) {
    const found = new Set<string>();
    let sameRepository = false;
    for (const file of ecosystem === 'cargo'
      ? ['Cargo.lock']
      : ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock']) {
      const index = await cache.read(project.repositoryPath, commit, file);
      const parsed = Object.hasOwn(index, name) ? index[name] : { versions: [], links: [] };
      for (const version of parsed.versions) found.add(version);
      for (const link of parsed.links) {
        const path = posix.normalize(link + '/package.json');
        if (path.startsWith('/') || path.split('/').includes('..') || path.includes('\\')) continue;
        try {
          const manifest = JSON.parse(
            (
              await repositoryGit(project.repositoryPath, ['show', commit + ':' + path], {
                limit: 65536,
                timeout: 5000,
              })
            ).toString(),
          );
          if (manifest.name === name && typeof manifest.version === 'string') {
            found.add(manifest.version);
            sameRepository = true;
          }
        } catch {
          /* Broken links are not usage claims. */
        }
      }
    }
    if (found.size)
      result.push({
        id: project.id,
        name: project.name,
        versions: [...found].sort(),
        sameRepository,
      });
  }
  return result;
}
