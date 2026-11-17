import { packageWorkerFile } from '../kernel/files/worker-file.ts';
import { repositoryGit } from '../workspace/repository-git.ts';
import { Worker } from 'node:worker_threads';
import type { LockfileIndex } from './lockfiles.ts';
export function readLockfile(file: string, text: string): Promise<LockfileIndex> {
  const worker = new Worker(
    packageWorkerFile(import.meta.url, 'package-lock-worker.js', './lock-worker.ts'),
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
  // Each project takes one entry per lockfile name it is asked about (four for npm, one for
  // Cargo), most of them empty. At 64, a server with more than 12 projects pushed its own
  // entries out on every read and parsed every lockfile again for each page.
  constructor(git = repositoryGit, parse = readLockfile, capacity = 512) {
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
      } catch (error) {
        // A missing lockfile is normal. Timeouts, unreadable repositories and oversized
        // responses must retain the previous snapshot and pins instead of clearing them.
        if (/path .* (?:does not exist in|exists on disk, but not in)/.test(String(error)))
          return Object.create(null) as LockfileIndex;
        throw error;
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
export const usageCache = new LockfileCache();
