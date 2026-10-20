import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { command, commandReplay, event, get, id, list, now, revise, save } from './store.ts';
import { activeCheck } from './checks.ts';
import { diff } from './service.ts';
import { patchDigest } from './review.ts';
import { requireRepository } from './repositories.ts';
import { gitEnvironment, gitText, repositoryGit } from './repository-git.ts';
import { createPublishedPull } from './project-collaboration.ts';
import { queuePushTrigger } from './pipeline-triggers.ts';
import { taskPublishDefaults } from './task-presentation.ts';

const conflict = (message: string): never => {
  throw Object.assign(new Error(message), { status: 409 });
};
function ready(owner: string, task: any) {
  if ((task.workspaceStatus && task.workspaceStatus !== 'ready') || task.status === 'preparing')
    conflict('Workspace is not ready; finish workspace preparation before publishing');
  if (task.status === 'merged') conflict('This task has already been merged');
  if (
    activeCheck(owner, task.id) ||
    list('run', owner).some(
      (r) =>
        r.taskId === task.id && ['queued', 'starting', 'running', 'unknown'].includes(r.status),
    ) ||
    list('job', owner).some(
      (j) => j.taskId === task.id && ['queued', 'running', 'unknown'].includes(j.status),
    )
  )
    conflict('A run or check is active; stop it before publishing');
}

/** Build objects off the task workspace, then CAS the branch and a durable recovery receipt together. */
export async function publishTask(owner: string, taskId: string, input: any, signature: string) {
  const replay = commandReplay(owner, input.operationId, signature);
  if (replay.found) return replay.result;
  const task = get('task', owner, taskId);
  const project = requireRepository(owner, task.projectId);
  const repo = project.repositoryPath;
  const pulls = list('pull-request', owner).filter(
    (p) => p.projectId === project.id && p.taskIds?.includes(taskId),
  );
  const existing = pulls.find((p) => p.status === 'open');
  const branch = existing?.sourceBranch || `task/${task.id.replaceAll('-', '').slice(0, 8)}`;
  const ref = `refs/heads/${branch}`;
  const receiptRef = `refs/deploy/publish/${createHash('sha256')
    .update(JSON.stringify([owner, input.operationId]))
    .digest('hex')}`;
  const receiptId = await gitText(repo, ['rev-parse', '--verify', '--quiet', receiptRef]).catch(
    () => '',
  );
  const finish = (receipt: any) => {
    if (receipt.signature !== signature)
      conflict('operationId was already used for a different command');
    const current = get('task', owner, taskId);
    const savedPull = list('pull-request', owner).find((p) => p.id === receipt.result.pull.id);
    if (!savedPull || savedPull.revision < receipt.result.pull.revision)
      save('pull-request', owner, receipt.result.pull);
    if (!current.publishedAt || current.publishedAt < receipt.taskFields.publishedAt)
      save('task', owner, {
        ...current,
        ...receipt.taskFields,
        revision: current.revision + 1,
        updatedAt: now(),
      });
    if (
      receipt.activity &&
      !list('project-comment', owner).some((c) => c.id === receipt.activity.id)
    )
      save('project-comment', owner, receipt.activity);
    queuePushTrigger(
      owner,
      project.id,
      `refs/heads/${receipt.result.branch}`,
      receipt.result.commit,
    );
    event(owner, taskId, null, 'task.published', {
      pullId: receipt.result.pull.id,
      branch: receipt.result.branch,
      commit: receipt.result.commit,
    });
    return receipt.result;
  };
  if (receiptId) {
    const receipt = JSON.parse(await gitText(repo, ['cat-file', 'blob', receiptId]));
    return command(owner, input.operationId, () => finish(receipt), signature);
  }
  revise(task, input.revision);
  ready(owner, task);
  if (pulls.some((p) => p.status === 'merged')) conflict('This task has already been merged');
  if (
    existing?.mergeOperationId &&
    ['queued', 'running', 'unknown'].includes(
      get('repository-operation', owner, existing.mergeOperationId).status,
    )
  )
    conflict('A merge is active; wait for it before publishing');
  const defaults = taskPublishDefaults(owner, task);
  const title = existing?.title ?? input.title ?? defaults.title;
  const body = existing?.body ?? input.body ?? defaults.body;
  if (typeof title !== 'string' || !title.trim() || title.length > 300 || /[\r\n]/.test(title))
    throw new Error('Title must be one nonempty line of at most 300 characters');
  if (typeof body !== 'string' || body.length > 50000)
    throw new Error('Body must be text of at most 50000 characters');
  const snapshot = diff(owner, taskId);
  if (
    snapshot.truncated ||
    snapshot.excluded?.length ||
    typeof snapshot.patch !== 'string' ||
    snapshot.baseRevision !== task.baseRevision ||
    (!snapshot.patch && snapshot.files?.length) ||
    /not been uploaded|unavailable/i.test(snapshot.status || '')
  )
    conflict(
      'Task diff is truncated, unavailable or has excluded files; refresh changes and resolve excluded files before publishing',
    );
  if (!snapshot.patch.trim()) conflict('The task diff is empty; there are no changes to publish');
  const directory = await mkdtemp(join(tmpdir(), 'deploy-publish-'));
  const options = { indexFile: join(directory, 'index'), identity: owner, limit: 16 * 1024 * 1024 };
  try {
    await gitText(repo, ['read-tree', task.baseRevision], options);
    try {
      await gitText(repo, ['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], {
        ...options,
        input: snapshot.patch,
      });
    } catch {
      conflict('The task patch does not apply to its base revision; ask the agent to rebase');
    }
    const tree = await gitText(repo, ['write-tree'], options);
    const head = await gitText(repo, ['rev-parse', '--verify', '--quiet', ref]).catch(() => '');
    if (task.publishedCommit && !head)
      conflict('The published branch was deleted; ask the agent to rebase');
    if (task.publishedCommit) {
      try {
        await gitText(repo, ['merge-base', '--is-ancestor', task.publishedCommit, head]);
      } catch {
        conflict('The published branch was rewritten; ask the agent to rebase before publishing');
      }
    }
    const previousTree = task.publishedTree || task.baseRevision;
    const delta = await repositoryGit(
      repo,
      [
        'diff',
        '--binary',
        '--full-index',
        '--no-ext-diff',
        '--no-textconv',
        previousTree,
        tree,
        '--',
      ],
      options,
    );
    if (!delta.length) conflict('The task diff is empty; there are no new changes to publish');
    const changedPaths = await repositoryGit(
      repo,
      ['diff', '--name-only', '-z', previousTree, tree],
      options,
    );
    const changedCount = changedPaths.toString().split('\0').filter(Boolean).length;
    const parent = head || task.baseRevision;
    await gitText(repo, ['read-tree', parent], options);
    try {
      await gitText(repo, ['apply', '--cached', '--3way', '--binary', '--whitespace=nowarn', '-'], {
        ...options,
        input: delta.toString(),
      });
    } catch {
      conflict(
        'The target branch moved and the task patch no longer applies; ask the agent to rebase',
      );
    }
    const commitTree = await gitText(repo, ['write-tree'], options);
    if (commitTree === (await gitText(repo, ['rev-parse', `${parent}^{tree}`])))
      conflict('The branch already contains these changes; there are no new changes to publish');
    const commit = await gitText(repo, ['commit-tree', commitTree, '-p', parent], {
      ...options,
      input: `${title.trim()}\n\nTask: ${task.id}\n`,
    });
    return command(
      owner,
      input.operationId,
      () => {
        // A run/check or another publish may have started while Git objects were being built.
        const current = get('task', owner, taskId);
        revise(current, input.revision);
        ready(owner, current);
        const latest = existing ? get('pull-request', owner, existing.id) : null;
        if (latest && (latest.revision !== existing.revision || latest.status !== 'open'))
          conflict('Pull request changed; refresh before publishing');
        const linked = list('pull-request', owner).filter(
          (p) => p.projectId === project.id && p.taskIds?.includes(taskId),
        );
        if (
          linked.some(
            (p) => p.status === 'merged' || (p.status === 'open' && p.id !== existing?.id),
          )
        )
          conflict('Linked pull requests changed; refresh before publishing');
        const pull =
          existing || createPublishedPull(owner, project, task, branch, title.trim(), body);
        const receipt = {
          signature,
          activity: existing
            ? {
                id: id(),
                projectId: project.id,
                parentId: existing.id,
                parentKind: 'pull-request',
                author: owner,
                body: `Updated: ${changedCount} ${changedCount === 1 ? 'file' : 'files'} changed in this turn`,
                createdAt: now(),
              }
            : null,
          result: { pull, branch, commit },
          taskFields: {
            publishedAt: now(),
            publishedCommit: commit,
            publishedTree: tree,
            publishedPatchDigest: patchDigest(task.baseRevision, snapshot.patch),
          },
        };
        // Allocate the review number and write the small receipt under the writer lock.
        // The commit and file objects were built above, outside SQLite.
        const receiptWrite = spawnSync(
          'git',
          ['-c', 'core.hooksPath=/dev/null', '-C', repo, 'hash-object', '-w', '--stdin'],
          {
            env: gitEnvironment(),
            encoding: 'utf8',
            timeout: 10000,
            input: JSON.stringify(receipt),
          },
        );
        if (receiptWrite.status !== 0)
          throw new Error('Could not write the publish recovery receipt');
        const blob = receiptWrite.stdout.trim();
        const update = spawnSync(
          'git',
          ['-c', 'core.hooksPath=/dev/null', '-C', repo, 'update-ref', '--stdin'],
          {
            env: gitEnvironment(),
            encoding: 'utf8',
            timeout: 10000,
            input: `start\nupdate ${ref} ${commit} ${head || '0'.repeat(commit.length)}\ncreate ${receiptRef} ${blob}\nprepare\ncommit\n`,
          },
        );
        if (update.status !== 0)
          conflict('The target branch moved while publishing; refresh and ask the agent to rebase');
        return finish(receipt);
      },
      signature,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
