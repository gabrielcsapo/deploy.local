import { db, list } from './store.ts';
import { gitSync } from './repository-git.ts';

const active = (status: string) => ['queued', 'starting', 'running', 'unknown'].includes(status);
const closed = (task: any) => ['merged', 'done', 'closed', 'deleted'].includes(task.status);

/** Only known checkpoint refs are collected. An unrecorded ref may be between Git retention
 * and the checkpoint's SQLite insert. Never race that writer by sweeping unknown refs. */
export function cleanupCheckpointRefs(owner: string, taskId?: string) {
  return db
    .transaction(() => {
      const tasks = new Map(list('task', owner).map((task) => [task.id, task]));
      const checkpoints = list('checkpoint', owner);
      const needed = new Set<string>();
      for (const job of list('job', owner)) if (active(job.status)) needed.add(job.checkpointId);
      for (const deployment of list('application-deployment', owner))
        if (!deployment.completedAt) needed.add(deployment.checkpointId);
      const byId = new Map(checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
      // Publication may select an older checkpoint. Protect captures newer than the one
      // actually published, even if they predate the publication's wall-clock timestamp.
      // Legacy publications only recorded publishedAt, which remains their fallback.
      for (const checkpoint of checkpoints) {
        const task = tasks.get(checkpoint.taskId);
        const published = byId.get(
          task?.publishedCheckpointId ?? task?.workspaceCommit?.checkpointId,
        );
        const publishedAt = published?.createdAt ?? task?.publishedAt;
        if (
          task &&
          (!closed(task) ||
            !publishedAt ||
            !checkpoint.createdAt ||
            checkpoint.createdAt > publishedAt ||
            (published && checkpoint.createdAt === publishedAt && checkpoint.id !== published.id))
        )
          needed.add(checkpoint.id);
      }
      const projects = list('project', owner);
      let removed = 0;
      for (const project of projects) {
        if (!project.repositoryPath) continue;
        const owned = checkpoints.filter(
          (checkpoint) =>
            (checkpoint.projectId || tasks.get(checkpoint.taskId)?.projectId) === project.id ||
            // Older checkpoints did not record a project. For a deleted task, match its exact
            // globally unique ref against each of this owner's repositories below.
            (!checkpoint.projectId && !tasks.has(checkpoint.taskId)),
        );
        for (const checkpoint of owned) {
          if (taskId && checkpoint.taskId !== taskId) continue;
          const ref = checkpoint.baseRef;
          const base = checkpoint.snapshot?.base?.commit;
          if (
            needed.has(checkpoint.id) ||
            !/^refs\/deploy\/checkpoint\/[a-f0-9]{64}$/.test(ref || '') ||
            !base
          )
            continue;
          const actual = gitSync(project.repositoryPath, ['rev-parse', '--verify', '--quiet', ref]);
          // Compare-and-delete also protects a ref moved by another writer.
          if (
            actual === base &&
            gitSync(project.repositoryPath, ['update-ref', '-d', ref, base]) !== null
          )
            removed++;
        }
      }
      return removed;
    })
    .immediate();
}

export function sweepCheckpointRefs() {
  const owners = db.prepare("SELECT DISTINCT owner FROM records WHERE kind='checkpoint'").all() as {
    owner: string;
  }[];
  for (const { owner } of owners) {
    try {
      cleanupCheckpointRefs(owner);
    } catch (error) {
      console.error('Checkpoint ref cleanup:', (error as Error).message);
    }
  }
}

/** Close/merge should still succeed when Git is temporarily unavailable; the sweep retries. */
export function cleanupTaskCheckpointRefs(owner: string, taskId: string) {
  try {
    cleanupCheckpointRefs(owner, taskId);
  } catch (error) {
    console.error('Checkpoint ref cleanup:', (error as Error).message);
  }
}
