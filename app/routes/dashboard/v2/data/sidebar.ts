export type SidebarTask = {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  projectId?: string | null;
};
export type SidebarProject = { id: string; name: string };
export type SidebarRun = { taskId: string; status: string; updatedAt?: string; createdAt: string };
export type WorkspaceState = {
  tasks: SidebarTask[];
  runs: SidebarRun[];
  projects?: SidebarProject[];
};
export type SidebarAgent = Pick<
  import('../../../../../shared/v2/contracts').AgentConfiguration,
  'id' | 'name' | 'avatar' | 'lastMessage'
>;
export type LiveSummary = { running: number; failing: number };

export async function readResource<T>(
  request: typeof fetch,
  path: string,
  signal: AbortSignal,
  optional = false,
): Promise<T | null> {
  const response = await request(path, { signal });
  if (optional && response.status === 404) return null;
  if (!response.ok) throw new Error('Unavailable');
  return response.json();
}

export function taskState(task: SidebarTask, runs: SidebarRun[]) {
  const run = runs
    .filter((entry) => entry.taskId === task.id)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const status = run?.status || task.status;
  if (['unknown', 'blocked', 'failed', 'interrupted', 'stalled'].includes(status)) return 'stalled';
  if (['running', 'starting'].includes(status)) return 'running';
  if (['succeeded', 'review', 'ready', 'completed'].includes(status)) return 'ready';
  return 'idle';
}

/**
 * Whether the task's latest turn is still queued or working. It cannot be deleted then, so its
 * Delete task… item is left out; the server refuses too.
 */
export function taskWorking(task: Pick<SidebarTask, 'id'>, runs: SidebarRun[]) {
  const run = runs
    .filter((entry) => entry.taskId === task.id)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  return workingStatus(run?.status);
}
export const workingStatus = (status?: string) =>
  ['queued', 'starting', 'running', 'unknown'].includes(status ?? '');

export function dayLabel(at: string, now = new Date()) {
  const date = new Date(at);
  if (date.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return 'Earlier';
}

export function relativeTime(at: string, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60000));
  if (!Number.isFinite(minutes)) return '';
  return minutes < 1
    ? 'now'
    : minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / 1440)}d`;
}

/** Tasks shown under a project before "Show N more". */
export const PROJECT_TASKS_SHOWN = 5;
const taskTime = (task: SidebarTask) => Date.parse(task.updatedAt || task.createdAt) || 0;

/**
 * The sidebar's project groups: one per project, ordered by each project's most recent task,
 * its tasks most recent first. Tasks with no project, or whose project is gone, come last under
 * No project (`project` null).
 */
export function tasksByProject(tasks: SidebarTask[], projects: SidebarProject[]) {
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const groups = new Map<string | null, SidebarTask[]>();
  for (const task of [...tasks].sort((a, b) => taskTime(b) - taskTime(a))) {
    const key = task.projectId && names.has(task.projectId) ? task.projectId : null;
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  return [...groups.entries()]
    .map(([id, items]) => ({
      project: id === null ? null : { id, name: names.get(id)! },
      tasks: items,
    }))
    .sort((a, b) =>
      !a.project !== !b.project
        ? a.project
          ? -1
          : 1
        : taskTime(b.tasks[0]) - taskTime(a.tasks[0]),
    );
}
