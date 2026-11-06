/** Capture the cursor before loading state, so events during the load are still polled. */
export async function eventSnapshotCursor(
  latest: () => Promise<{ cursor: number }>,
  snapshot: () => Promise<boolean>,
  signal: AbortSignal,
): Promise<number> {
  const { cursor } = await latest();
  signal.throwIfAborted();
  if (!(await snapshot())) throw new Error('Snapshot unavailable');
  signal.throwIfAborted();
  return cursor;
}
