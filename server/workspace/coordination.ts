import { workerCapabilities } from './worker-capabilities.ts';
import { jobRequirements, eligibleForJob } from './job-placement.ts';
import { createHash, randomBytes } from 'node:crypto';
import { hostname, platform, arch } from 'node:os';
import { db, get, list, save, event, id, now, command } from './store.ts';
import { validateSnapshot } from './checkpoint.ts';

export type AgentScope = { owner: string; taskId: string; runId: string };
const live = ['starting', 'running'];
const terminal = ['succeeded', 'failed', 'cancelled', 'timed_out', 'unknown'];
export function issueAgentToken(scope: AgentScope) {
  const token = randomBytes(32).toString('hex');
  save('agent-credential', scope.owner, {
    id: createHash('sha256').update(token).digest('hex'),
    taskId: scope.taskId,
    runId: scope.runId,
    expiresAt: Date.now() + 24 * 3600000,
  });
  return token;
}
export function authenticateAgent(token: string): AgentScope | null {
  if (!token || token.length > 200) return null;
  const row = db
    .prepare("SELECT owner,data FROM records WHERE kind='agent-credential' AND id=?")
    .get(createHash('sha256').update(token).digest('hex')) as any;
  if (!row) return null;
  const credential = JSON.parse(row.data),
    run = get('run', row.owner, credential.runId);
  if (credential.expiresAt < Date.now() || !live.includes(run.status) || run.stopRequested)
    return null;
  return { owner: row.owner, taskId: credential.taskId, runId: credential.runId };
}
export function computers(owner: string) {
  const local = db.prepare("SELECT heartbeat FROM worker WHERE id='local'").get() as any;
  const remote = list('worker', owner);
  return [
    ...(local || !remote.length
      ? [
          {
            id: 'local',
            name: hostname(),
            platform: platform(),
            architecture: arch(),
            heartbeat: local?.heartbeat,
            capabilities: (() => {
              const row = db
                .prepare(
                  "SELECT data FROM records WHERE kind='worker-inventory' AND owner='system' AND id='local'",
                )
                .get() as any;
              return row ? JSON.parse(row.data).capabilities : workerCapabilities();
            })(),
          },
        ]
      : []),
    ...remote,
  ].map((w) => ({
    ...w,
    status: w.heartbeat && Date.now() - Date.parse(w.heartbeat) < 10000 ? 'online' : 'offline',
  }));
}
function scoped(scope: AgentScope, kind: string, recordId: string) {
  const row = get(kind, scope.owner, recordId);
  if (row.taskId !== scope.taskId)
    throw Object.assign(new Error('Resource belongs to another task'), { status: 403 });
  return row;
}
export function describeJob(owner: string, job: any) {
  if (job.status !== 'queued' || job.workerId) return job;
  const eligible = computers(owner).some((worker) => eligibleForJob(worker, job.requirements));
  return {
    ...job,
    waitingReason: eligible
      ? 'Waiting for an eligible worker to claim this job'
      : 'No online worker matches the required OS, architecture and capabilities',
  };
}
export function coordinationTool(scope: AgentScope, name: string, args: any) {
  const { owner, taskId, runId } = scope;
  if (name === 'deploy_list_computers') return { computers: computers(owner) };
  if (name === 'deploy_get_job') return describeJob(owner, scoped(scope, 'job', args.jobId));
  if (name === 'deploy_list_jobs')
    return {
      jobs: list('job', owner)
        .filter((j) => j.taskId === taskId)
        .map((job) => describeJob(owner, job)),
    };
  if (typeof args.operationId !== 'string') throw new Error('operationId must be a string');
  // Idempotency is scoped to task + tool, with a body fingerprint to reject accidental reuse.
  const signature = createHash('sha256')
    .update(JSON.stringify({ taskId, name, args }))
    .digest('hex');
  return command(
    owner,
    args.operationId,
    () => {
      if (name === 'deploy_checkpoint') {
        const snapshot = validateSnapshot(args.snapshot);
        const checkpoint = save('checkpoint', owner, {
          id: id(),
          taskId,
          runId,
          snapshot,
          createdAt: now(),
        });
        const result = {
          checkpointId: checkpoint.id,
          digest: snapshot.digest,
          fileCount: snapshot.files.length,
          excluded: snapshot.excluded,
        };
        event(owner, taskId, runId, 'checkpoint.created', result);
        return result;
      }
      if (name === 'deploy_run_job') {
        const checkpoint = scoped(scope, 'checkpoint', args.checkpointId);
        const requirements = jobRequirements(args.requirements);
        const worker = args.workerId ? computers(owner).find((w) => w.id === args.workerId) : null;
        if (args.workerId && (!worker || !eligibleForJob(worker, requirements)))
          throw new Error(
            'Choose an online computer with checkpoint-jobs capability matching the job requirements',
          );
        if (!args.workerId && !requirements)
          throw new Error('workerId or OS requirements are required');
        if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 16000)
          throw new Error('Command required (maximum 16000 characters)');
        const timeoutMs = args.timeoutMs ?? 120000;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 900000)
          throw new Error('timeoutMs must be 100–900000');
        const job = save('job', owner, {
          id: id(),
          taskId,
          runId,
          checkpointId: checkpoint.id,
          digest: checkpoint.snapshot.digest,
          workerId: worker?.id ?? null,
          requirements,
          command: args.command,
          timeoutMs,
          status: 'queued',
          output: '',
          truncated: false,
          createdAt: now(),
          updatedAt: now(),
        });
        event(owner, taskId, runId, 'job.queued', job);
        return describeJob(owner, job);
      }
      if (name === 'deploy_cancel_job') {
        const job = scoped(scope, 'job', args.jobId);
        if (terminal.includes(job.status)) return job;
        const result = save('job', owner, {
          ...job,
          stopRequested: true,
          status: job.status === 'queued' ? 'cancelled' : job.status,
          updatedAt: now(),
        });
        event(owner, taskId, runId, 'job.cancel_requested', {
          jobId: job.id,
          workerId: job.workerId,
        });
        return result;
      }
      throw new Error('Unknown coordination tool');
    },
    signature,
  );
}

function jobAssignment(owner: string, workerId: string, job: any) {
  if (!job.pipelineId)
    return { job, snapshot: get('checkpoint', owner, job.checkpointId).snapshot };
  const pipeline = get('pipeline-run', owner, job.pipelineId);
  const project = get('project', owner, pipeline.projectId);
  return {
    job,
    repository: {
      location: workerId === 'local' ? project.repositoryPath : `/api/workspace/git/${project.id}`,
      commit: pipeline.commit,
      ref: pipeline.sourceRef,
    },
  };
}
export function jobCommand(owner: string, workerId: string, action: string, body: any) {
  return db
    .transaction(() => {
      if (workerId !== 'local') {
        const worker = get('worker', owner, workerId);
        if (worker.instanceId !== body.instanceId)
          throw new Error('Worker process identity changed');
      }
      if (action === 'poll') {
        // An old in-flight job is never reassigned automatically after a restart.
        for (const job of list('job', owner).filter(
          (j) => j.workerId === workerId && j.status === 'running',
        )) {
          if (job.instanceId === body.instanceId) return jobAssignment(owner, workerId, job);
          save('job', owner, {
            ...job,
            status: 'unknown',
            error: 'Worker restarted; previous execution was not replayed',
            updatedAt: now(),
          });
          event(owner, job.taskId, job.runId, 'job.unknown', { jobId: job.id, workerId });
        }
        const computer = computers(owner).find((candidate) => candidate.id === workerId);
        const pending = list('job', owner).find(
          (j) =>
            j.status === 'queued' &&
            !j.stopRequested &&
            (j.workerId === workerId || (!j.workerId && j.requirements)) &&
            computer &&
            eligibleForJob(computer, j.requirements),
        );
        if (!pending) return { job: null };
        const job = save('job', owner, {
          ...pending,
          workerId,
          status: 'running',
          generation: id(),
          instanceId: body.instanceId,
          updatedAt: now(),
        });
        event(owner, job.taskId, job.runId, 'job.running', {
          jobId: job.id,
          workerId,
          digest: job.digest,
        });
        return jobAssignment(owner, workerId, job);
      }
      const job = get('job', owner, body.jobId);
      if (
        job.workerId !== workerId ||
        job.generation !== body.generation ||
        job.instanceId !== body.instanceId
      )
        throw new Error('Stale job assignment');
      if (terminal.includes(job.status)) return { stopRequested: true, job };
      if (action === 'update' || action === 'complete') {
        if (action === 'complete' && !terminal.includes(body.status))
          throw new Error('Invalid job terminal status');
        const result = save('job', owner, {
          ...job,
          output: String(body.output || '').slice(-64000),
          truncated: Boolean(body.truncated),
          status: action === 'complete' ? body.status : job.status,
          exitCode: body.exitCode ?? null,
          error: body.error ? String(body.error).slice(0, 2000) : null,
          updatedAt: now(),
        });
        if (action === 'update' && result.output !== job.output)
          event(owner, job.taskId, job.runId, 'job.progress', { jobId: job.id, workerId });
        if (action === 'complete')
          event(owner, job.taskId, job.runId, 'job.' + result.status, {
            jobId: job.id,
            workerId,
            digest: job.digest,
            exitCode: result.exitCode,
            error: result.error,
          });
        return { stopRequested: Boolean(job.stopRequested), job: result };
      }
      throw new Error('Unknown job action');
    })
    .immediate();
}
