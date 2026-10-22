export type TreeProject = { id: string; name: string };
export type TreeTask = {
  id: string;
  title: string;
  pull?: { id: string; number: number; status: string } | null;
  controlRequest?: { id: string } | null;
  projectId?: string | null;
  updatedAt?: string | null;
};

function activity(task: TreeTask): number {
  const value = Date.parse(task.updatedAt || '');
  return Number.isFinite(value) ? value : 0;
}

/** Sort before filtering so searching never changes the underlying project order. */
export function taskTree<T extends TreeTask>(
  projects: readonly TreeProject[],
  tasks: readonly T[],
  search = '',
): { id: string; name: string; tasks: T[]; count: number }[] {
  const groups = new Map(
    projects.map((project) => [project.id, { ...project, tasks: [] as T[], count: 0 }]),
  );
  const unassigned = { id: '', name: 'No project', tasks: [] as T[], count: 0 };
  for (const task of tasks) (groups.get(task.projectId || '') || unassigned).tasks.push(task);
  const sorted = [...groups.values()];
  for (const group of [...sorted, unassigned]) {
    group.tasks.sort((a, b) => activity(b) - activity(a) || a.id.localeCompare(b.id));
    group.count = group.tasks.length;
  }
  sorted.sort((a, b) => {
    if (!a.count || !b.count)
      return Number(!a.count) - Number(!b.count) || a.name.localeCompare(b.name);
    return activity(b.tasks[0]) - activity(a.tasks[0]) || a.name.localeCompare(b.name);
  });
  if (unassigned.count) sorted.push(unassigned);
  const query = search.trim().toLowerCase();
  if (!query) return sorted;
  return sorted.flatMap((group) => {
    const projectMatches = group.name.toLowerCase().includes(query);
    const matchingTasks = group.tasks.filter(
      (task) => projectMatches || task.title.toLowerCase().includes(query),
    );
    return projectMatches || matchingTasks.length ? [{ ...group, tasks: matchingTasks }] : [];
  });
}

export function taskAge(updatedAt: string | null | undefined, now = Date.now()) {
  const updated = Date.parse(updatedAt || '');
  if (!Number.isFinite(updated)) return { compact: '—', label: 'Update time unavailable' };
  const minutes = Math.max(0, Math.floor((now - updated) / 60_000));
  if (minutes < 1) return { compact: 'now', label: 'Updated just now' };
  const [amount, suffix, unit] =
    minutes < 60
      ? [minutes, 'm', 'minute']
      : minutes < 1440
        ? [Math.floor(minutes / 60), 'h', 'hour']
        : minutes < 10080
          ? [Math.floor(minutes / 1440), 'd', 'day']
          : [Math.floor(minutes / 10080), 'w', 'week'];
  return {
    compact: `${amount}${suffix}`,
    label: `Updated ${amount} ${unit}${amount === 1 ? '' : 's'} ago`,
  };
}

export function taskStatus(
  status: string,
  waitingForAnswer = false,
  pull?: { number: number; status: string } | null,
  needsApproval = false,
) {
  // An agent waiting on your permission outranks every other state.
  if (needsApproval) return { tone: 'attention' as const, label: 'Needs your approval' };
  if (pull?.status === 'open' && status !== 'merged')
    return { tone: 'active' as const, label: `In review · PR #${pull.number}` };
  if (waitingForAnswer) return { tone: 'attention' as const, label: 'Waiting for your answer' };
  if (['review', 'ready', 'waiting'].includes(status))
    return {
      tone: 'attention' as const,
      label: status === 'waiting' ? 'Waiting for your answer' : 'Ready to review',
    };
  if (['running', 'checking', 'queued'].includes(status))
    return {
      tone: 'active' as const,
      label: status === 'checking' ? 'Running checks' : status === 'queued' ? 'Queued' : 'Working',
    };
  if (status === 'failed') return { tone: 'failed' as const, label: 'Failed' };
  if (['succeeded', 'done', 'merged', 'completed'].includes(status))
    return { tone: 'healthy' as const, label: status === 'merged' ? 'Merged' : 'Done' };
  return {
    tone: 'inactive' as const,
    label: status === 'stopped' ? 'Stopped' : status || 'Inactive',
  };
}

/** Preview membership is independent of selection, so selecting a recent never moves rows. */
export function projectTaskPreview<T>(tasks: readonly T[], showAll: boolean): readonly T[] {
  return showAll ? tasks : tasks.slice(0, 5);
}

export function selectedTaskInProject<T extends TreeTask>(
  groups: readonly { id: string; tasks: T[] }[],
  selected: string,
  expanded: Readonly<Record<string, boolean>>,
  showAll: Readonly<Record<string, boolean>>,
  searching: boolean,
): boolean {
  return groups.some(
    (group) =>
      (searching || expanded[group.id] === true) &&
      projectTaskPreview(group.tasks, searching || showAll[group.id] === true).some(
        (task) => task.id === selected,
      ),
  );
}

/** No activity in the last 30 days, including projects without any recorded task date. */
export function idleProject(tasks: readonly TreeTask[], now = Date.now()): boolean {
  return !tasks.some((task) => activity(task) > now - 30 * 24 * 60 * 60 * 1000);
}
export function taskRunning(status: string): boolean {
  return ['running', 'starting', 'checking', 'queued'].includes(status);
}
export function sidebarStorageKey(prefix: string, setting: string): string {
  return `${prefix}:sidebar:${setting}`;
}
export function readPinned(storage: Pick<Storage, 'getItem'>, prefix: string): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(sidebarStorageKey(prefix, 'pinned')) || '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}
export function recentTasks<T extends TreeTask & { status: string }>(
  tasks: readonly T[],
  pinned: readonly string[],
): T[] {
  return tasks.filter(
    (task) => !pinned.includes(task.id) && !['done', 'merged'].includes(task.status),
  );
}
