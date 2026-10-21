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
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  // Only what is there: "3 processes · 1 running · 1 source", never "0 running".
  const parts = [
    jobs.length ? count(jobs.length, 'process', 'processes') : '',
    running ? `${running} running` : '',
    sources ? count(sources, 'source', 'sources') : '',
  ].filter(Boolean);
  return {
    visible: jobs.length > 0 || sources > 0,
    running,
    label: `Activity: ${parts.join(', ')}`,
    text: parts.join(' · '),
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
