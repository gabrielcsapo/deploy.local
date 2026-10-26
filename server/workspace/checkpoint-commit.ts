import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentScope } from './coordination.ts';
import { validateSnapshot, type Snapshot } from './checkpoint.ts';
import { refreshCommitBaseline } from './commit-baseline.ts';
import { command, commandReplay, event, get, list, now, revise, save } from './store.ts';
import { repositoryWebURL, requireRepository } from './repositories.ts';
import { gitEnvironment, gitText, repositoryGit } from './repository-git.ts';
import { queuePushTrigger } from './pipeline-triggers.ts';
import { patchDigest } from './review.ts';
import {
  commitParent,
  currentTaskBranch,
  followUpPlacement,
  mergedPublication,
  taskBaseline,
} from './follow-up.ts';

const conflict = (message: string): never => {
  throw Object.assign(new Error(message), { status: 409 });
};
const escapeMarkdown = (value: string) => value.replace(/[\\`*_[\]<>]/g, '\\$&');

/** Build an exact checkpoint tree and commit without moving refs or requiring an agent scope.
 * Callers retain their own branch guards, atomic receipts and publication events. */
export async function buildCheckpointCommit(
  repo: string,
  snapshot: Snapshot,
  parent: string,
  message: string,
  owner: string,
  options: { indexFile: string; limit: number },
  committer?: string,
) {
  // A delta checkpoint describes changes over its base tree; a full-tree one is the whole tree.
  await gitText(
    repo,
    snapshot.base ? ['read-tree', snapshot.base.commit] : ['read-tree', '--empty'],
    options,
  );
  // Deletions are applied first, in their own call: a path that became a directory needs its
  // blob entry gone before anything under it is added, and one stream resolves too late for
  // that. Mode 0 removes an entry, which is the only form a bare repository accepts.
  if (snapshot.deleted?.length) {
    const absent = '0'.repeat(snapshot.base!.commit.length);
    await gitText(repo, ['update-index', '-z', '--index-info'], {
      ...options,
      input: snapshot.deleted.map((path) => `0 ${absent}\t${path}\0`).join(''),
    });
  }
  const entries: string[] = [];
  for (const file of snapshot.files) {
    const blob = await gitText(repo, ['hash-object', '-w', '--stdin'], {
      input: Buffer.from(file.content, 'base64'),
    });
    entries.push(`${file.executable ? '100755' : '100644'} ${blob}\t${file.path}\0`);
  }
  await gitText(repo, ['update-index', '-z', '--index-info'], {
    ...options,
    input: entries.join(''),
  });
  const tree = await gitText(repo, ['write-tree'], options);
  const commit = await gitText(repo, ['commit-tree', tree, '-p', parent], {
    identity: owner,
    ...(committer ? { committer } : {}),
    input: message,
  });
  return { tree, commit };
}

/** Authenticated coordinator transport: agents send checkpoint IDs, never Git writes. */
export async function commitCheckpoint(scope: AgentScope, args: any) {
  const { owner, taskId, runId } = scope;
  const signature = createHash('sha256')
    .update(
      JSON.stringify({
        taskId,
        tool: 'deploy_commit',
        checkpointId: args.checkpointId,
        message: args.message,
        branch: args.branch,
      }),
    )
    .digest('hex');
  const replay = commandReplay(owner, args.operationId, signature);
  const task = get('task', owner, taskId);
  if (!task.projectId)
    throw new Error('Create a repository with deploy_create_repository before committing');
  const project = requireRepository(owner, task.projectId);
  const repo = project.repositoryPath;
  const refresh = async (result: any) => {
    const latest = get('task', owner, taskId);
    if (!latest.workerId || latest.workerId === 'local')
      await refreshCommitBaseline(latest.workspacePath, latest, repo);
    return result;
  };
  if (replay.found) return refresh(replay.result);
  const receiptRef = `refs/deploy/commit/${createHash('sha256')
    .update(JSON.stringify([owner, args.operationId]))
    .digest('hex')}`;
  const receiptId = await gitText(repo, ['rev-parse', '--verify', '--quiet', receiptRef]).catch(
    () => '',
  );
  // After the task's pull request merged, follow-up work commits on top of the merged target.
  const merged = mergedPublication(owner, task);
  const placement = merged && !receiptId ? await followUpPlacement(repo, task, merged) : null;
  const defaultBranch = placement?.branch ?? currentTaskBranch(task);
  const branch = args.branch ?? defaultBranch;
  if (placement && branch !== placement.branch)
    throw new Error(
      `Pull request #${merged.number} merged this task's last commit; commit the follow-up to ${placement.branch}`,
    );
  if (branch !== 'main' && branch !== defaultBranch)
    throw new Error('Choose the task branch or main for an eligible first commit');
  if (
    typeof args.message !== 'string' ||
    !args.message.trim() ||
    args.message.length > 16000 ||
    args.message.includes('\0')
  )
    throw new Error('A commit message of at most 16000 characters is required');
  const checkpoint = get('checkpoint', owner, args.checkpointId);
  if (checkpoint.taskId !== taskId)
    throw Object.assign(new Error('Checkpoint belongs to another task'), { status: 403 });
  const snapshot = validateSnapshot(checkpoint.snapshot);
  const ref = `refs/heads/${branch}`;
  const finish = (receipt: any, mainHead = receipt.result.commit) => {
    if (receipt.signature !== signature)
      conflict('operationId was already used for a different command');
    const current = get('task', owner, taskId);
    // A delayed recovery must not roll back a later successful commit's baseline.
    if (!current.publishedAt || current.publishedAt <= receipt.taskFields.publishedAt)
      save('task', owner, {
        ...current,
        ...receipt.taskFields,
        revision: current.revision + 1,
        updatedAt: now(),
      });
    if (branch === 'main')
      save('project', owner, {
        ...get('project', owner, project.id),
        head: mainHead,
        updatedAt: now(),
      });
    queuePushTrigger(owner, project.id, ref, receipt.result.commit);
    const message = save('message', owner, {
      id: `commit:${receipt.result.commit}`,
      taskId,
      runId,
      role: 'assistant',
      createdAt: now(),
      content: `> **Committed** [${receipt.result.commit.slice(0, 8)}](${receipt.result.url}) · ${escapeMarkdown(branch)} · ${receipt.result.files} files\n>\n> ${escapeMarkdown(args.message.trim().split('\n')[0])}`,
      commit: receipt.result,
    });
    event(owner, taskId, runId, 'message', message);
    event(owner, taskId, runId, 'task.committed', receipt.result);
    return receipt.result;
  };
  if (receiptId) {
    const receipt = JSON.parse(await gitText(repo, ['cat-file', 'blob', receiptId]));
    const mainHead =
      branch === 'main' ? await gitText(repo, ['rev-parse', 'refs/heads/main']) : undefined;
    return refresh(command(owner, args.operationId, () => finish(receipt, mainHead), signature));
  }
  const head = placement
    ? placement.head
    : await gitText(repo, ['rev-parse', '--verify', '--quiet', ref]).catch(() => '');
  if (branch === 'main') {
    const creation = list('repository-creation', owner).find(
      (row) => row.id === project.id && row.taskId === taskId,
    );
    // Exact provenance, not commit subjects: only the seed and recorded initial publication qualify.
    const initial = creation?.result?.commit || creation?.seed;
    if (!initial || head !== initial || task.workspaceCommit || task.publishedCommit)
      conflict(
        'main is only allowed for the first deploy_commit in a repository created by this task with only creation history; use the task branch and open a pull request',
      );
  }
  const expected = taskBaseline(task);
  // A task branch that does not exist yet starts from this task's own baseline, not from the
  // current main tip, so main moving under an open task never blocks its commits.
  const parent = commitParent(task, head, placement);
  // Guidance names the branch whose commits are at stake: for a follow-up that is the merge
  // target it builds on, otherwise the task's own branch.
  const parentBranch = placement?.targetBranch ?? branch;
  if (task.workspaceCommit?.branch === branch && !head && !placement)
    conflict(
      `Branch ${branch} holds this task's earlier commits and no longer exists in the repository, so this commit has nothing to continue. Restore or recreate it, or start a new task from the commit you want to build on. No commit was published.`,
    );
  // The parent is a recorded baseline rather than a live ref, so say so plainly when a force
  // push left it unreachable instead of failing later inside commit-tree.
  if (
    !(await gitText(repo, ['rev-parse', '--verify', '--quiet', `${parent}^{commit}`]).catch(
      () => '',
    ))
  )
    conflict(
      `This task's base commit ${parent.slice(0, 8)} is no longer in the repository, so there is nothing to commit onto. Start a new task from the branch tip you want to build on. No commit was published.`,
    );
  if (
    parent !== expected &&
    (await gitText(repo, ['rev-parse', `${parent}^{tree}`])) !==
      (await gitText(repo, ['rev-parse', `${expected}^{tree}`]))
  )
    conflict(
      `The target branch ${parentBranch} moved to commits this task does not have, and committing this checkpoint would discard them. No commit was published. Merge or revert those commits on ${parentBranch}, or start a new task from its current tip and redo this work there.`,
    );
  const directory = await mkdtemp(join(tmpdir(), 'deploy-commit-'));
  const options = { indexFile: join(directory, 'index'), limit: 16 * 1024 * 1024 };
  try {
    const { tree, commit } = await buildCheckpointCommit(
      repo,
      snapshot,
      parent,
      `${args.message.trim()}\n\nTask: ${String(task.title).replace(/[\r\n]/g, ' ')} (${taskId})\n`,
      owner,
      options,
      'deploy.local',
    );
    const baseRevision = branch === 'main' ? commit : task.baseRevision;
    const patch = (
      await repositoryGit(
        repo,
        [
          'diff',
          '--binary',
          '--full-index',
          '--no-ext-diff',
          '--no-textconv',
          baseRevision,
          commit,
          '--',
        ],
        options,
      )
    ).toString();
    const result = {
      commit,
      branch,
      files: snapshot.files.length,
      url: repositoryWebURL(owner, project),
    };
    const receipt = {
      signature,
      result,
      taskFields: {
        baseRevision,
        sourceRef: branch,
        publishedAt: now(),
        publishedCommit: commit,
        publishedTree: tree,
        publishedPatchDigest: patchDigest(baseRevision, patch),
        publishedMessageId:
          list('message', owner)
            .filter((m) => m.taskId === taskId && m.role === 'user' && !m.shell)
            .at(-1)?.id || null,
        workspaceCommit: { commit, branch, checkpointId: checkpoint.id },
      },
    };
    const blob = await gitText(repo, ['hash-object', '-w', '--stdin'], {
      input: JSON.stringify(receipt),
    });
    const committed = command(
      owner,
      args.operationId,
      () => {
        revise(get('task', owner, taskId), task.revision);
        const update = spawnSync(
          'git',
          ['-c', 'core.hooksPath=/dev/null', '-C', repo, 'update-ref', '--stdin'],
          {
            env: gitEnvironment(),
            encoding: 'utf8',
            timeout: 10000,
            input: `start\nupdate ${ref} ${commit} ${head || '0'.repeat(40)}\ncreate ${receiptRef} ${blob}\nprepare\ncommit\n`,
          },
        );
        if (update.status !== 0)
          conflict(
            `Branch ${branch} changed while this commit was being written, so nothing was committed. Capture a new checkpoint and commit again.`,
          );
        return finish(receipt);
      },
      signature,
    );
    return refresh(committed);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
