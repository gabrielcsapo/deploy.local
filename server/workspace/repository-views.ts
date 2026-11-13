import { resolve } from 'node:path';
import { immutable, materialized } from '../materialized.ts';
import {
  noticeRepositoryChange,
  onRepositoryChange,
  repositoryChanged,
  repositoryIdentity,
} from '../git-changes.ts';
import { gitRead, gitText, repositoryGit } from '../git.ts';
import { db, get, onRecordChange } from './store.ts';
import { keyedSlots } from './repository-lock.ts';

// External pushes, ref deletions and agent workspace edits can be stale for at most two seconds.
export const REPOSITORY_VIEW_CADENCE_MS = 2_000;
export const IMMUTABLE_GIT_MAX_ENTRIES = 512;
export const IMMUTABLE_GIT_MAX_BYTES = 32 * 1024 * 1024;

/** Presentation only. Transactions always compute directly, including cache hits. */
export function repositoryView<V>(
  compute: (key: string) => V,
  cadenceMs = REPOSITORY_VIEW_CADENCE_MS,
  repositoryOf = (key: string): string => JSON.parse(key)[0],
  bounds: { maxWeight?: number; weigh?: (value: Awaited<V>) => number } = {},
) {
  const view = materialized(compute, { cadenceMs, cadenceFromStart: true, ...bounds });
  let watching = false;
  function observeRepository() {
    if (watching) return;
    watching = true;
    onRepositoryChange((repo) =>
      view.invalidateWhere((key) => repositoryIdentity(repositoryOf(key)) === repo),
    );
  }
  return {
    ...view,
    read: (key: string): V => {
      if (db.inTransaction) return compute(key);
      observeRecords();
      observeRepository();
      // A push or sync by another process shows at once: the cadence is only the fallback.
      noticeRepositoryChange(repositoryOf(key));
      return view.read(key);
    },
  };
}

export const repositoryRefs = repositoryView(
  async (repo: string) => {
    // One snapshot for all branches, tags and HEAD. Git handles packed refs and worktrees.
    const [raw, symbolicHead] = await Promise.all([
      gitText(repo, [
        'for-each-ref',
        '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(committerdate:iso-strict)%00%(committername)%00%(refname:short)',
        'refs/heads',
        'refs/tags',
        'refs/remotes/upstream',
      ]),
      gitRead(repo, ['symbolic-ref', '--short', 'HEAD']),
    ]);
    const refs = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, oid, peeled, updatedAt, by, shortName] = line.split('\0');
        return { name, oid, peeled, updatedAt, by, shortName };
      });
    const head =
      refs.find((ref) => ref.name === `refs/heads/${symbolicHead}`)?.oid ??
      (await gitRead(repo, ['rev-parse', '--verify', 'HEAD']));
    return {
      refs,
      head,
      symbolicHead,
      text: refs.map(({ name, oid }) => `${name}\0${oid}`).join('\n'),
    };
  },
  REPOSITORY_VIEW_CADENCE_MS,
  (repo) => repo,
);

const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const resolved = repositoryView((key: string) => {
  const [repo, ref] = JSON.parse(key);
  return gitText(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).then(
    (commit) => ({ commit, error: undefined }),
    (error: Error) => ({ commit: undefined, error }),
  );
});
export async function presentationCommit(repo: string, ref: string): Promise<string> {
  if (db.inTransaction)
    return gitText(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  if (commitPattern.test(ref)) return ref;
  const snapshot = await repositoryRefs.read(resolve(repo));
  if (ref === 'HEAD' && snapshot.head) return snapshot.head;
  const found = snapshot.refs.find((entry) => entry.name === ref && ref.startsWith('refs/heads/'));
  if (found) return found.peeled || found.oid;
  // Expressions, abbreviated hashes and missing refs retain Git's exact resolution/error contract.
  const result = await resolved.read(JSON.stringify([resolve(repo), ref]));
  if (result.error) throw result.error;
  return result.commit!;
}

type TextOptions = Pick<
  NonNullable<Parameters<typeof gitText>[2]>,
  'limit' | 'timeout' | 'allowStatus'
>;
// Only call with full object IDs. Keys include limits and all flags: callers retain their contracts.
// Cold boards still share a process limit; a canvas must not spawn hundreds of reads at once.
const readSlots = keyedSlots(32);
const immutableObjects = immutable(
  (key: string) => {
    const [repo, args, options] = JSON.parse(key);
    return readSlots(repo, () => repositoryGit(repo, args, options ?? undefined));
  },
  IMMUTABLE_GIT_MAX_ENTRIES,
  { maxWeight: IMMUTABLE_GIT_MAX_BYTES, weigh: (bytes) => bytes.length },
);
/** Return a copy: a caller cannot mutate the immutable buffer shared by other requests. */
export async function commitBytes(repo: string, args: string[], options?: TextOptions) {
  if (db.inTransaction) return repositoryGit(repo, args, options ?? undefined);
  return Buffer.from(await immutableObjects.read(JSON.stringify([resolve(repo), args, options])));
}
export async function commitText(
  repo: string,
  args: string[],
  options?: TextOptions,
  trimEnd = true,
) {
  const bytes = db.inTransaction
    ? await repositoryGit(repo, args, options ?? undefined)
    : await immutableObjects.read(JSON.stringify([resolve(repo), args, options]));
  const text = bytes.toString();
  return trimEnd ? text.trimEnd() : text;
}
// Missing files and transient errors retry within the cadence, never live in the immutable cache.
const optionalText = repositoryView(
  async (key: string) => {
    const [repo, args, options, trimEnd] = JSON.parse(key);
    return commitText(repo, args, options, trimEnd).catch(() => null);
  },
  REPOSITORY_VIEW_CADENCE_MS,
  (key) => JSON.parse(key)[0],
  {
    maxWeight: IMMUTABLE_GIT_MAX_BYTES,
    weigh: (text) => (text === null ? 1 : Buffer.byteLength(text)),
  },
);
export function optionalCommitText(
  repo: string,
  args: string[],
  options: TextOptions = { limit: 4 * 1024 * 1024 },
  trimEnd = true,
) {
  return optionalText.read(JSON.stringify([resolve(repo), args, options, trimEnd]));
}

// These are API-side records. External writers are bounded by the cadence above. Notifications
// include sync completion, project replacement/removal, coordinator writes and design landings.
let observing = false;
function observeRecords() {
  if (observing) return;
  observing = true;
  onRecordChange(
    [
      'project',
      'repository-operation',
      'pipeline-trigger-request',
      'pipeline-ref',
      'design-review-landing',
      'task',
      'checkpoint',
    ],
    (owner, kind, row, previous) => {
      for (const value of [row, previous]) {
        if (!value) continue;
        if (kind === 'project') {
          if (value.repositoryPath) repositoryChanged(value.repositoryPath);
        } else {
          try {
            const projectId =
              value.projectId ??
              (kind === 'design-review-landing'
                ? get('v2-inbox-native', owner, value.id).context?.projectId
                : undefined);
            if (!projectId) continue;
            const project = get('project', owner, projectId);
            if (project.repositoryPath) repositoryChanged(project.repositoryPath);
          } catch {
            /* Removed project or review. */
          }
        }
      }
    },
  );
}
