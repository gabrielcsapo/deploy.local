import { repositoryFolderName } from '../../shared/repository-address.ts';
import { posix } from 'node:path';
import { list } from '../workspace/store.ts';
import { repositoryGit } from '../workspace/repository-git.ts';
import { repositoryWebURL, repositoryClonePath } from '../workspace/repositories.ts';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
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
    ].includes(url.pathname),
  );
  return matches.length === 1 ? matches[0].id : null;
}
/** Read only main. No warming, pins, or Ready-state inference in this slice. */
export async function usedBy(owner: string, name: string) {
  const result: { id: string; name: string; versions: string[]; sameRepository: boolean }[] = [];
  for (const project of list('project', owner)) {
    if (!project.repositoryPath) continue;
    const found = new Set<string>();
    let sameRepository = false;
    for (const file of ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock']) {
      let text: string;
      try {
        text = (
          await repositoryGit(project.repositoryPath, ['show', `refs/heads/main:${file}`], {
            limit: 10 * 1024 * 1024,
            timeout: 5000,
          })
        ).toString();
      } catch {
        continue;
      }
      const parsed = await readLockfile(file, text, name);
      for (const version of parsed.versions) found.add(version);
      for (const link of parsed.links) {
        const path = posix.normalize(link + '/package.json');
        if (path.startsWith('/') || path.split('/').includes('..') || path.includes('\\')) continue;
        try {
          const manifest = JSON.parse(
            (
              await repositoryGit(project.repositoryPath, ['show', 'refs/heads/main:' + path], {
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

function readLockfile(
  file: string,
  text: string,
  name: string,
): Promise<{ versions: string[]; links: string[] }> {
  const bundled = new URL('./package-lock-worker.js', import.meta.url);
  const worker = new Worker(
    existsSync(bundled) ? bundled : new URL('./lock-worker.ts', import.meta.url),
    { workerData: { file, text, name } },
  );
  return new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code) reject(new Error('Lockfile reader failed'));
    });
  });
}
