type Row = Record<string, any>;

export function activitySources(activity: Row[] = []): string[] {
  return [
    ...new Set<string>(
      activity.flatMap((turn) => turn.items.map((item: Row) => item.source).filter(Boolean)),
    ),
  ];
}

export function activitySummary(jobs: Row[] = [], activity: Row[] = []) {
  const sources = activitySources(activity).length;
  const running = jobs.filter((job) => job.status === 'running').length;
  return {
    visible: jobs.length > 0 || sources > 0,
    running,
    label: `Activity: ${jobs.length} processes, ${running} running, ${sources} sources`,
    text: `${jobs.length} processes · ${running} running · ${sources} sources`,
  };
}

export function orderedJobs<T extends Row>(jobs: T[]): T[] {
  return [...jobs].sort(
    (a, b) =>
      Number(b.status === 'running') - Number(a.status === 'running') ||
      String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) ||
      String(a.id).localeCompare(String(b.id)),
  );
}
