import { repositoryFolderName } from '../../shared/repository-address.ts';
import { posix } from 'node:path';
import { list } from '../workspace/store.ts';
import { repositoryGit } from '../workspace/repository-git.ts';
import { repositoryWebURL, repositoryClonePath } from '../workspace/repositories.ts';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import type { LockfileIndex } from './lockfiles.ts';
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
export async function usedBy(owner: string, name: string, cache = usageCache) {
  const result: { id: string; name: string; versions: string[]; sameRepository: boolean }[] = [];
  for (const project of list('project', owner)) {
    if (!project.repositoryPath) continue;
    let commit: string;
    try {
      commit = (
        await repositoryGit(project.repositoryPath, ['rev-parse', 'refs/heads/main'], {
          limit: 1024,
          timeout: 5000,
        })
      )
        .toString()
        .trim();
    } catch {
      continue;
    }
    const found = new Set<string>();
    let sameRepository = false;
    for (const file of ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock']) {
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

export function readLockfile(file: string, text: string): Promise<LockfileIndex> {
  const bundled = new URL('./package-lock-worker.js', import.meta.url);
  const worker = new Worker(
    existsSync(bundled) ? bundled : new URL('./lock-worker.ts', import.meta.url),
    { workerData: { file, text } },
  );
  return new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code) reject(new Error('Lockfile reader failed'));
    });
  });
}

/** Cache missing files too. In-flight entries are separate so LRU eviction cannot
 * start duplicate parsing workers. Commits also pin link resolution to main's snapshot. */
export class LockfileCache {
  private cached = new Map<string, LockfileIndex>();
  private pending = new Map<string, Promise<LockfileIndex>>();
  private git: typeof repositoryGit;
  private parse: typeof readLockfile;
  private capacity: number;
  constructor(git = repositoryGit, parse = readLockfile, capacity = 64) {
    this.git = git;
    this.parse = parse;
    this.capacity = capacity;
  }
  async read(repository: string, commit: string, file: string): Promise<LockfileIndex> {
    const key = JSON.stringify([repository, commit, file]);
    const cached = this.cached.get(key);
    if (cached) {
      this.cached.delete(key);
      this.cached.set(key, cached);
      return cached;
    }
    if (this.pending.has(key)) return this.pending.get(key)!;
    const work = (async () => {
      let text: string;
      try {
        text = (
          await this.git(repository, ['show', `${commit}:${file}`], {
            limit: 10 * 1024 * 1024,
            timeout: 5000,
          })
        ).toString();
      } catch {
        return Object.create(null) as LockfileIndex;
      }
      return this.parse(file, text);
    })()
      .then((index) => {
        this.cached.set(key, index);
        if (this.cached.size > this.capacity) this.cached.delete(this.cached.keys().next().value!);
        return index;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }
}
const usageCache = new LockfileCache();
