import { createHash, randomBytes } from 'node:crypto';
import { db, get, save, now } from '../workspace/store.ts';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
export function assertPublishRun(owner: string, run: any) {
  const project = get('project', owner, run.projectId);
  if (project.owner !== owner || run.pullId || run.trigger === 'pull_request')
    throw new Error("Only the repository owner's pipelines may publish");
  if (run.stopRequested || run.status !== 'succeeded' || run.packages?.status !== 'running')
    throw new Error('The pipeline publish step has ended');
  return project;
}
export function issuePipelinePackageToken(owner: string, job: any) {
  const run = get('pipeline-run', owner, job.pipelineId);
  assertPublishRun(owner, run);
  if (
    !job.packagePublish ||
    job.packagePublish.checkOnly ||
    job.status !== 'running' ||
    job.stopRequested
  )
    throw new Error('Only the publish job can request a pipeline token');
  const entry = run.packages.items.find((item: any) => item.jobId === job.id);
  if (!entry || entry.status !== 'running') throw new Error('This package is not being published');
  const token = 'dlp_' + randomBytes(32).toString('base64url');
  save('pipeline-package-token', '', {
    id: digest(token),
    owner,
    pipelineId: run.id,
    projectId: run.projectId,
    jobId: job.id,
    generation: job.generation,
    name: entry.name,
    version: entry.version,
    commit: run.commit,
    pullNumber: run.mergedPull?.number,
    expiresAt: Date.now() + 30 * 60_000,
    createdAt: now(),
  });
  return token;
}
export function pipelinePackageIdentity(token: string) {
  const row = db
    .prepare("SELECT data FROM records WHERE kind='pipeline-package-token' AND id=? AND owner=''")
    .get(digest(token)) as any;
  if (!row) return null;
  const scope = JSON.parse(row.data);
  try {
    if (scope.expiresAt <= Date.now()) return null;
    const run = get('pipeline-run', scope.owner, scope.pipelineId);
    assertPublishRun(scope.owner, run);
    const job = get('job', scope.owner, scope.jobId);
    if (job.status !== 'running' || job.stopRequested || job.generation !== scope.generation)
      return null;
    if (!run.packages.items.some((item: any) => item.jobId === job.id && item.status === 'running'))
      return null;
    return {
      username: scope.owner,
      publish: true,
      admin: false,
      credential: 'pipeline:' + run.id,
      pipeline: scope,
    };
  } catch {
    return null;
  }
}
