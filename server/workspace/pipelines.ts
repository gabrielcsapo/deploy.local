import { createHash } from 'node:crypto';
import { compileDeployYaml } from '../application-spec.ts';
import { command, commandReplay, db, get, id, list, now, save } from './store.ts';
import { gitText } from './repository-git.ts';
import { requireRepository, resolveCommit } from './repositories.ts';
import { describeJob } from './coordination.ts';
const terminal = ['succeeded', 'failed', 'cancelled', 'skipped', 'timed_out'];
export async function pipelineStart(
  owner: string,
  projectId: string,
  input: any,
  signature: string,
) {
  const project = requireRepository(owner, projectId);
  const replay = commandReplay(owner, input.operationId, signature);
  if (replay.found) return replay.result;
  let pull: any;
  if (input.pullId) {
    pull = get('pull-request', owner, input.pullId);
    if (pull.projectId !== projectId) throw new Error('Pull request belongs to another project');
  }
  if (input.taskId && get('task', owner, input.taskId).projectId !== projectId)
    throw new Error('Task belongs to another project');
  const ref = input.ref || (pull ? `refs/heads/${pull.sourceBranch}` : 'HEAD');
  const commit = await resolveCommit(project.repositoryPath, ref);
  const manifest = await gitText(project.repositoryPath, ['show', `${commit}:deploy.yaml`]);
  const pipeline = compileDeployYaml(manifest).spec.pipeline;
  if (!pipeline) throw new Error('deploy.yaml does not define a pipeline');
  const trigger = input.trigger || 'manual';
  if (!pipeline.on.includes(trigger)) throw new Error(`Pipeline does not enable ${trigger}`);
  if (trigger === 'pull_request' && Object.values(pipeline.jobs).some((job) => !job.container))
    throw new Error(
      'Automatic pull-request checks require container jobs; host commands can be started manually by the owner',
    );
  const pipelineId = id(),
    sourceRef = `refs/deploy/pipelines/${pipelineId}`;
  await gitText(project.repositoryPath, ['update-ref', sourceRef, commit]);
  return command(
    owner,
    input.operationId,
    () => {
      const run = save('pipeline-run', owner, {
        id: pipelineId,
        projectId,
        taskId: input.taskId || null,
        pullId: pull?.id || null,
        commit,
        sourceRef,
        ref,
        trigger,
        specification: pipeline,
        status: 'queued',
        deployment:
          pipeline.deploy && !pull && trigger !== 'pull_request'
            ? { application: pipeline.deploy.application, status: 'waiting' }
            : null,
        createdAt: now(),
        updatedAt: now(),
      });
      for (const [name, spec] of Object.entries(pipeline.jobs))
        save('job', owner, {
          id: id(),
          pipelineId,
          projectId,
          taskId: input.taskId || null,
          runId: null,
          name,
          needs: spec.needs,
          requirements: spec.runsOn,
          workerId: null,
          command: spec.run,
          container: spec.container || null,
          timeoutMs: spec.timeoutSeconds * 1000,
          digest: commit,
          status: 'waiting',
          output: '',
          truncated: false,
          createdAt: now(),
          updatedAt: now(),
        });
      return run;
    },
    signature,
  );
}
export function pipelineRead(owner: string, projectId: string, pipelineId?: string) {
  get('project', owner, projectId);
  if (!pipelineId)
    return {
      runs: list('pipeline-run', owner)
        .filter((run) => run.projectId === projectId)
        .slice(-100)
        .reverse(),
      triggers: list('pipeline-trigger', owner)
        .filter((row) => row.projectId === projectId && row.status === 'failed')
        .slice(-20)
        .reverse(),
    };
  const pipeline = get('pipeline-run', owner, pipelineId);
  if (pipeline.projectId !== projectId)
    throw Object.assign(new Error('Not found'), { status: 404 });
  return {
    pipeline,
    jobs: list('job', owner)
      .filter((job) => job.pipelineId === pipelineId)
      .map((job) => describeJob(owner, job)),
  };
}
export function pipelineCancel(owner: string, projectId: string, pipelineId: string) {
  const { pipeline } = pipelineRead(owner, projectId, pipelineId) as any;
  if (terminal.includes(pipeline.status)) return pipeline;
  for (const job of list('job', owner).filter(
    (row) => row.pipelineId === pipelineId && ['waiting', 'queued', 'running'].includes(row.status),
  ))
    save('job', owner, {
      ...job,
      stopRequested: true,
      status: job.status === 'running' ? 'running' : 'cancelled',
      updatedAt: now(),
    });
  return save('pipeline-run', owner, {
    ...pipeline,
    stopRequested: true,
    status: 'cancelling',
    updatedAt: now(),
  });
}
export function reconcilePipelines() {
  db.transaction(() => {
    for (const row of db
      .prepare("SELECT owner,data FROM records WHERE kind='pipeline-run'")
      .all() as any[]) {
      const run = JSON.parse(row.data);
      if (terminal.includes(run.status)) continue;
      const jobs = list('job', row.owner).filter((job) => job.pipelineId === run.id);
      for (const job of jobs) {
        if (job.status !== 'waiting') continue;
        const dependencies = jobs.filter((dependency) => job.needs.includes(dependency.name));
        const status = run.stopRequested
          ? 'cancelled'
          : dependencies.some((dependency) =>
                ['failed', 'cancelled', 'skipped', 'timed_out'].includes(dependency.status),
              )
            ? 'skipped'
            : dependencies.every((dependency) => dependency.status === 'succeeded')
              ? 'queued'
              : 'waiting';
        if (status !== job.status) {
          job.status = status;
          save('job', row.owner, { ...job, updatedAt: now() });
        }
      }
      const status = jobs.some((job) => job.status === 'unknown')
        ? 'unknown'
        : jobs.every((job) => terminal.includes(job.status))
          ? run.stopRequested
            ? 'cancelled'
            : jobs.every((job) => job.status === 'succeeded')
              ? 'succeeded'
              : 'failed'
          : run.stopRequested
            ? 'cancelling'
            : jobs.some((job) => job.status === 'running')
              ? 'running'
              : 'queued';
      if (status !== run.status)
        save('pipeline-run', row.owner, {
          ...run,
          status,
          updatedAt: now(),
          ...(terminal.includes(status) ? { completedAt: now() } : {}),
          ...(status === 'succeeded' && run.deployment
            ? { deployment: { ...run.deployment, status: 'ready' } }
            : {}),
        });
    }
  }).immediate();
}
export async function scanPipelineTriggers() {
  for (const row of db
    .prepare("SELECT owner,data FROM records WHERE kind='pipeline-trigger-request'")
    .all() as any[]) {
    const request = JSON.parse(row.data);
    try {
      await pipelineTrigger(
        row.owner,
        requireRepository(row.owner, request.projectId),
        request.ref,
        request.commit,
        'push',
      );
      db.prepare(
        "DELETE FROM records WHERE kind='pipeline-trigger-request' AND owner=? AND id=?",
      ).run(row.owner, request.id);
    } catch (error: any) {
      // Retain the notification for retry without starving unrelated projects.
      save('pipeline-trigger-request', row.owner, { ...request, error: error.message });
    }
  }
  for (const row of db
    .prepare("SELECT owner,data FROM records WHERE kind='project'")
    .all() as any[]) {
    const project = JSON.parse(row.data);
    if (project.repositoryStatus && project.repositoryStatus !== 'ready') continue;
    try {
      const refs = await gitText(project.repositoryPath, [
        'for-each-ref',
        '--format=%(refname) %(objectname)',
        'refs/heads',
      ]);
      for (const line of refs.split('\n').filter(Boolean)) {
        const [ref, commit] = line.split(' ');
        const observationId = project.id + ':' + ref;
        const previous = list('pipeline-ref', row.owner).find(
          (entry) => entry.id === observationId,
        );
        save('pipeline-ref', row.owner, { id: observationId, projectId: project.id, commit });
        // Establish a baseline for imports, then process branch changes. Direct push notifications
        // can enqueue the same intent; the commit/ref key deduplicates them.
        if (previous && previous.commit !== commit)
          await pipelineTrigger(row.owner, project, ref, commit, 'push');
        for (const pull of list('pull-request', row.owner).filter(
          (candidate) =>
            candidate.projectId === project.id &&
            candidate.status === 'open' &&
            `refs/heads/${candidate.sourceBranch}` === ref,
        ))
          await pipelineTrigger(row.owner, project, ref, commit, 'pull_request', pull.id);
      }
    } catch (error: any) {
      save('pipeline-scan-error', row.owner, {
        id: project.id,
        error: error.message,
        updatedAt: now(),
      });
    }
  }
}
export async function pipelineTrigger(
  owner: string,
  project: any,
  ref: string,
  commit: string,
  trigger: string,
  pullId?: string,
) {
  const key = createHash('sha256')
    .update(JSON.stringify([project.id, ref, commit, trigger, pullId]))
    .digest('hex');
  if (list('pipeline-trigger', owner).some((row) => row.id === key)) return;
  try {
    const text = await gitText(project.repositoryPath, ['show', `${commit}:deploy.yaml`]).catch(
      () => null,
    );
    if (text === null) {
      save('pipeline-trigger', owner, { id: key, projectId: project.id, status: 'ignored' });
      return;
    }
    const pipeline = compileDeployYaml(text).spec.pipeline;
    const branch = ref.replace(/^refs\/heads\//, '');
    const branches = pipeline?.branches.length
      ? pipeline.branches
      : [project.defaultBranch || 'main'];
    const target = pullId ? get('pull-request', owner, pullId).targetBranch : branch;
    if (!pipeline?.on.includes(trigger as any) || !branches.includes(target)) {
      save('pipeline-trigger', owner, { id: key, projectId: project.id, status: 'ignored' });
      return;
    }
    const run = await pipelineStart(
      owner,
      project.id,
      { operationId: `pipeline-trigger:${key}`, ref: commit, trigger, pullId },
      key,
    );
    save('pipeline-trigger', owner, {
      id: key,
      projectId: project.id,
      status: 'started',
      pipelineId: run.id,
    });
  } catch (error: any) {
    save('pipeline-trigger', owner, {
      id: key,
      projectId: project.id,
      ref,
      commit,
      trigger,
      status: 'failed',
      error: error.message,
      createdAt: now(),
    });
  }
}
