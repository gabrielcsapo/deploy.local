import { computerView } from './computer-view.ts';
import { packageHooks } from './package-hooks.ts';
import { terminalRelay } from './terminal-service.ts';
import { workerUpdate } from './worker-update.ts';
import { coordinatorDockerReachable } from '../metrics-collector.ts';
import { computerRoles } from '../computer-roles.ts';
import { getNodes, getComputerRolePreferences, ensureCoordinatorNode } from '../store.ts';
import { workerComputerId } from './computer-role-policy.ts';
import { workerRole } from './computer-roles.ts';
import { workerCapabilities } from './worker-capabilities.ts';
import { jobRequirements, eligibleForJob } from './job-placement.ts';
import { createHash, randomBytes } from 'node:crypto';
import { hostname, platform, arch } from 'node:os';
import {
  db,
  get,
  list,
  jobOutput,
  save,
  remove,
  event,
  id,
  now,
  command,
  commandReplay,
  getCheckpointMetadata,
  checkpointInfo,
} from './store.ts';
import { nodePermissions } from './node-permissions.ts';
import { suspendWorkerSessions } from './interactive.ts';
import { validateSnapshot, type Snapshot } from './checkpoint.ts';
import { gitSync } from './repository-git.ts';
import {
  artifactRequests,
  jobArtifactCapability,
  skippedArtifacts,
  type ArtifactRequest,
} from './job-artifact-spec.ts';

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
// Every heartbeat lives in the database, so a coordinator restart leaves them all stale until
// each worker registers again — about a second for a reachable one, longer for a computer that
// has to retry. During that window a stale heartbeat means "has not reported yet", which is not
// the same as offline, and the dashboard says "Reconnecting…" rather than claiming the computer
// is gone. Past the window silence really is offline.
const coordinatorStartedAt = Date.now();
const reconnectWindow = 15000;
// Passive heartbeat ageing (including capture availability) may lag by at most one second.
export const COMPUTERS_CADENCE_MS = 1_000;
const computersView = computerView(computeComputers, COMPUTERS_CADENCE_MS);
export const computers = computersView.read;
function computeComputers(owner: string) {
  const local = db.prepare("SELECT heartbeat FROM worker WHERE id='local'").get() as any;
  // A revoked worker keeps its record for task history, but is no longer a computer.
  const remote = list('worker', owner).filter((worker) => !worker.revokedAt);
  const controls = new Map(list('interactive-worker', owner).map((worker) => [worker.id, worker]));
  const managed = new Set(list('managed-worker', owner).map((record) => record.id));
  const browserProjects = list('project', owner)
    .filter((project) => project.autoApproveTaskBrowser === true)
    .map((project) => String(project.name));
  const workers = [
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
  ].map((w) => {
    const control = controls.get(w.id);
    const fresh = !!control && Date.now() - Date.parse(control.heartbeat) < 8000;
    const reported = w.heartbeat ? Date.parse(w.heartbeat) : 0;
    const status = reported && Date.now() - reported < 10000 ? 'online' : 'offline';
    const reportedSinceRestart = reported >= coordinatorStartedAt;
    return {
      ...w,
      reconnecting:
        status === 'offline' &&
        !reportedSinceRestart &&
        Date.now() - coordinatorStartedAt < reconnectWindow,
      update: workerUpdate(w),
      desktopCapture: (() => {
        const desktop = control?.targets?.find(
          (target: any) => target.id === 'desktop' && target.desktopStatus,
        )?.desktopStatus;
        if (!desktop) return undefined;
        return fresh
          ? desktop
          : { ...desktop, available: false, reason: 'Desktop capture inventory is offline' };
      })(),
      status,
      managed: managed.has(w.id),
      controlKinds: (control?.targets || []).map((target: any) => target.kind),
      nodeCapabilities: control?.nodeCapabilities || w.nodeCapabilities,
      permissions: nodePermissions({
        worker: { id: w.id, name: w.name, platform: w.platform, status },
        managed: managed.has(w.id),
        targets: control?.targets || [],
        fresh,
        browserProjects,
        nodeCapabilities: control?.nodeCapabilities,
      }),
    };
  });
  const nodes = roleNodes();
  const ids = [
    ...nodes.map((node) => node.id),
    ...workers.map((w) => workerComputerId(owner, w.id)),
  ];
  const roles = computerRoles(
    nodes,
    workers,
    Object.fromEntries(ids.map((id) => [id, getComputerRolePreferences(id)])),
  );
  return workers.map((worker) => ({
    ...worker,
    computerId: workerComputerId(owner, worker.id),
    roles: roles.find((computer) => computer.workerIds.includes(worker.id))?.roles,
  }));
}
/** Takes a remote task worker's credential away. Grants happen on the computer; this only removes. */
export function revokeWorker(owner: string, workerId: string) {
  if (workerId === 'local') throw new Error('The coordinator’s own worker can’t be revoked');
  if (list('managed-worker', owner).some((record) => record.id === workerId))
    throw new Error('Turn the managed worker off in Settings instead');
  const worker = get('worker', owner, workerId);
  remove('worker-credential', owner, workerId);
  packageHooks.revokeComputer(owner, workerComputerId(owner, workerId));
  remove('terminal-permission', owner, workerId);
  terminalRelay.disable(owner, workerId);
  remove('interactive-worker', owner, workerId);
  suspendWorkerSessions(owner, workerId, 'The computer’s access was revoked');
  return save('worker', owner, { ...worker, revokedAt: now() });
}
/**
 * A checkpoint that only carries changes is useless without its base tree, so storing one
 * requires the coordinator to have that commit, and pins it under its own ref. The ref keeps
 * the base reachable for every later reader (jobs, deploys, commits and publication) even if
 * the task branch moves, and is derived from the operation so an identical retry reuses it.
 */
function retainCheckpointBase(owner: string, taskId: string, commit: string, operationId: string) {
  const task = get('task', owner, taskId);
  if (!task.projectId)
    throw new Error(
      'This conversation has no repository, so a checkpoint cannot be a delta over a commit',
    );
  const repository = get('project', owner, task.projectId).repositoryPath;
  if (gitSync(repository, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]) !== commit)
    throw new Error(
      `Checkpoint base commit ${commit} is not in this repository; refresh the task workspace and capture again`,
    );
  const ref = `refs/deploy/checkpoint/${createHash('sha256')
    .update(JSON.stringify([owner, operationId]))
    .digest('hex')}`;
  if (gitSync(repository, ['update-ref', ref, commit]) === null)
    throw new Error('Could not retain the checkpoint base commit; inspect the repository');
  return ref;
}
/** The agent's own naming of the change a checkpoint holds. A title has to fit a commit
 * subject and a pull request row, so it is one short line; the summary is the body. */
const checkpointSummaryLimit = 10000;
const checkpointTitleLimit = 72;
function checkpointNaming(args: any) {
  const text = (value: unknown, field: string, limit: number) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || !value.trim())
      throw new Error(`${field} must be a nonempty string`);
    if ([...value.trim()].length > limit)
      throw new Error(
        field === 'title'
          ? `title must be one imperative line of at most ${limit} characters; put the detail in summary`
          : `summary must be at most ${limit} characters`,
      );
    return value.trim();
  };
  if (typeof args.title === 'string' && /[\r\n]/.test(args.title))
    throw new Error('title must be one line; put the detail in summary');
  const title = text(args.title, 'title', checkpointTitleLimit);
  const summary = text(args.summary, 'summary', checkpointSummaryLimit);
  return { ...(title ? { title } : {}), ...(summary ? { summary } : {}) };
}
function scoped(scope: AgentScope, kind: string, recordId: string) {
  const row =
    kind === 'checkpoint'
      ? getCheckpointMetadata(scope.owner, recordId)
      : get(kind, scope.owner, recordId);
  if (row.taskId !== scope.taskId)
    throw Object.assign(new Error('Resource belongs to another task'), { status: 403 });
  return row;
}
const supportsArtifacts = (worker: any) =>
  Boolean(worker?.capabilities?.includes(jobArtifactCapability));
const updateArtifactWorkers =
  'Update deploy.local on that computer (the deploy.local Worker app on a Mac, the deploy.local node app on Linux) so it can return files, or run the job without artifacts and print a short summary instead.';
/** Jobs that request artifacts only run where the worker can upload them; say so up front. */
function assertArtifactSupport(owner: string, worker: any, requirements: any) {
  if (worker) {
    if (!supportsArtifacts(worker))
      throw new Error(
        `${worker.name || worker.id} runs an older deploy.local worker that cannot return job artifacts. ${updateArtifactWorkers}`,
      );
    return;
  }
  const eligible = computers(owner).filter((candidate) => eligibleForJob(candidate, requirements));
  if (eligible.length && !eligible.some(supportsArtifacts))
    throw new Error(
      `Every eligible computer (${eligible.map((candidate) => candidate.name || candidate.id).join(', ')}) runs an older deploy.local worker that cannot return job artifacts. ${updateArtifactWorkers}`,
    );
}
export function describeJob(owner: string, job: any) {
  if (!Object.hasOwn(job, 'output')) job = { ...job, output: jobOutput(owner, job.id) };
  if (job.status !== 'queued' || job.workerId) return job;
  const eligible = computers(owner).filter((worker) => eligibleForJob(worker, job.requirements));
  return {
    ...job,
    waitingReason: !eligible.length
      ? 'No online worker matches the required OS, architecture and capabilities'
      : job.artifactPaths?.length && !eligible.some(supportsArtifacts)
        ? 'Eligible computers need a deploy.local worker update before they can return artifacts'
        : 'Waiting for an eligible worker to claim this job',
  };
}
/** Job output a task detail carries: a live job keeps more of its tail than a finished one. */
export const TASK_DETAIL_JOB_OUTPUT_CHARS = 4_000;
export const TASK_DETAIL_ACTIVE_JOB_OUTPUT_CHARS = 16_000;

/**
 * A job as embedded in a task detail: the tail of its output, flagged with
 * `outputTruncated` when characters were left out. The stored job (and
 * `deploy_get_job`) keep the full 64,000-character output.
 */
export function jobSnapshot(job: any) {
  const output = String(job.output ?? '');
  const limit = terminal.includes(job.status)
    ? TASK_DETAIL_JOB_OUTPUT_CHARS
    : TASK_DETAIL_ACTIVE_JOB_OUTPUT_CHARS;
  if (output.length <= limit) return job;
  return { ...job, output: output.slice(-limit), outputTruncated: true };
}
/**
 * Jobs in one state, oldest first. Every worker polls once a second; reading only the queued or
 * running jobs keeps a poll from parsing every finished job's record and output each time.
 */
function jobsWithStatus(owner: string, status: string): any[] {
  return (
    db
      .prepare(
        "SELECT json_remove(data,'$.output') AS data FROM records WHERE kind='job' AND owner=? AND json_extract(data,'$.status')=? ORDER BY rowid",
      )
      .all(owner, status) as { data: string }[]
  ).map((row) => JSON.parse(row.data));
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
  // A delta checkpoint is validated and its base commit retained before the storage
  // transaction: Git work does not belong inside the writer lock, and an identical retry
  // replays the stored result without touching the repository again.
  let prepared: {
    snapshot: Snapshot;
    baseRef: string | null;
    naming: { title?: string; summary?: string };
  } | null = null;
  if (name === 'deploy_checkpoint') {
    const replay = commandReplay(owner, args.operationId, signature);
    if (replay.found) return replay.result;
    const naming = checkpointNaming(args);
    const snapshot = validateSnapshot(args.snapshot);
    prepared = {
      snapshot,
      naming,
      baseRef: snapshot.base
        ? retainCheckpointBase(owner, taskId, snapshot.base.commit, args.operationId)
        : null,
    };
  }
  return command(
    owner,
    args.operationId,
    () => {
      if (name === 'deploy_checkpoint') {
        const { snapshot, baseRef, naming } = prepared!;
        const checkpoint = save('checkpoint', owner, {
          id: id(),
          taskId,
          runId,
          projectId: get('task', owner, taskId).projectId,
          snapshot,
          ...naming,
          ...(baseRef ? { baseRef } : {}),
          createdAt: now(),
        });
        const result = {
          checkpointId: checkpoint.id,
          digest: snapshot.digest,
          fileCount: snapshot.files.length,
          excluded: snapshot.excluded,
          ...naming,
          ...(snapshot.base
            ? { base: snapshot.base.commit, deletedCount: snapshot.deleted?.length ?? 0 }
            : {}),
        };
        event(owner, taskId, runId, 'checkpoint.created', result);
        return result;
      }
      if (name === 'deploy_run_job') {
        const checkpoint = scoped(scope, 'checkpoint', args.checkpointId);
        const requirements = jobRequirements(args.requirements);
        const worker = args.workerId ? computers(owner).find((w) => w.id === args.workerId) : null;
        if (
          args.workerId &&
          (!worker ||
            !eligibleForJob(worker, requirements) ||
            !workerRole(owner, worker.id, 'take-tasks'))
        )
          throw new Error(
            'Choose an online computer with checkpoint-jobs capability matching the job requirements',
          );
        if (!args.workerId && !requirements)
          throw new Error('workerId or OS requirements are required');
        if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 16000)
          throw new Error('Command required (maximum 16000 characters)');
        if (
          args.label !== undefined &&
          (typeof args.label !== 'string' ||
            !args.label.trim() ||
            args.label.length > 80 ||
            Array.from(args.label as string).some(
              (character) =>
                character.charCodeAt(0) < 32 ||
                character.charCodeAt(0) === 127 ||
                '<>'.includes(character),
            ))
        )
          throw new Error('label must be plain text, 1–80 characters');
        const timeoutMs = args.timeoutMs ?? 120000;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 900000)
          throw new Error('timeoutMs must be 100–900000');
        const artifactPaths: ArtifactRequest[] = artifactRequests(args.artifacts);
        if (artifactPaths.length) assertArtifactSupport(owner, worker, requirements);
        const job = save('job', owner, {
          id: id(),
          taskId,
          runId,
          checkpointId: checkpoint.id,
          digest: checkpointInfo(checkpoint).digest,
          workerId: worker?.id ?? null,
          requirements,
          command: args.command,
          name: args.label?.trim(),
          timeoutMs,
          status: 'queued',
          output: '',
          truncated: false,
          ...(artifactPaths.length ? { artifactPaths, artifacts: [] } : {}),
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
          ...(job.status === 'queued' ? { finishedAt: now() } : {}),
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
  if (!job.pipelineId) {
    const checkpoint = get('checkpoint', owner, job.checkpointId);
    const snapshot = checkpoint.snapshot;
    if (!snapshot?.base?.commit) return { job, snapshot };
    // The job computer gets the base tree from the coordinator's Git, then applies the delta.
    const project = get('project', owner, get('task', owner, job.taskId).projectId);
    return {
      job,
      snapshot,
      base: {
        commit: snapshot.base.commit,
        ref: checkpoint.baseRef || snapshot.base.commit,
        location: workerId === 'local' ? project.repositoryPath : `/api/git/${project.id}`,
      },
    };
  }
  const pipeline = get('pipeline-run', owner, job.pipelineId);
  const project = get('project', owner, pipeline.projectId);
  return {
    job,
    repository: {
      location: workerId === 'local' ? project.repositoryPath : `/api/git/${project.id}`,
      commit: pipeline.commit,
      ref: pipeline.sourceRef,
    },
  };
}
export function jobCommand(owner: string, workerId: string, action: string, body: any): any {
  if (action === 'package-publish') {
    const job = get('job', owner, body.jobId);
    if (
      job.status !== 'running' ||
      job.workerId !== workerId ||
      job.generation !== body.generation ||
      job.instanceId !== body.instanceId
    )
      throw new Error('Stale job assignment');
    return packageHooks.publishConfig!(owner, job);
  }
  if (action === 'packages') {
    if (body.runId) {
      const run = get('run', owner, body.runId);
      const worker = get('worker', owner, workerId);
      if (
        !['starting', 'running'].includes(run.status) ||
        run.stopRequested ||
        run.workerId !== workerId ||
        run.generation !== body.generation ||
        run.assignedInstanceId !== body.instanceId ||
        worker.instanceId !== body.instanceId
      )
        throw new Error('Stale agent assignment');
      return packageHooks.installConfig(owner, workerId, get('task', owner, run.taskId).projectId);
    }
    const job = get('job', owner, body.jobId);
    if (
      job.status !== 'running' ||
      job.workerId !== workerId ||
      job.generation !== body.generation ||
      job.instanceId !== body.instanceId
    )
      throw new Error('Stale job assignment');
    const projectId = job.pipelineId
      ? get('pipeline-run', owner, job.pipelineId).projectId
      : get('task', owner, job.taskId).projectId;
    return packageHooks.installConfig(owner, workerId, projectId);
  }

  // Warm eligibility outside the claim transaction. Job/run rows themselves remain fresh.
  const pollingComputer =
    action === 'poll' ? computers(owner).find((candidate) => candidate.id === workerId) : undefined;
  return db
    .transaction(() => {
      if (workerId !== 'local') {
        const worker = get('worker', owner, workerId);
        if (worker.instanceId !== body.instanceId)
          throw new Error('Worker process identity changed');
      }
      if (action === 'poll') {
        // An old in-flight job is never reassigned automatically after a restart.
        for (const job of jobsWithStatus(owner, 'running').filter((j) => j.workerId === workerId)) {
          if (job.instanceId === body.instanceId) return jobAssignment(owner, workerId, job);
          save('job', owner, {
            ...job,
            status: 'unknown',
            finishedAt: now(),
            error: 'Worker restarted; previous execution was not replayed',
            updatedAt: now(),
          });
          event(owner, job.taskId, job.runId, 'job.unknown', { jobId: job.id, workerId });
        }
        if (!workerRole(owner, workerId, 'take-tasks')) return { job: null };
        const computer = pollingComputer;
        const pending = jobsWithStatus(owner, 'queued').find(
          (j) =>
            !j.stopRequested &&
            (j.workerId === workerId || (!j.workerId && j.requirements)) &&
            computer &&
            eligibleForJob({ ...computer, status: 'online' }, j.requirements) &&
            (!j.artifactPaths?.length || supportsArtifacts(computer)),
        );
        if (!pending) return { job: null };
        const job = save('job', owner, {
          ...pending,
          workerId,
          status: 'running',
          startedAt: now(),
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
        if (action === 'complete') {
          try {
            packageHooks.finishJob(job.id);
          } catch {
            /* Pin cleanup cannot turn a successful job into a failed publication. */
          }
        }
        const result = save('job', owner, {
          ...job,
          output: String(body.output || '').slice(-64000),
          truncated: Boolean(body.truncated),
          status: action === 'complete' ? body.status : job.status,
          ...(action === 'complete' ? { finishedAt: now() } : {}),
          exitCode: body.exitCode ?? null,
          error: body.error ? String(body.error).slice(0, 2000) : null,
          ...(action === 'complete' && job.artifactPaths?.length
            ? { artifacts: completedArtifacts(job, body) }
            : {}),
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
            ...(result.artifacts
              ? {
                  artifacts: result.artifacts.filter((entry: any) => entry.attachmentId).length,
                  skippedArtifacts: result.artifacts.filter((entry: any) => entry.skipped).length,
                }
              : {}),
          });
        return { stopRequested: Boolean(job.stopRequested), job: result };
      }
      throw new Error('Unknown job action');
    })
    .immediate();
}

/** Uploaded entries are coordinator-recorded; the worker only adds what it skipped and why. */
function completedArtifacts(job: any, body: any) {
  const stored = job.artifacts || [];
  if (!Array.isArray(body.skippedArtifacts))
    return [
      ...stored,
      ...(stored.length
        ? []
        : job.artifactPaths.map((request: ArtifactRequest) => ({
            path: request.path,
            name: request.path.split('/').at(-1),
            caption: request.caption || '',
            skipped:
              'The worker did not report artifacts; update deploy.local on this computer to return files',
          }))),
    ];
  return [...stored, ...skippedArtifacts(body.skippedArtifacts)];
}
export function allComputerRoles(owner: string) {
  ensureCoordinatorNode();
  const workers = computers(owner);
  const nodes = roleNodes();
  const ids = [
    ...nodes.map((node) => node.id),
    ...workers.map((w) => workerComputerId(owner, w.id)),
  ];
  return computerRoles(
    nodes,
    workers,
    Object.fromEntries(ids.map((id) => [id, getComputerRolePreferences(id)])),
  );
}

/** The coordinator row predates capability probes and claims Docker unconditionally. Use the
 * existing metrics probe as evidence instead; execution agents already report docker version. */
function roleNodes() {
  const reachable = coordinatorDockerReachable();
  return getNodes().map((node) =>
    node.kind === 'coordinator'
      ? {
          ...node,
          capabilities: JSON.stringify({
            docker: reachable === true,
            dockerError:
              reachable === null
                ? 'Docker reachability has not been checked yet.'
                : 'Docker is not reachable.',
          }),
        }
      : node,
  );
}
