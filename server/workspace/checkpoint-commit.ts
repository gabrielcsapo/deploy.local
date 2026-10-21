import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentScope } from './coordination.ts';
import { validateSnapshot } from './checkpoint.ts';
import { refreshCommitBaseline } from './commit-baseline.ts';
import { command, commandReplay, event, get, list, now, revise, save } from './store.ts';
import { requireRepository } from './repositories.ts';
import { gitEnvironment, gitText, repositoryGit } from './repository-git.ts';
import { queuePushTrigger } from './pipeline-triggers.ts';
import { patchDigest } from './review.ts';

const conflict = (message: string): never => {
  throw Object.assign(new Error(message), { status: 409 });
};
const escapeMarkdown = (value: string) => value.replace(/[\\`*_[\]<>]/g, '\\$&');

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
  const branch = args.branch ?? `task/${task.id.replaceAll('-', '').slice(0, 8)}`;
  if (branch !== 'main' && branch !== `task/${task.id.replaceAll('-', '').slice(0, 8)}`)
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
  const receiptRef = `refs/deploy/commit/${createHash('sha256')
    .update(JSON.stringify([owner, args.operationId]))
    .digest('hex')}`;
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
  const receiptId = await gitText(repo, ['rev-parse', '--verify', '--quiet', receiptRef]).catch(
    () => '',
  );
  if (receiptId) {
    const receipt = JSON.parse(await gitText(repo, ['cat-file', 'blob', receiptId]));
    const mainHead =
      branch === 'main' ? await gitText(repo, ['rev-parse', 'refs/heads/main']) : undefined;
    return refresh(command(owner, args.operationId, () => finish(receipt, mainHead), signature));
  }
  if (task.status === 'merged') conflict('This task has already been merged');
  const head = await gitText(repo, ['rev-parse', '--verify', '--quiet', ref]).catch(() => '');
  const main = await gitText(repo, ['rev-parse', 'refs/heads/main']);
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
  const expected = task.publishedCommit || task.workspaceCommit?.commit || task.baseRevision;
  const parent = head || main;
  if (task.workspaceCommit?.branch === branch && !head)
    conflict('The task branch was deleted; refresh the task before committing');
  if (
    parent !== expected &&
    (await gitText(repo, ['rev-parse', `${parent}^{tree}`])) !==
      (await gitText(repo, ['rev-parse', `${expected}^{tree}`]))
  )
    conflict(
      'The target branch moved since the task baseline; replacing it would discard someone else’s changes. Refresh/rebase the task and checkpoint again. No commit was published.',
    );
  const directory = await mkdtemp(join(tmpdir(), 'deploy-commit-'));
  const options = { indexFile: join(directory, 'index'), limit: 16 * 1024 * 1024 };
  try {
    await gitText(repo, ['read-tree', '--empty'], options);
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
      committer: 'deploy.local',
      input: `${args.message.trim()}\n\nTask: ${String(task.title).replace(/[\r\n]/g, ' ')} (${taskId})\n`,
    });
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
      url: `https://deploy.local/dashboard/repositories/${project.id}`,
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
            .filter((m) => m.taskId === taskId && m.role === 'user')
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
          conflict('The target branch moved while committing; retry after refreshing the task');
        return finish(receipt);
      },
      signature,
    );
    return refresh(committed);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
