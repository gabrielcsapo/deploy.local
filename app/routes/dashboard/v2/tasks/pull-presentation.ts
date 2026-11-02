import type { TaskPull } from './types';
import { projectPath, projectSegment } from '../projects/routing';
export function pullHref(project: string, pull: TaskPull) {
  const task = pull.taskIds?.at(-1);
  return task
    ? `/dashboard/tasks/${encodeURIComponent(task)}`
    : `${projectPath(project)}/pulls/${projectSegment(pull.id)}`;
}
export function pullMeta(pull: TaskPull) {
  return [
    `#${pull.number}`,
    pull.taskIds?.length
      ? pull.taskAuthor
        ? `task by ${pull.taskAuthor}`
        : 'task'
      : `from ${pull.sourceBranch}`,
    pull.status === 'merged' && pull.mergedBy
      ? `merged by ${pull.mergedByName || pull.mergedBy}`
      : undefined,
    pull.release?.commit ? `released ${pull.release.commit.slice(0, 7)}` : undefined,
    pull.status === 'open' && pull.checkCount ? `${pull.checksPassed} checks passed` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}
export function pullElapsed(value?: string, now = Date.now()) {
  const time = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return 'Unavailable';
  const minutes = Math.max(0, Math.floor((now - time) / 60000));
  return minutes < 1
    ? 'now'
    : minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / 1440)}d`;
}
