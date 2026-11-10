import { pendingToolProbes, recordToolAnswers } from './tool-probes.ts';
import { resumeQuestionAnswers } from './questions.ts';
import { workerBuildReport } from './worker-update.ts';
import { runAgentContext } from './agent-context-store.ts';
import { parseNodeCapabilities } from './node-permissions.ts';
import { getNodes } from '../store.ts';
import { workerRole } from './computer-roles.ts';
import { sanitizeProviderUsage } from './provider-usage.ts';
import { db, get, list, save, event, id, now, remove } from './store.ts';
import { checkpointId } from './turn-checkpoint.ts';
import { filePatchLimit, fullPatchLimit, reviewFilePath } from './review.ts';
import { releaseQueuedMessage } from './queued-message.ts';
import { reconcileStalePoll, unknownReport } from './run-recovery.ts';

/** Questions ride the reply only when there are some, so the reply is unchanged for everyone else. */
function withToolProbes<T extends object>(reply: T, toolProbes: string[]) {
  return toolProbes.length ? { ...reply, toolProbes } : reply;
}
/**
 * Per-file patches a task computer uploads with its turn, so the Changes view can load a file's
 * full patch even though the coordinator cannot read that computer's workspace. Worker reports
 * are data: each entry is checked and the bundle stays inside the same caps the worker applies.
 */
export function filePatchBundle(value: unknown) {
  if (!Array.isArray(value) || !value.length) return null;
  const patches: { path: string; patch: string; bytes: number; truncated: boolean }[] = [];
  let total = 0;
  for (const entry of value) {
    if (typeof entry?.path !== 'string' || typeof entry.patch !== 'string') continue;
    try {
      reviewFilePath(entry.path);
    } catch {
      continue;
    }
    const patch = entry.patch.slice(0, filePatchLimit);
    if (total + patch.length > fullPatchLimit) break;
    total += patch.length;
    patches.push({
      path: entry.path,
      patch,
      bytes: Number.isFinite(entry.bytes) ? Number(entry.bytes) : Buffer.byteLength(patch),
      truncated: Boolean(entry.truncated) || entry.patch.length > filePatchLimit,
    });
  }
  return patches.length ? patches : null;
}
// Explicit owner-authorized worker protocol. Assignment never moves automatically.
export function workerCommand(owner: string, path: string, body: any) {
  if (path === '/workers/register') {
    if (
      !body.workerId ||
      body.workerId === 'local' ||
      !String(body.workerId).match(/^[a-zA-Z0-9_-]{1,100}$/)
    )
      throw new Error('A unique non-local workerId is required');
    const instanceId = String(body.instanceId || body.workerId);
    const previous = list('worker', owner).find((w) => w.id === body.workerId);
    if (
      previous?.instanceId &&
      previous.instanceId !== instanceId &&
      Date.now() - Date.parse(previous.heartbeat) < 10000
    )
      throw Object.assign(new Error('Worker identity is already online in another process'), {
        status: 409,
      });
    recordToolAnswers(owner, body.workerId, body.toolAnswers);
    const registered = save('worker', owner, {
      ...workerBuildReport(body),
      instanceId,
      id: body.workerId,
      name: String(body.name || body.workerId),
      platform: String(body.platform || 'unknown'),
      architecture: String(body.architecture || 'unknown'),
      capabilities: [
        'git',
        'shell',
        ...(Array.isArray(body.capabilities)
          ? body.capabilities.filter((c: unknown) =>
              [
                'node',
                'docker',
                'swift',
                'xcode',
                'python',
                'git-lfs',
                'job-artifacts',
                'package-publish-v1',
                'terminal',
                'task-terminal',
              ].includes(String(c)),
            )
          : []),
        ...(body.codex ? ['codex'] : []),
        ...(body.claude ? ['claude'] : []),
        ...(body.compatible ? ['compatible'] : []),
        ...(body.checkpointJobs && ['linux', 'darwin'].includes(body.platform)
          ? ['checkpoint-jobs']
          : []),
      ],
      terminalDisabled: body.terminalDisabled === true,
      nodeCapabilities: parseNodeCapabilities(body.nodeCapabilities),
      modelOptions: Array.isArray(body.modelOptions) ? body.modelOptions : [],
      providers: sanitizeProviderUsage(body.providers),
      configurationFailed: body.configurationFailed === true,
      connections: Array.isArray(body.connections)
        ? body.connections
            .filter((value: any) => ['codex', 'claude', 'compatible'].includes(value.provider))
            .map((value: any) => ({
              provider: value.provider,
              available: value.available === true,
              enabled: value.enabled === true,
              mode: value.mode === 'api-key' ? 'api-key' : 'account',
              revision: String(value.revision || '').slice(0, 100),
              status: [
                'disabled',
                'not-installed',
                'configured',
                'signed-in',
                'signed-out',
              ].includes(value.status)
                ? value.status
                : 'unavailable',
            }))
        : [],
      version: typeof body.version === 'string' ? body.version.slice(0, 100) : undefined,
      screenSupported: body.screenSupported === true,
      // A second worker on an enrolled computer (the desktop app beside the CLI agent) names that
      // computer's node from its local agent config, so both show as one computer.
      nodeId: getNodes().find((node) => node.id === body.nodeId && !node.revokedAt)?.id,
      heartbeat: now(),
      status: 'online',
    });
    return withToolProbes(registered, pendingToolProbes(owner, body.workerId));
  }
  const m = path.match(/^\/workers\/([^/]+)\/(poll|events|complete)$/);
  if (!m) return undefined;
  const worker = get('worker', owner, m[1]);
  if (worker.instanceId && worker.instanceId !== String(body.instanceId || worker.id))
    throw Object.assign(new Error('Worker process identity changed'), { status: 409 });
  save('worker', owner, { ...worker, ...workerBuildReport(body), heartbeat: now() });
  if (m[2] === 'poll') {
    recordToolAnswers(owner, worker.id, body.toolAnswers);
    const assignment = db.transaction(() => {
      let current = list('run', owner).find(
        (r) => r.workerId === worker.id && ['starting', 'running', 'unknown'].includes(r.status),
      );
      // A different process of this worker polling for work means the one that started the run
      // is gone; newer workers also say explicitly that they hold no assignment state.
      if (
        current &&
        reconcileStalePoll(owner, current, worker.instanceId, body.noAssignment === true)
      )
        current = undefined;
      if (current)
        return {
          run: current,
          task: get('task', owner, current.taskId),
          project: get('task', owner, current.taskId).projectId
            ? get('project', owner, get('task', owner, current.taskId).projectId)
            : null,
        };
      if (!workerRole(owner, worker.id, 'take-tasks')) return { run: null };
      const run = list('run', owner).find(
        (r) =>
          r.workerId === worker.id &&
          r.status === 'queued' &&
          !r.stopRequested &&
          (!get('task', owner, r.taskId).workspaceStatus ||
            get('task', owner, r.taskId).workspaceStatus === 'ready'),
      );
      if (!run) return { run: null };
      const claimed = {
        ...run,
        status: 'starting',
        ...runAgentContext(owner, run),
        generation: id(),
        assignedInstanceId: worker.instanceId,
        acknowledgedSequence: 0,
        updatedAt: now(),
      };
      save('run', owner, claimed);
      event(owner, run.taskId, run.id, 'run.assigned', {
        workerId: worker.id,
        generation: claimed.generation,
      });
      const task = get('task', owner, run.taskId);
      return {
        run: claimed,
        task,
        ...(task.resumeCheckpointId
          ? {
              taskCheckpoint: get('checkpoint', owner, task.resumeCheckpointId).snapshot,
              taskCheckpointBaseRef: get('checkpoint', owner, task.resumeCheckpointId).baseRef,
            }
          : {}),
        project: task.projectId ? get('project', owner, task.projectId) : null,
      };
    })();
    return withToolProbes(assignment, pendingToolProbes(owner, worker.id));
  }
  const run = get('run', owner, body.runId);
  if (run.workerId !== worker.id || run.generation !== body.generation)
    throw Object.assign(new Error('Stale worker assignment'), { status: 409 });
  if (m[2] === 'events')
    return db.transaction(() => {
      let ack = run.acknowledgedSequence || 0;
      for (const entry of body.events || []) {
        if (entry.sequence <= ack) continue;
        if (entry.sequence !== ack + 1)
          throw Object.assign(new Error('Event sequence gap'), { status: 409 });
        event(owner, run.taskId, run.id, entry.type, entry.payload);
        if (entry.type === 'thread.started') run.sessionId = entry.payload.thread_id;
        if (entry.type === 'message') {
          const msg = {
            ...entry.payload,
            id: entry.payload.providerItemId
              ? `${run.id}:item:${entry.payload.providerItemId}`
              : `${run.id}:${entry.sequence}`,
            taskId: run.taskId,
            runId: run.id,
            createdAt: entry.payload.createdAt || now(),
          };
          save('message', owner, msg);
        }
        ack = entry.sequence;
      }
      save('run', owner, {
        ...run,
        status: run.status === 'starting' ? 'running' : run.status,
        acknowledgedSequence: ack,
        // A restarted run's duration ends where the restart was recorded.
        updatedAt: run.status === 'unknown' ? run.updatedAt : now(),
      });
      const task = get('task', owner, run.taskId);
      if (
        body.workspaceDiff &&
        task.workspaceCommit &&
        body.baselineCommit === task.workspaceCommit.commit
      )
        save('remote-diff', owner, {
          ...body.workspaceDiff,
          id: task.id,
          taskId: task.id,
          workerId: worker.id,
          receivedAt: now(),
        });
      return {
        acknowledgedSequence: ack,
        stopRequested: Boolean(run.stopRequested),
        ...(task.projectId &&
        (task.workspaceCommit ||
          list('repository-creation', owner).some((row) => row.id === task.projectId && row.result))
          ? { repositoryTask: task }
          : {}),
      };
    })();
  if (m[2] === 'complete')
    return db.transaction(() => {
      if (['succeeded', 'failed', 'interrupted'].includes(run.status)) return run;
      if (!['succeeded', 'failed', 'interrupted', 'unknown'].includes(body.status))
        throw new Error('Invalid terminal status');
      if (run.status === 'unknown') {
        // Only a restarted process of the run's worker can speak for a restart it survived.
        if (!worker.instanceId || worker.instanceId === run.assignedInstanceId)
          throw Object.assign(
            new Error('The process that started this run cannot resolve its restart'),
            { status: 409 },
          );
        // Repeated reports while the worker waits only refresh what it knows about the process.
        if (body.status === 'unknown')
          return save('run', owner, {
            ...run,
            recovery: { ...run.recovery, ...unknownReport(worker.instanceId, body.process) },
          });
        // The worker verified the previous agent's process group is gone.
        if (body.status !== 'interrupted')
          throw new Error('A restarted run can only be reported as interrupted');
      }
      const result = save('run', owner, {
        ...run,
        ...(body.status === 'unknown'
          ? { recovery: { ...run.recovery, ...unknownReport(worker.instanceId, body.process) } }
          : run.status === 'unknown' || (body.restarted === true && body.status === 'interrupted')
            ? {
                recovery: {
                  ...run.recovery,
                  method: 'worker-attested',
                  attestedBy: worker.instanceId,
                  resolvedAt: now(),
                  previousStatus: run.status,
                  previousError: run.error ?? null,
                },
              }
            : {}),
        status: body.status,
        error: body.error || null,
        sessionId: body.sessionId || run.sessionId,
        startCheckpoint: checkpointId(body.startCheckpoint),
        checkpoint: checkpointId(body.checkpoint),
        updatedAt: run.status === 'unknown' ? run.updatedAt : now(),
      });
      const task = get('task', owner, run.taskId);
      save('task', owner, {
        ...task,
        status: task.pendingPlacement
          ? 'waiting'
          : body.status === 'unknown'
            ? 'blocked'
            : body.status === 'failed'
              ? 'failed'
              : 'review',
        revision: task.revision + 1,
        updatedAt: now(),
        remoteWorkspacePath: body.workspacePath || null,
      });
      if (
        body.diff &&
        (!task.workspaceCommit || body.baselineCommit === task.workspaceCommit.commit)
      ) {
        const receivedAt = now();
        save('remote-diff', owner, {
          ...body.diff,
          id: task.id,
          taskId: task.id,
          workerId: worker.id,
          receivedAt,
        });
        // Per-file patches are matched to the snapshot they came with; a bundle the worker did
        // not send (older worker, or one that could not read the workspace) must not linger.
        const patches = filePatchBundle(body.filePatches);
        if (patches)
          save('remote-diff-files', owner, {
            id: task.id,
            taskId: task.id,
            workerId: worker.id,
            patches,
            receivedAt,
          });
        else remove('remote-diff-files', owner, task.id);
      }
      const turn = body.turnDiff;
      if (
        turn &&
        typeof turn.patch === 'string' &&
        Array.isArray(turn.files) &&
        checkpointId(turn.baseRevision) &&
        checkpointId(turn.headRevision)
      )
        save('remote-turn-diff', owner, {
          id: run.id,
          taskId: task.id,
          baseRevision: turn.baseRevision,
          headRevision: turn.headRevision,
          patch: turn.patch,
          truncated: Boolean(turn.truncated),
          status: String(turn.status || ''),
          files: turn.files
            .filter((f: any) => typeof f?.path === 'string' && typeof f?.status === 'string')
            .map((f: any) => ({ status: f.status.slice(0, 2), path: f.path })),
          excluded: [],
          receivedAt: now(),
        });
      const turnPatches = turn && filePatchBundle(body.turnFilePatches);
      if (turnPatches) {
        // Only the latest turn has a "This turn" scope to serve, so one bundle per task is kept.
        for (const previous of list('remote-turn-diff-files', owner))
          if (previous.taskId === task.id && previous.id !== run.id)
            remove('remote-turn-diff-files', owner, previous.id);
        save('remote-turn-diff-files', owner, {
          id: run.id,
          taskId: task.id,
          patches: turnPatches,
          receivedAt: now(),
        });
      }
      event(owner, task.id, run.id, `run.${body.status}`, {
        status: body.status,
        error: body.error || null,
      });
      releaseQueuedMessage(owner, task.id, body.status);
      resumeQuestionAnswers(owner, task.id, run.id);
      return result;
    })();
}
