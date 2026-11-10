export function checkpointInfo(checkpoint: any) {
  return (
    checkpoint?.snapshotInfo ?? {
      digest: checkpoint?.snapshot?.digest ?? null,
      baseCommit: checkpoint?.snapshot?.base?.commit ?? null,
      fileCount: checkpoint?.snapshot?.files?.length ?? 0,
      excludedCount: checkpoint?.snapshot?.excluded?.length ?? 0,
    }
  );
}
