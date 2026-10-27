import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { captureSnapshot, recordCheckpointBase } from './checkpoint.ts';
import { gitText } from './repository-git.ts';
import { inspectWorkspace, workspaceFilePatches } from './review.ts';

/** An idle remote task may never have run on this computer. Prepare its pinned baseline
 * atomically, using the same authenticated repository transport as an assigned run. */
export async function prepareBaseUpdateWorkspace(
  cwd: string,
  operation: any,
  repository: string,
  authentication?: { origin: string; header: string },
) {
  if (existsSync(cwd) || operation.action === 'abort') return;
  await mkdir(dirname(cwd), { recursive: true });
  const staging = await mkdtemp(join(dirname(cwd), '.update-workspace-'));
  try {
    await gitText(staging, ['clone', repository, '.'], { authentication, timeout: 600000 });
    const baseline = operation.previous.workspaceCommit?.commit || operation.previous.baseRevision;
    await gitText(staging, ['fetch', '--no-tags', '--no-write-fetch-head', repository, baseline], {
      authentication,
    });
    await gitText(staging, ['checkout', '-b', `task/${operation.taskId}`, baseline]);
    recordCheckpointBase(staging, baseline);
    await rename(staging, cwd);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Runs in the ordinary worker, outside the agent sandbox. The journal survives lost replies or restarts. */
export async function executeBaseUpdate(
  cwd: string,
  operation: any,
  repository: string,
  request: (action: string, body: any) => Promise<any>,
  authentication?: { origin: string; header: string },
) {
  if (operation.action === 'abort' && !operation.beforeCommit) {
    const plan = await request('prepare', { id: operation.id, generation: operation.generation });
    return request('complete', { id: plan.id, generation: plan.generation });
  }
  const gitDir = await gitText(cwd, ['rev-parse', '--absolute-git-dir']);
  const path = join(gitDir, `deploy-update-${operation.taskId}.json`);
  const indexBackup = `${path}.${createHash('sha256').update(operation.id).digest('hex')}.index`;
  let journal: any = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  const write = () => {
    writeFileSync(path + '.tmp', JSON.stringify(journal), { mode: 0o600 });
    renameSync(path + '.tmp', path);
  };
  const key = `${operation.id}:${operation.action}`;
  if (journal?.key !== key) {
    if (operation.action === 'update') copyFileSync(join(gitDir, 'index'), indexBackup);
    const snapshot = operation.action === 'abort' ? undefined : captureSnapshot(cwd);
    const plan = await request('prepare', {
      id: operation.id,
      generation: operation.generation,
      snapshot,
    });
    if (!['prepared'].includes(plan.status)) return plan;
    journal = {
      key,
      plan,
      head: await gitText(cwd, ['rev-parse', 'HEAD']),
      installed: false,
      previous: operation.action === 'update' ? null : journal,
    };
    write();
  }
  // A resume keeps the local installation journal but adopts the command's current fence.
  journal.plan.generation = operation.generation;
  const plan = journal.plan;
  if (!journal.installed) {
    if (plan.beforeCommit)
      await gitText(
        cwd,
        ['fetch', '--no-tags', '--no-write-fetch-head', repository, plan.beforeCommit, plan.commit],
        { authentication },
      );
    const applied = await gitText(cwd, ['diff', '--quiet', plan.commit, '--']).then(
      () => true,
      () => false,
    );
    if (plan.action !== 'abort' && !applied && captureSnapshot(cwd).digest !== plan.snapshotDigest)
      throw new Error(
        'Workspace changed during update; resume after restoring those edits or abort the update',
      );
    if (plan.action === 'update' && !applied) {
      // Stage the preserved snapshot without changing files, then apply only the merge delta.
      await gitText(cwd, ['read-tree', plan.beforeCommit]);
      await gitText(cwd, ['update-index', '--refresh']);
      await gitText(cwd, ['read-tree', '-m', '-u', plan.beforeCommit, plan.commit]);
    } else if (plan.action === 'abort' && plan.beforeCommit) {
      await gitText(cwd, ['read-tree', '--reset', '-u', plan.beforeCommit]);
    }
    const original = plan.action === 'abort' ? originalJournal(journal) : null;
    const commit = plan.action === 'abort' ? original?.head || journal.head : plan.commit;
    await gitText(cwd, ['update-ref', `refs/heads/task/${plan.taskId}`, commit]);
    await gitText(cwd, ['symbolic-ref', 'HEAD', `refs/heads/task/${plan.taskId}`]);
    await gitText(cwd, ['read-tree', commit]);
    if (plan.action === 'abort' && existsSync(indexBackup))
      copyFileSync(indexBackup, join(gitDir, 'index'));
    recordCheckpointBase(
      cwd,
      plan.action === 'abort'
        ? plan.previous.workspaceCommit?.commit || plan.previous.baseRevision
        : plan.commit,
    );
    journal.installed = true;
    write();
  }
  const base = plan.action === 'abort' ? plan.previous.baseRevision : plan.target;
  const diff = inspectWorkspace(cwd, base);
  const filePatches = workspaceFilePatches(cwd, base, diff.files).patches;
  return request('complete', {
    id: plan.id,
    generation: plan.generation,
    diff,
    filePatches,
  });
}
function originalJournal(journal: any): any {
  return journal.previous?.plan.id === journal.plan.id
    ? originalJournal(journal.previous)
    : journal;
}
