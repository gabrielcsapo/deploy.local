import { sanitizeProviderUsage } from './provider-usage.ts';
import { db, get, list, save, event, id, now } from './store.ts';
import { checkpointId } from './turn-checkpoint.ts';
import { releaseQueuedMessage } from './queued-message.ts';
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
    return save('worker', owner, {
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
              ['node', 'docker', 'swift', 'xcode', 'python', 'git-lfs'].includes(String(c)),
            )
          : []),
        ...(body.codex ? ['codex'] : []),
        ...(body.claude ? ['claude'] : []),
        ...(body.compatible ? ['compatible'] : []),
        ...(body.checkpointJobs && ['linux', 'darwin'].includes(body.platform)
          ? ['checkpoint-jobs']
          : []),
      ],
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
      heartbeat: now(),
      status: 'online',
    });
  }
  const m = path.match(/^\/workers\/([^/]+)\/(poll|events|complete)$/);
  if (!m) return undefined;
  const worker = get('worker', owner, m[1]);
  if (worker.instanceId && worker.instanceId !== String(body.instanceId || worker.id))
    throw Object.assign(new Error('Worker process identity changed'), { status: 409 });
  save('worker', owner, { ...worker, heartbeat: now() });
  if (m[2] === 'poll')
    return db.transaction(() => {
      const current = list('run', owner).find(
        (r) => r.workerId === worker.id && ['starting', 'running', 'unknown'].includes(r.status),
      );
      if (current)
        return {
          run: current,
          task: get('task', owner, current.taskId),
          project: get('task', owner, current.taskId).projectId
            ? get('project', owner, get('task', owner, current.taskId).projectId)
            : null,
        };
      const run = list('run', owner).find(
        (r) =>
          r.workerId === worker.id &&
          r.status === 'queued' &&
          (!get('task', owner, r.taskId).workspaceStatus ||
            get('task', owner, r.taskId).workspaceStatus === 'ready'),
      );
      if (!run) return { run: null };
      const claimed = {
        ...run,
        status: 'starting',
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
        project: task.projectId ? get('project', owner, task.projectId) : null,
      };
    })();
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
        updatedAt: now(),
      });
      return { acknowledgedSequence: ack, stopRequested: Boolean(run.stopRequested) };
    })();
  if (m[2] === 'complete')
    return db.transaction(() => {
      if (['succeeded', 'failed', 'interrupted'].includes(run.status)) return run;
      if (!['succeeded', 'failed', 'interrupted', 'unknown'].includes(body.status))
        throw new Error('Invalid terminal status');
      const result = save('run', owner, {
        ...run,
        status: body.status,
        error: body.error || null,
        sessionId: body.sessionId || run.sessionId,
        startCheckpoint: checkpointId(body.startCheckpoint),
        checkpoint: checkpointId(body.checkpoint),
        updatedAt: now(),
      });
      const task = get('task', owner, run.taskId);
      save('task', owner, {
        ...task,
        status:
          body.status === 'unknown' ? 'blocked' : body.status === 'failed' ? 'failed' : 'review',
        revision: task.revision + 1,
        updatedAt: now(),
        remoteWorkspacePath: body.workspacePath || null,
      });
      if (body.diff)
        save('remote-diff', owner, {
          ...body.diff,
          id: task.id,
          taskId: task.id,
          workerId: worker.id,
          receivedAt: now(),
        });
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
      event(owner, task.id, run.id, `run.${body.status}`, {
        status: body.status,
        error: body.error || null,
      });
      releaseQueuedMessage(owner, task.id, body.status);
      return result;
    })();
}
