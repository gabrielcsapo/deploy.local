import { cleanupTaskCheckpointRefs } from './checkpoint-retention.ts';
import { releaseQueuedMessage } from './queued-message.ts';
import { workerLoad } from './run-queue.ts';
import { cancelTaskQuestions } from './question-lifecycle.ts';
import { shellPromptContext } from './shell-commands.ts';
import { assertWorkerRole } from './computer-role-policy.ts';
import { videoInputNote } from './video-files.ts';
import { validateAttachments } from './attachments.ts';
import { providerUsage } from './provider-usage.ts';
import { computers } from './coordination.ts';
import { modelOptions, validateRunSettings } from './model-options.ts';
import { activeCheck } from './checks.ts';
import {
  fullPatchLimit,
  inspectWorkspace,
  joinFilePatches,
  patchDigest,
  privateReviewPath,
  reviewFilePath,
  workspaceFilePatch,
  workspacePatch,
  type FilePatch,
} from './review.ts';
import { execFile, spawnSync } from 'node:child_process';
import { list, get, save, remove, event, id, now, revise } from './store.ts';
import { captureTurnCheckpoint, diffTurnCheckpoints, turnFilePatch } from './turn-checkpoint.ts';
import { latestCheckpointSummary } from './checkpoint-publish.ts';
import { stopRestartedRun } from './run-recovery.ts';
export function git(cwd: string, args: string[]) {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60000,
  });
  if (r.status !== 0) throw new Error(r.stderr || 'Git failed');
  return r.stdout.trimEnd();
}
export function startRun(owner: string, taskId: string, input: any, answeredQuestionId?: string) {
  const task = get('task', owner, taskId);
  revise(task, input.revision);
  if (
    task.baseUpdate &&
    ['queued', 'preparing', 'prepared', 'failed'].includes(task.baseUpdate.status)
  )
    throw Object.assign(new Error('Finish or abort the workspace update before starting a run'), {
      status: 409,
    });
  if (task.workspaceStatus && !['ready', 'preparing'].includes(task.workspaceStatus))
    throw Object.assign(new Error('Workspace preparation needs recovery'), { status: 409 });
  if (
    list('run', owner).some(
      (r) => r.taskId === taskId && ['queued', 'starting', 'running', 'unknown'].includes(r.status),
    )
  )
    throw Object.assign(new Error('Task already has an active run'), { status: 409 });
  if (activeCheck(owner, taskId))
    throw Object.assign(new Error('Task has an active check'), { status: 409 });
  assertWorkerRole(owner, task.workerId || 'local', 'tasks');
  const adapter = input.adapter || 'codex';
  if (!['codex', 'claude', 'compatible'].includes(adapter)) throw new Error('Unsupported adapter');
  if (task.workerId && task.workerId !== 'local') {
    const worker = get('worker', owner, task.workerId);
    if (
      worker.connections?.length &&
      !worker.connections.some((value: any) => value.provider === adapter && value.available)
    )
      throw new Error('Connect this provider in Settings before starting a run');
  }
  if (
    (!task.workerId || task.workerId === 'local') &&
    adapter === 'compatible' &&
    (!process.env.DEPLOY_MODEL_BASE_URL || !process.env.DEPLOY_MODEL_BILLING_MODE)
  )
    throw new Error('Compatible endpoint is not explicitly configured on this coordinator');
  const options =
    !task.workerId || task.workerId === 'local'
      ? modelOptions()
      : get('worker', owner, task.workerId).modelOptions || [];
  const settings = validateRunSettings({ ...input, adapter }, options);
  const content = String(input.content || '').trim();
  const attachments = validateAttachments(owner, taskId, input.attachmentIds);
  if ((!content && !attachments.length) || content.length > 100000)
    throw new Error('Message required (maximum 100000 characters)');
  const attachmentIds = attachments.map((a) => a.id);
  const msg = { id: id(), taskId, role: 'user', content, attachmentIds, createdAt: now() };
  for (const attachment of attachments)
    save('attachment', owner, { ...attachment, messageId: msg.id });
  cancelTaskQuestions(owner, taskId, answeredQuestionId);
  save('message', owner, msg);
  // Sending directly (or releasing the queue) supersedes any queued or held follow-up.
  remove('queued-message', owner, taskId);
  event(owner, taskId, null, 'message', msg);
  const prior = list('run', owner)
    .filter((r) => r.taskId === taskId && r.sessionId && r.adapter === (input.adapter || 'codex'))
    .at(-1);
  const run = {
    id: id(),
    taskId,
    adapter,
    attachmentIds,
    workerId: task.workerId || 'local',
    ...settings,
    status: 'queued',
    sessionId: prior?.sessionId || null,
    createdAt: now(),
    updatedAt: now(),
    error: null,
    prompt: (() => {
      const last = list('run', owner)
        .filter((r) => r.taskId === taskId)
        .at(-1);
      // A turn cut off by a restart before its session started left no session holding its
      // request, so the next turn carries the shared conversation like an adapter switch does.
      const lostTurn = last?.recovery?.resolvedAt && !last.sessionId;
      if (last && (last.adapter !== adapter || lostTurn)) {
        const history = list('message', owner)
          .filter((m) => m.taskId === taskId && !m.shell)
          .slice(-20)
          .map((m) => m.role + ': ' + m.content)
          .join('\n')
          .slice(-40000);
        return (
          (last.adapter === adapter
            ? 'The previous turn was interrupted when the computer restarted. Task: '
            : 'Adapter handoff. Task: ') +
          task.title +
          '\nShared conversation:\n' +
          history +
          '\nCurrent user instruction:\n' +
          content
        );
      }
      const issue = task.issueId ? get('issue', owner, task.issueId) : null;
      return issue && !prior
        ? `Linked project issue #${issue.number}: ${issue.title}\n${issue.body}\n\nCurrent user instruction:\n${content}`
        : content;
    })(),
  };
  run.prompt += attachments
    .filter((a) => a.kind === 'video')
    .map((a) => '\n' + videoInputNote(a))
    .join('');
  const shellContext = shellPromptContext(owner, taskId);
  run.prompt += shellContext.text;
  save('run', owner, { ...run, shellVersions: shellContext.versions });
  for (const attachment of attachments)
    save('attachment', owner, { ...attachment, messageId: msg.id, runId: run.id });
  // A follow-up reopens a merged or done task: it is a conversation, not a closed ticket.
  save('task', owner, {
    ...task,
    status: 'running',
    ...(['merged', 'done'].includes(task.status) ? { closedAt: null } : {}),
    revision: task.revision + 1,
    updatedAt: now(),
  });
  event(owner, taskId, run.id, 'run.queued', run);
  return run;
}
export function stopRun(owner: string, taskId: string, input: any) {
  const task = get('task', owner, taskId);
  revise(task, input.revision);
  const restarted: string[] = [];
  let stoppedQueued = false;
  for (const run of list('run', owner).filter(
    (r) => r.taskId === taskId && ['queued', 'starting', 'running', 'unknown'].includes(r.status),
  )) {
    save('run', owner, {
      ...run,
      stopRequested: true,
      ...(run.status === 'queued' ? { status: 'interrupted', updatedAt: now() } : {}),
    });
    if (run.status === 'queued') {
      stoppedQueued = true;
      event(owner, taskId, run.id, 'run.interrupted', { status: 'interrupted' });
    }
    event(owner, taskId, run.id, 'run.stopRequested', {});
    if (run.status === 'unknown') restarted.push(run.id);
  }
  for (const job of list('job', owner).filter(
    (j) => j.taskId === taskId && ['queued', 'running'].includes(j.status),
  )) {
    save('job', owner, {
      ...job,
      stopRequested: true,
      status: job.status === 'queued' ? 'cancelled' : job.status,
      ...(job.status === 'queued' ? { finishedAt: now() } : {}),
      updatedAt: now(),
    });
    event(owner, taskId, job.runId, 'job.cancel_requested', {
      jobId: job.id,
      workerId: job.workerId,
    });
  }
  const check = activeCheck(owner, taskId);
  if (check) {
    save('check', owner, { ...check, stopRequested: true });
    event(owner, taskId, null, 'check.stopRequested', { id: check.id });
  }
  const stillActive = list('run', owner).some(
    (r) => r.taskId === taskId && ['starting', 'running', 'unknown'].includes(r.status),
  );
  save('task', owner, {
    ...task,
    ...(!stillActive && !check ? { status: 'review' } : {}),
    revision: task.revision + 1,
    updatedAt: now(),
  });
  if (stoppedQueued) releaseQueuedMessage(owner, taskId, 'interrupted');
  // A run left by a restart frees the task now if its worker has already shown it is gone.
  for (const runId of restarted) stopRestartedRun(owner, get('run', owner, runId));
  return get('task', owner, taskId);
}
/** Close a finished task ("done") or reopen it for review. Active work must stop first. */
export function setTaskOutcome(
  owner: string,
  taskId: string,
  action: 'close' | 'reopen',
  input: any,
) {
  const task = get('task', owner, taskId);
  revise(task, input.revision);
  if (
    list('run', owner).some(
      (r) => r.taskId === taskId && ['queued', 'starting', 'running', 'unknown'].includes(r.status),
    ) ||
    activeCheck(owner, taskId)
  )
    throw Object.assign(new Error('Stop the task before closing it'), { status: 409 });
  if (action === 'close') cancelTaskQuestions(owner, taskId);
  const status = action === 'close' ? 'done' : 'review';
  if (task.status === status) return task;
  const saved = save('task', owner, {
    ...task,
    status,
    closedAt: action === 'close' ? now() : null,
    revision: task.revision + 1,
    updatedAt: now(),
  });
  event(owner, taskId, null, action === 'close' ? 'task.closed' : 'task.reopened', { status });
  if (action === 'close') cleanupTaskCheckpointRefs(owner, taskId);
  return saved;
}
export function diff(owner: string, taskId: string) {
  const task = get('task', owner, taskId);
  const snapshot = taskDiff(owner, taskId);
  const digest = patchDigest(task.baseRevision, snapshot.patch || '');
  // Complete matching patches are authoritative even when the task workspace is still dirty
  // after publication. For incomplete/old worker reports, Git status must override false.
  const completeMatch =
    !snapshot.truncated &&
    (!snapshot.excluded?.length || snapshot.excluded.every(privateReviewPath)) &&
    digest === task.publishedPatchDigest;
  const dirty =
    snapshot.files?.some((file: any) => /[?MADRCUT!]/.test(file.status || '')) ||
    /^(?:\?\?|[ MADRCUT!]{2}) .+/m.test(snapshot.status || '');
  return {
    ...snapshot,
    hasUnpublishedChanges: completeMatch
      ? false
      : dirty
        ? true
        : snapshot.baselinePending
          ? null
          : !!snapshot.patch && digest !== task.publishedPatchDigest,
  };
}
/** Until the task computer installs a new baseline (after deploy_commit or a merge), its old
 * report would count already-committed work; say what is known from the latest checkpoint. */
function pendingNote(owner: string, task: any) {
  const merged = task.workspaceCommit?.pullId
    ? list('pull-request', owner).find((pull) => pull.id === task.workspaceCommit.pullId)
    : null;
  const since = merged ? `#${merged.number} merged` : 'the last commit';
  const checkpoint = latestCheckpointSummary(owner, task.id);
  const count = checkpoint?.fresh ? checkpoint.changedFileCount : null;
  return (
    `The task computer has not uploaded changes since ${since}; they appear after its next turn.` +
    (typeof count === 'number'
      ? ` The latest checkpoint changes ${count} ${count === 1 ? 'file' : 'files'} since ${since}.`
      : '')
  );
}
function taskDiff(owner: string, taskId: string): any {
  const t = get('task', owner, taskId);
  if (t.workspaceStatus && t.workspaceStatus !== 'ready')
    return {
      baseRevision: t.baseRevision,
      headRevision: t.baseRevision,
      patch: '',
      files: [],
      excluded: [],
      checks: [],
      status: 'Workspace ' + t.workspaceStatus,
    };
  if (t.workerId && t.workerId !== 'local') {
    try {
      const snapshot = get('remote-diff', owner, taskId);
      if (t.workspaceCommit && snapshot.headRevision !== t.workspaceCommit.commit)
        return {
          baseRevision: t.baseRevision,
          headRevision: t.workspaceCommit.commit,
          patch: '',
          files: [],
          checks: [],
          baselinePending: true,
          status:
            'Remote workspace changes have not been uploaded since the commit; waiting for the worker to refresh',
          note: pendingNote(owner, t),
        };
      return snapshot;
    } catch {
      return {
        baseRevision: t.baseRevision,
        headRevision: t.baseRevision,
        patch: '',
        status: 'Remote workspace changes have not been uploaded',
        baselinePending: Boolean(t.workspaceCommit),
        files: [],
        checks: [],
      };
    }
  }
  return {
    ...inspectWorkspace(t.workspacePath, t.baseRevision),
    checks: list('check', owner).filter((c) => c.taskId === taskId),
  };
}
export type PatchScope = 'all' | 'turn';
/** The checkpoints "This turn" compares, or null when the scope falls back to all changes. */
function turnRange(owner: string, taskId: string) {
  const runs = list('run', owner).filter((r) => r.taskId === taskId);
  const latest = runs.at(-1);
  if (!latest) return null;
  const from = latest.startCheckpoint || runs.at(-2)?.checkpoint;
  return from ? { runId: latest.id, from, to: latest.checkpoint || null } : null;
}
/** Only the workspace this process owns may be read with Git; see task-files.ts for why. */
const ownWorkspace = (task: any) =>
  (!task.workerId || task.workerId === 'local') &&
  (!task.workspaceStatus || task.workspaceStatus === 'ready')
    ? task.workspacePath
    : null;
const computerName = (owner: string, workerId: string) => {
  try {
    return get('worker', owner, workerId).name || workerId;
  } catch {
    return workerId;
  }
};
/**
 * The per-file patches a task computer uploaded with its turn. They are only served alongside
 * the snapshot they were captured with, so a refreshed baseline never shows stale patches.
 */
function uploadedPatches(owner: string, task: any, scope: PatchScope): FilePatch[] | null {
  try {
    if (scope === 'turn') {
      const runId = turnRange(owner, task.id)?.runId;
      return runId ? get('remote-turn-diff-files', owner, runId).patches : null;
    }
    const bundle = get('remote-diff-files', owner, task.id);
    return bundle.receivedAt === get('remote-diff', owner, task.id).receivedAt
      ? bundle.patches
      : null;
  } catch {
    return null;
  }
}
const uploadPending = (owner: string, task: any) =>
  `The full patch is on ${computerName(owner, task.workerId)}; it uploads when the next turn ends.`;

export interface TaskFilePatch extends FilePatch {
  scope: PatchScope;
  /** Why no patch is available here, when the coordinator cannot produce one. */
  omitted?: string;
}
/** One changed file's complete patch, loaded on demand by the Changes view. */
export function taskFilePatch(
  owner: string,
  taskId: string,
  path: string,
  scope: PatchScope,
): TaskFilePatch {
  const task = get('task', owner, taskId);
  const file = reviewFilePath(path);
  const unavailable = (omitted: string): TaskFilePatch => ({
    path: file,
    patch: '',
    bytes: 0,
    truncated: false,
    scope,
    omitted,
  });
  const workspace = ownWorkspace(task);
  if (workspace)
    try {
      if (scope !== 'turn')
        return { ...workspaceFilePatch(workspace, task.baseRevision, file), scope };
      const range = turnRange(owner, taskId);
      if (!range) return unavailable('This turn has no checkpoint to compare.');
      const to = range.to || captureTurnCheckpoint(workspace);
      return { ...turnFilePatch(workspace, range.from, to, file), scope };
    } catch (error: any) {
      return unavailable(error.message);
    }
  const patches = uploadedPatches(owner, task, scope);
  if (!patches) return unavailable(uploadPending(owner, task));
  const found = patches.find((patch) => patch.path === file);
  return found
    ? { ...found, scope }
    : unavailable(
        `${computerName(owner, task.workerId)} uploaded no patch for this file; open it in the file viewer.`,
      );
}

export interface TaskPatchDownload {
  patch: string;
  truncated: boolean;
  bytes: number;
  scope: PatchScope;
  /** Suggested download file name. */
  name: string;
  excluded?: string[];
  omitted?: string;
}
/** The whole change as one patch file, for "Download patch". */
export function taskPatch(owner: string, taskId: string, scope: PatchScope): TaskPatchDownload {
  const task = get('task', owner, taskId);
  const workspace = ownWorkspace(task);
  const title = (task.title || 'task').replace(/[^\w.-]+/g, '-').slice(0, 60) || 'task';
  const whole = (result: {
    patch?: string;
    truncated?: boolean;
    excluded?: string[];
    omitted?: string;
  }): TaskPatchDownload => ({
    ...result,
    patch: result.patch || '',
    truncated: Boolean(result.truncated),
    bytes: Buffer.byteLength(result.patch || ''),
    scope,
    name: `${title}-${taskId.slice(0, 8)}${scope === 'turn' ? '-turn' : ''}.patch`,
  });
  if (workspace)
    try {
      if (scope !== 'turn') return whole(workspacePatch(workspace, task.baseRevision));
      const range = turnRange(owner, taskId);
      if (!range) return whole({ omitted: 'This turn has no checkpoint to compare.' });
      const to = range.to || captureTurnCheckpoint(workspace);
      return whole(diffTurnCheckpoints(workspace, range.from, to, fullPatchLimit));
    } catch (error: any) {
      return whole({ truncated: true, omitted: error.message });
    }
  const patches = uploadedPatches(owner, task, scope);
  if (patches) return whole(joinFilePatches(patches));
  // Fall back to the summary patch so a download still produces what the coordinator knows.
  const snapshot = scope === 'turn' ? turnDiff(owner, taskId) : diff(owner, taskId);
  return whole({ patch: snapshot.patch, truncated: true, omitted: uploadPending(owner, task) });
}

/**
 * What the latest turn changed: its start checkpoint (or the previous turn's end checkpoint)
 * against its end checkpoint, or the live workspace while a local turn is still running.
 * Without real checkpoints this returns all changes and says why.
 */
export function turnDiff(owner: string, taskId: string) {
  const t = get('task', owner, taskId);
  const all = (note: string) => ({ ...diff(owner, taskId), scope: 'all', note });
  if (t.workspaceStatus && t.workspaceStatus !== 'ready') return all('');
  const runs = list('run', owner).filter((r) => r.taskId === taskId);
  const latest = runs.at(-1);
  if (!latest) return all('No turns yet, so this shows all changes.');
  const from = turnRange(owner, taskId)?.from;
  if (!from)
    return all(
      runs.length === 1
        ? 'This is the first turn, so this shows all changes.'
        : 'No earlier checkpoint exists for this turn, so this shows all changes.',
    );
  const checks = list('check', owner).filter((c) => c.taskId === taskId);
  if (t.workerId && t.workerId !== 'local') {
    if (['queued', 'starting', 'running'].includes(latest.status))
      return all('This turn’s changes appear when it ends. Showing all uploaded changes.');
    try {
      const stored = get('remote-turn-diff', owner, latest.id);
      return { ...stored, checks, scope: 'turn', runId: latest.id, note: '' };
    } catch {
      return all(
        'The task computer did not upload a checkpoint for this turn, so this shows all changes.',
      );
    }
  }
  try {
    const to = latest.checkpoint || captureTurnCheckpoint(t.workspacePath);
    return {
      ...diffTurnCheckpoints(t.workspacePath, from, to),
      checks,
      scope: 'turn',
      runId: latest.id,
      note: '',
    };
  } catch {
    return all('The earlier checkpoint is no longer available, so this shows all changes.');
  }
}
/**
 * Whether an agent CLI is installed. `/state` is polled for as long as a dashboard is open, so
 * it answers from a cache and refreshes in the background: the answer only changes when someone
 * installs or updates a CLI. Only the first call after a restart spawns a process inline, and
 * that one is bounded so a wedged binary cannot hold up the first load of a task.
 */
const cliProbes = new Map<string, { installed: boolean; at: number; refreshing: boolean }>();
const cliProbeInterval = 60000;
function cliInstalled(binary: string) {
  const probe = cliProbes.get(binary);
  if (!probe) {
    const installed =
      spawnSync(binary, ['--version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
    cliProbes.set(binary, { installed, at: Date.now(), refreshing: false });
    return installed;
  }
  if (!probe.refreshing && Date.now() - probe.at >= cliProbeInterval) {
    probe.refreshing = true;
    execFile(binary, ['--version'], { timeout: 5000 }, (error) => {
      probe.installed = !error;
      probe.at = Date.now();
      probe.refreshing = false;
    });
  }
  return probe.installed;
}
export function capabilities(owner?: string) {
  const available = cliInstalled('codex');
  const workers = computers(owner || '');
  return {
    workers: workers.map((worker) =>
      worker.id === 'local'
        ? {
            ...worker,
            ...workerLoad(owner || '', worker.id),
            modelOptions: modelOptions(),
            providers: providerUsage(),
            capabilities: [...worker.capabilities, ...(available ? ['codex'] : [])],
          }
        : { ...worker, ...workerLoad(owner || '', worker.id) },
    ),
    adapters: [
      {
        id: 'claude',
        name: 'Claude Code',
        available: cliInstalled(process.env.DEPLOY_CLAUDE_BIN || 'claude'),
        capabilities: {
          resume: true,
          cancellation: true,
          questions: true,
          steering: false,
          permissions: false,
          browser: false,
          computer: false,
        },
        billingMode: 'worker-account (quota unknown)',
      },
      {
        id: 'compatible',
        name: 'Compatible model endpoint',
        available: Boolean(
          process.env.DEPLOY_MODEL_BASE_URL && process.env.DEPLOY_MODEL_BILLING_MODE,
        ),
        capabilities: {
          resume: true,
          cancellation: true,
          questions: true,
          steering: false,
          permissions: false,
          browser: false,
          computer: false,
        },
        billingMode: process.env.DEPLOY_MODEL_BILLING_MODE || 'not configured',
      },
      {
        id: 'codex',
        name: 'Codex CLI',
        available,
        capabilities: {
          resume: true,
          cancellation: true,
          questions: true,
          steering: false,
          permissions: false,
          browser: false,
          computer: false,
        },
        billingMode: 'worker-account (quota unknown)',
      },
    ],
  };
}
