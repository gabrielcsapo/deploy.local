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
