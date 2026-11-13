import { posix } from 'node:path';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { compileDeployYaml } from '../application-spec.ts';
import { command, commandReplay, db, get, id, list, now, save } from './store.ts';
import { gitText } from './repository-git.ts';
import { requireRepository, resolveCommit } from './repositories.ts';
import { describeJob } from './coordination.ts';
const terminal = ['succeeded', 'failed', 'cancelled', 'skipped', 'timed_out'];
// A job whose worker restarted under it is `unknown`, and nothing replays it: it is over, and so
// is its run. Leaving such runs open kept every one of them in each reconcile pass for good.
const settled = [...terminal, 'unknown'];
async function changedFiles(project: any, commit: string, pull: any, previousCommit?: string) {
  let base = previousCommit;
  if (pull) {
    const target = await resolveCommit(project.repositoryPath, `refs/heads/${pull.targetBranch}`);
    base = await gitText(project.repositoryPath, ['merge-base', target, commit]);
  } else if (base === undefined) {
    const parents = await gitText(project.repositoryPath, [
      'rev-list',
      '--parents',
      '-n',
      '1',
      commit,
    ]);
    base = parents.split(' ')[1];
  }
  const changed = await gitText(
    project.repositoryPath,
    base && !/^0+$/.test(base)
      ? ['diff', '--name-only', '--no-renames', '-z', base, commit, '--']
      : ['ls-tree', '-r', '--name-only', '-z', commit],
  );
  return changed.split('\0').filter(Boolean);
}
const matchesPaths = (files: string[], paths: string[]) =>
  files.some((file) => paths.some((pattern) => posix.matchesGlob(file, pattern)));

export async function pipelineStart(
  owner: string,
  projectId: string,
  input: any,
  signature: string,
) {
  const project = requireRepository(owner, projectId);
  if (project.owner !== owner) throw new Error("Only the repository owner's pipelines may run");
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
  if (trigger !== 'manual' && !pipeline.on.includes(trigger))
    throw new Error(`Pipeline does not enable ${trigger}`);
  if (trigger === 'pull_request' && Object.values(pipeline.jobs).some((job) => !job.container))
    throw new Error(
      'Automatic pull-request checks require container jobs; host commands can be started manually by the owner',
    );
  const changed =
    trigger !== 'manual' && Object.values(pipeline.jobs).some((job) => job.paths)
      ? await changedFiles(project, commit, pull, input.previousCommit)
      : undefined;
  const title = await gitText(project.repositoryPath, ['show', '-s', '--format=%s', commit]);
  const merged = db
    .prepare(
      "SELECT data FROM records WHERE kind='pull-request' AND owner=? AND json_extract(data,'$.projectId')=? AND json_extract(data,'$.status')='merged' AND (json_extract(data,'$.mergedTargetCommit')=? OR json_extract(data,'$.mergedCommit')=?) LIMIT 1",
    )
    .get(owner, projectId, commit, commit) as any;
  const mergedPull = merged ? JSON.parse(merged.data) : null;
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
        title: mergedPull?.title || title,
        mergedPull: mergedPull
          ? {
              number: mergedPull.number,
              mergedBy: mergedPull.mergedBy,
              mergedByYou: mergedPull.mergedBy === owner,
            }
          : null,
        sourceRef,
        ref,
        branch:
          input.branch ||
          (ref === 'HEAD' ? project.defaultBranch || 'main' : ref.replace(/^refs\/heads\//, '')),
        trigger,
        specification: pipeline,
        status: 'queued',
        deployment:
          // Run pipeline works on any pipeline, but only one that opted in can deploy that way.
          pipeline.deploy &&
          !pull &&
          trigger !== 'pull_request' &&
          (trigger !== 'manual' || pipeline.on.includes('manual'))
            ? { ...pipeline.deploy, status: 'waiting' }
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
          status:
            changed && spec.paths && !matchesPaths(changed, spec.paths) ? 'skipped' : 'waiting',
          ...(changed && spec.paths && !matchesPaths(changed, spec.paths)
            ? { pathFiltered: true }
            : {}),
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
// Stored `status` covers jobs only and gates publication. Clients show the run's
// overall outcome, so a failed or pending deployment must not read as succeeded.
export function presentPipelineRun(run: any) {
  if (
    run.status === 'succeeded' &&
    run.specification?.publish?.length &&
    run.packages?.status !== 'succeeded'
  )
    return {
      ...run,
      jobsStatus: run.status,
      status: run.packages?.status === 'failed' ? 'failed' : 'publishing',
    };
  if (run.status !== 'succeeded' || !run.deployment) return run;
  const deployment = run.deployment.status;
  const status =
    deployment === 'succeeded'
      ? 'succeeded'
      : ['waiting', 'ready', 'publishing'].includes(deployment)
        ? 'deploying'
        : deployment === 'unknown'
          ? 'unknown'
          : 'failed';
  return { ...run, status, jobsStatus: run.status };
}
export function pipelineRead(owner: string, projectId: string, pipelineId?: string) {
  get('project', owner, projectId);
  if (!pipelineId)
    return {
      runs: (
        db
          .prepare(
            "SELECT data FROM records WHERE kind='pipeline-run' AND owner=? AND json_extract(data,'$.projectId')=? ORDER BY rowid DESC LIMIT 100",
          )
          .all(owner, projectId) as any[]
      )
        .map((row) => JSON.parse(row.data))
        .map(presentPipelineRun),
      triggers: (
        db
          .prepare(
            "SELECT data FROM records WHERE kind='pipeline-trigger' AND owner=? AND json_extract(data,'$.projectId')=? AND json_extract(data,'$.status')='failed' ORDER BY rowid DESC LIMIT 20",
          )
          .all(owner, projectId) as any[]
      ).map((row) => JSON.parse(row.data)),
    };
  const pipeline = get('pipeline-run', owner, pipelineId);
  if (pipeline.projectId !== projectId)
    throw Object.assign(new Error('Not found'), { status: 404 });
  return {
    pipeline: presentPipelineRun(pipeline),
    jobs: (
      db
        .prepare(
          "SELECT data FROM records WHERE kind='job' AND owner=? AND json_extract(data,'$.pipelineId')=? ORDER BY rowid",
        )
        .all(owner, pipelineId) as any[]
    ).map((row) => {
      const job = JSON.parse(row.data);
      let computer;
      try {
        computer =
          job.workerId === 'local'
            ? process.env.DEPLOY_NODE_NAME || hostname()
            : job.workerId
              ? get('worker', owner, job.workerId).name
              : undefined;
      } catch {}
      return { ...describeJob(owner, job), computer };
    }),
  };
}
export function pipelineCancel(owner: string, projectId: string, pipelineId: string) {
  pipelineRead(owner, projectId, pipelineId);
  // Act on the stored job outcome; a publishing release is owned by the controller.
  const pipeline = get('pipeline-run', owner, pipelineId);
  if (
    settled.includes(pipeline.status) &&
    !(
      pipeline.status === 'succeeded' &&
      pipeline.specification?.publish?.length &&
      !['succeeded', 'failed'].includes(pipeline.packages?.status)
    )
  )
    return presentPipelineRun(pipeline);
  const jobs = db
    .prepare(
      "SELECT data FROM records WHERE kind='job' AND owner=? AND json_extract(data,'$.pipelineId')=? AND json_extract(data,'$.status') IN ('waiting','queued','running')",
    )
    .all(owner, pipelineId) as { data: string }[];
  for (const row of jobs) {
    const job = JSON.parse(row.data);
    save('job', owner, {
      ...job,
      stopRequested: true,
      status: job.status === 'running' ? 'running' : 'cancelled',
      updatedAt: now(),
    });
  }
  return save('pipeline-run', owner, {
    ...pipeline,
    stopRequested: true,
    status: 'cancelling',
    updatedAt: now(),
  });
}
export function reconcilePipelines() {
  // Most passes change nothing. Look first without the write lock, so a pass with nothing to do
  // never makes the server wait for the database, and take the lock only to apply a change.
  if (!reconcile(false)) return;
  db.transaction(() => reconcile(true)).immediate();
}
/** Work out what each open run and its waiting jobs should be; with `apply`, save the changes. */
function reconcile(apply: boolean) {
  let changed = false;
  // Jobs are read once per owner for the whole pass, not once per open run.
  const jobsByOwner = new Map<string, Map<string, any[]>>();
  const jobsOf = (owner: string, pipelineId: string) => {
    let byRun = jobsByOwner.get(owner);
    if (!byRun) {
      byRun = new Map();
      for (const job of list('job', owner)) {
        if (!job.pipelineId || job.packagePublish) continue;
        const jobs = byRun.get(job.pipelineId);
        if (jobs) jobs.push(job);
        else byRun.set(job.pipelineId, [job]);
      }
      jobsByOwner.set(owner, byRun);
    }
    return byRun.get(pipelineId) ?? [];
  };
  for (const row of db
    .prepare("SELECT owner,data FROM records WHERE kind='pipeline-run'")
    .all() as any[]) {
    const run = JSON.parse(row.data);
    if (terminal.includes(run.status) || (run.status === 'unknown' && run.completedAt)) continue;
    const jobs = jobsOf(row.owner, run.id);
    for (const job of jobs) {
      if (job.status !== 'waiting') continue;
      const dependencies = jobs.filter((dependency) => job.needs.includes(dependency.name));
      const status = run.stopRequested
        ? 'cancelled'
        : dependencies.some(
              (dependency) =>
                !dependency.pathFiltered &&
                ['failed', 'cancelled', 'skipped', 'timed_out', 'unknown'].includes(
                  dependency.status,
                ),
            )
          ? 'skipped'
          : dependencies.every(
                (dependency) => dependency.status === 'succeeded' || dependency.pathFiltered,
              )
            ? 'queued'
            : 'waiting';
      if (status !== job.status) {
        changed = true;
        job.status = status;
        if (apply) save('job', row.owner, { ...job, updatedAt: now() });
      }
    }
    // Waiting jobs above have already become skipped or cancelled where a dependency is over,
    // so a run with an unknown job finishes as unknown once nothing else is left to run.
    const status = !jobs.every((job) => settled.includes(job.status))
      ? run.stopRequested
        ? 'cancelling'
        : jobs.some((job) => job.status === 'running')
          ? 'running'
          : jobs.some((job) => job.status === 'unknown')
            ? 'unknown'
            : 'queued'
      : jobs.some((job) => job.status === 'unknown')
        ? 'unknown'
        : run.stopRequested
          ? 'cancelled'
          : jobs.every((job) => job.status === 'succeeded' || job.pathFiltered)
            ? 'succeeded'
            : 'failed';
    const over = jobs.every((job) => settled.includes(job.status));
    if (status !== run.status || (over && !run.completedAt)) {
      changed = true;
      if (apply)
        save('pipeline-run', row.owner, {
          ...run,
          status,
          updatedAt: now(),
          ...(over ? { completedAt: now() } : {}),
          ...(status === 'succeeded' && run.deployment
            ? { deployment: { ...run.deployment, status: 'ready' } }
            : {}),
        });
    }
  }
  return changed;
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
        undefined,
        request.previousCommit,
      );
      db.prepare(
        "DELETE FROM records WHERE kind='pipeline-trigger-request' AND owner=? AND id=?",
      ).run(row.owner, request.id);
    } catch (error: any) {
      // Retain the notification for retry without starving unrelated projects.
      save('pipeline-trigger-request', row.owner, { ...request, error: error.message });
    }
  }
  // Read each owner's observed refs and open pull requests once for the pass. This used to be
  // read again for every branch of every repository, and every branch was rewritten each second.
  const seenRefs = new Map<string, Map<string, any>>();
  const openPulls = new Map<string, any[]>();
  const refsOf = (owner: string) => {
    let refs = seenRefs.get(owner);
    if (!refs) {
      refs = new Map(list('pipeline-ref', owner).map((entry) => [entry.id, entry]));
      seenRefs.set(owner, refs);
    }
    return refs;
  };
  const pullsOf = (owner: string) => {
    let pulls = openPulls.get(owner);
    if (!pulls) {
      pulls = list('pull-request', owner).filter((candidate) => candidate.status === 'open');
      openPulls.set(owner, pulls);
    }
    return pulls;
  };
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
        const previous = refsOf(row.owner).get(observationId);
        if (previous?.commit !== commit) {
          const observed = { id: observationId, projectId: project.id, commit };
          save('pipeline-ref', row.owner, observed);
          refsOf(row.owner).set(observationId, observed);
        }
        // Establish a baseline for imports, then process branch changes. Direct push notifications
        // can enqueue the same intent; the commit/ref key deduplicates them.
        if (previous && previous.commit !== commit)
          await pipelineTrigger(
            row.owner,
            project,
            ref,
            commit,
            'push',
            undefined,
            previous.commit,
          );
        for (const pull of pullsOf(row.owner).filter(
          (candidate) =>
            candidate.projectId === project.id && `refs/heads/${candidate.sourceBranch}` === ref,
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
  previousCommit?: string,
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
    if (pipeline.paths && (trigger === 'push' || trigger === 'pull_request')) {
      const changed = await changedFiles(
        project,
        commit,
        pullId ? get('pull-request', owner, pullId) : null,
        previousCommit,
      );
      if (!matchesPaths(changed, pipeline.paths)) {
        save('pipeline-trigger', owner, { id: key, projectId: project.id, status: 'ignored' });
        return;
      }
    }
    const run = await pipelineStart(
      owner,
      project.id,
      {
        operationId: `pipeline-trigger:${key}`,
        ref: commit,
        branch,
        trigger,
        pullId,
        previousCommit,
      },
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
