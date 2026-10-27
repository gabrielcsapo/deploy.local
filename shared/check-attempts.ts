/**
 * Repeated runs of the same check are attempts, not separate results: an agent that fixes a
 * failure reruns the command, and a pull request must read as the state of the work, not as a
 * log of everything that was tried. Grouping keeps the latest attempt per check and collapses
 * the earlier ones under it.
 */
export type CheckAttempts<T> = {
  /** The grouping key: a check's label, its command, or the commit a pipeline ran on. */
  key: string;
  /** The newest attempt; the only one that describes where the check stands now. */
  latest: T;
  /** Earlier attempts of the same check, newest first. */
  earlier: T[];
};

const time = (value: unknown) => {
  const parsed = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Group attempts by `key`, newest last within each group. Records without a usable timestamp
 * keep the order they were given, which for the record store is the order they were created.
 * Groups come back in the order their check first appeared.
 */
export function checkAttempts<T>(
  rows: readonly T[],
  key: (row: T) => string,
  at: (row: T) => unknown = (row: any) => row?.updatedAt ?? row?.createdAt,
): CheckAttempts<T>[] {
  const ordered = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => time(at(a.row)) - time(at(b.row)) || a.index - b.index);
  const groups = new Map<string, T[]>();
  for (const { row } of ordered) {
    const id = key(row);
    groups.set(id, [...(groups.get(id) ?? []), row]);
  }
  return [...groups].map(([id, attempts]) => ({
    key: id,
    latest: attempts.at(-1)!,
    earlier: attempts.slice(0, -1).reverse(),
  }));
}

/** How a collapsed group of earlier attempts reads next to its latest result. */
export function earlierAttemptsLabel(count: number): string {
  return count > 0 ? `${count} earlier attempt${count === 1 ? '' : 's'}` : '';
}

/**
 * Checks belong to the change that is published, not to the task that produced it. Agents name
 * each attempt differently ("Verify the queue flows", then "Browser-test queued runs"), so
 * grouping by name alone still lets a run from before the last edit speak for the published
 * change. Partitioning by the state each run ran against is what keeps it honest.
 */
export type CheckRuns<T> = {
  /** Runs that ran against the published head, one group per check, retries collapsed. */
  current: CheckAttempts<T>[];
  /** Runs that ran against an earlier state, newest first. They never count towards status. */
  earlier: T[];
};

/**
 * Split recorded runs into the ones that ran against the published head and the ones that ran
 * before it. `onHead` answers that from what the run recorded, so a run whose state is unknown
 * is earlier rather than current: a pull request may not claim a result it cannot place.
 */
export function checkRuns<T>(
  rows: readonly T[],
  key: (row: T) => string,
  onHead: (row: T) => boolean,
  at: (row: T) => unknown = (row: any) => row?.updatedAt ?? row?.createdAt,
): CheckRuns<T> {
  const current = rows.filter((row) => onHead(row));
  const earlier = checkAttempts(
    rows.filter((row) => !onHead(row)),
    () => 'all',
    at,
  );
  return {
    current: checkAttempts(current, key, at),
    // One group over everything keeps the store's ordering work in one place; its newest
    // attempt leads the list the clients collapse.
    earlier: earlier.length ? [earlier[0].latest, ...earlier[0].earlier] : [],
  };
}

/** How the collapsed runs from before the last edit are introduced. */
export function earlierRunsLabel(count: number): string {
  return `Earlier runs (${count})`;
}

/** What a surface says when nothing was run against the change being published. */
export const noHeadChecksMessage = 'No checks ran on this version';
