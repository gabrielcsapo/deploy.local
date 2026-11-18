import type { RepositoryCommit } from '../projects/code';
import type { parsePatch } from './api';
import type { TaskDiff, TaskPull } from './types';

/** A pull request's commit as its diff read returns it: merges of the target are marked. */
export type PullCommit = RepositoryCommit & { parents?: string[]; mergesTarget?: boolean };
export type PatchFile = ReturnType<typeof parsePatch>[number];
export type MergeOperation = {
  status: string;
  error?: string | null;
  baseCommit?: string;
  headCommit?: string;
};

/**
 * Commits that merge the target branch into the source say nothing about the change, so they
 * fold into one line ("2 merges from main") after the commits that do.
 */
export function foldMerges(commits: PullCommit[]) {
  const merges = commits.filter((commit) => commit.mergesTarget);
  return {
    commits: commits.filter((commit) => !commit.mergesTarget),
    merges,
    latest: merges.reduce<string | undefined>(
      (latest, commit) => (!latest || commit.date > latest ? commit.date : latest),
      undefined,
    ),
  };
}
export const mergesLabel = (count: number, target: string) =>
  `${count} ${count === 1 ? 'merge' : 'merges'} from ${target}`;

/** The decision under a pull request's title: what stands in the way, then what to do. */
export type PullDecision = {
  kind:
    | 'ready'
    | 'conflicts'
    | 'checks-running'
    | 'checks-failed'
    | 'no-changes'
    | 'merging'
    | 'merge-failed'
    | 'closed'
    | 'blocked';
  title: string;
  line?: string;
  /** The checks that failed, which the line names and links to their run. */
  failed?: { id: string; name: string }[];
  runId?: string | null;
  /** Actions in order; the last one listed in `primary` is the page's one primary action. */
  actions: ('close' | 'merge' | 'update-in-task' | 'fix-in-task' | 'retry-merge' | 'reopen')[];
  primary?: 'close' | 'merge' | 'update-in-task' | 'fix-in-task' | 'retry-merge';
  /** Merge shows but waits, as while checks run. */
  mergeDisabled?: boolean;
};
export type DecisionDiff = Pick<
  TaskDiff,
  'mergeable' | 'mergeBlock' | 'baseCommit' | 'headCommit'
> & {
  mergeBlockKind?: 'status' | 'no-changes' | 'conflicts' | 'checks' | null;
  conflictSummary?: string | null;
  requiredChecks?: {
    commit: string;
    runId: string | null;
    status: string | null;
    done: number;
    total: number;
    failed: { id: string; name: string }[];
  } | null;
};

export function pullDecision(
  pull: Pick<
    TaskPull,
    'status' | 'targetBranch' | 'closedBy' | 'closedByName' | 'closedAt' | 'checkCount'
  >,
  diff: DecisionDiff | null | undefined,
  operation: MergeOperation | null | undefined,
  { merging = false, time = (value?: string) => value || '' } = {},
): PullDecision | null {
  const target = pull.targetBranch;
  if (pull.status === 'merged') return null;
  if (pull.status === 'closed') {
    const who = pull.closedByName || pull.closedBy;
    const when = pull.closedAt ? ` ${time(pull.closedAt)}` : '';
    return {
      kind: 'closed',
      title: 'Closed',
      line: who ? `${who} closed this pull request${when}.` : `Closed${when}.`,
      actions: ['reopen'],
    };
  }
  if (merging || ['queued', 'running'].includes(operation?.status || ''))
    return { kind: 'merging', title: `Merging into ${target}…`, actions: [] };
  if (!diff) return null;
  // A merge that failed for this exact version stays the decision until it is retried; once
  // either branch moves, the page judges the new version instead.
  if (
    operation &&
    ['failed', 'unknown'].includes(operation.status) &&
    operation.baseCommit === diff.baseCommit &&
    operation.headCommit === diff.headCommit
  )
    return {
      kind: 'merge-failed',
      title: 'Merge failed',
      line: operation.error || 'The merge stopped before it finished.',
      actions: ['close', 'retry-merge'],
      primary: 'retry-merge',
    };
  if (diff.mergeable)
    return {
      kind: 'ready',
      title: 'Ready to merge',
      line: pull.checkCount
        ? `Checks passed, no conflicts with ${target}`
        : `No conflicts with ${target}`,
      actions: ['close', 'merge'],
      primary: 'merge',
    };
  const short = diff.headCommit?.slice(0, 7) || '';
  switch (diff.mergeBlockKind) {
    case 'no-changes':
      return {
        kind: 'no-changes',
        title: 'Nothing to merge',
        line: diff.mergeBlock || undefined,
        actions: ['close'],
        primary: 'close',
      };
    case 'conflicts':
      return {
        kind: 'conflicts',
        title: `Conflicts with ${target}`,
        line: diff.conflictSummary || diff.mergeBlock || undefined,
        actions: ['close', 'update-in-task'],
        primary: 'update-in-task',
      };
    case 'checks': {
      const checks = diff.requiredChecks;
      if (checks?.failed.length)
        return {
          kind: 'checks-failed',
          title: 'Checks failed',
          line: `Required pipeline checks have not passed for ${short}: ${listed(checks.failed.map((check) => check.name))} failed.`,
          failed: checks.failed,
          runId: checks.runId,
          actions: ['close', 'fix-in-task'],
          primary: 'fix-in-task',
        };
      return {
        kind: 'checks-running',
        title: 'Checks running',
        line: checks?.total
          ? `Required pipeline checks have not passed for ${short} yet: ${checks.done} of ${checks.total} done.`
          : `Required pipeline checks have not passed for ${short} yet.`,
        runId: checks?.runId,
        actions: ['close', 'merge'],
        primary: 'merge',
        mergeDisabled: true,
      };
    }
    default:
      return {
        kind: 'blocked',
        title: 'Cannot merge',
        line: diff.mergeBlock || undefined,
        actions: ['close'],
      };
  }
}

/** "a", "a and b", "a, b and c". */
export function listed(names: string[]) {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] || '';
}

/** The first message of a task started from a pull request's decision. */
export function pullTaskMessage(
  pull: Pick<TaskPull, 'number' | 'title' | 'sourceBranch' | 'targetBranch'>,
  action: 'update-in-task' | 'fix-in-task',
  detail: { conflicts?: string[]; failed?: string[]; commit?: string; run?: string } = {},
) {
  const which = `pull request #${pull.number} (“${pull.title}”)`;
  if (action === 'update-in-task')
    return `Merge ${pull.targetBranch} into ${pull.sourceBranch} and resolve the conflicts${
      detail.conflicts?.length ? ` in ${listed(detail.conflicts)}` : ''
    }, so ${which} can merge.`;
  return `The ${listed(detail.failed || [])} ${detail.failed?.length === 1 ? 'check' : 'checks'} failed on ${pull.sourceBranch}${
    detail.commit ? ` at ${detail.commit.slice(0, 7)}` : ''
  }, so ${which} cannot merge. Find out why and fix it.${detail.run ? ` The failed run is at ${detail.run}` : ''}`;
}

/** The first words of a task the ⋯ menu starts, so the owner sees what it is about. */
export function pullTaskAsk(pull: Pick<TaskPull, 'number' | 'title' | 'status' | 'sourceBranch'>) {
  return pull.status === 'open'
    ? `On ${pull.sourceBranch}, the branch of pull request #${pull.number} (“${pull.title}”): `
    : `A follow-up to pull request #${pull.number} (“${pull.title}”): `;
}

export const FILES_SHOWN = 8;
const imagePattern = /\.(png|jpe?g|gif|webp)$/i;
export const isImage = (path: string) => imagePattern.test(path);
/** Whether a patch's file was added, deleted or changed, from its Git header lines. */
export function fileChange(file: Pick<PatchFile, 'lines'>) {
  if (file.lines.some((line) => !line.kind && line.text.startsWith('new file mode')))
    return 'added';
  if (file.lines.some((line) => !line.kind && line.text.startsWith('deleted file mode')))
    return 'deleted';
  return 'changed';
}
/** Files whose path contains the filter, ignoring case; an empty filter keeps them all. */
export function filterFiles<T extends { file: string }>(files: T[], query: string) {
  const words = query.trim().toLowerCase();
  return words ? files.filter((file) => file.file.toLowerCase().includes(words)) : files;
}
/** The Files changed heading's count: "68", or "4 of 68" while a filter narrows it. */
export const filesCount = (shown: number, total: number, filtering: boolean) =>
  filtering ? `${shown} of ${total}` : String(total);
