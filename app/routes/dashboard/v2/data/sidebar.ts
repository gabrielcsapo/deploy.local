export type SidebarTask = {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
};
export type SidebarRun = { taskId: string; status: string; updatedAt?: string; createdAt: string };
export type WorkspaceState = { tasks: SidebarTask[]; runs: SidebarRun[] };
export type SidebarAgent = { id: string; name: string };
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
