import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { repositoryGit, gitText } from './repository-git.ts';
import { db, get, now, save } from './store.ts';
import { expandLfsArchive } from './lfs-archive.ts';

const compress = promisify(gzip);
const digest = (data: Buffer) => 'sha256:' + createHash('sha256').update(data).digest('hex');
type Request = (path: string, options?: RequestInit) => Promise<any>;
export type ReleaseAccess = (
  owner: string,
  application: string,
) => Promise<{
  request: Request;
  close: () => void;
}>;

// Source is always reconstructed from the pinned commit, never from job output or
// a mutable worker checkout. No release credential crosses into an execution job.
export async function pipelineSource(repositoryPath: string, commit: string) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Full source commit required');
  const tree = await gitText(repositoryPath, ['ls-tree', '-r', commit]);
  if (tree.split('\n').some((line) => line.startsWith('160000 ')))
    throw new Error('Submodule source publishing is unsupported');
  const raw = await repositoryGit(repositoryPath, ['archive', '--format=tar', commit], {
    limit: 100 * 1024 * 1024,
    timeout: 120000,
  });
  const tar = await expandLfsArchive(raw, repositoryPath, 100 * 1024 * 1024);
  const body = await compress(tar);
  return { body, sourceDigest: digest(body), sourceArchiveDigest: digest(tar) };
}

export const coordinatorReleaseAccess: ReleaseAccess = async (owner, application) => {
  // Production control listens on this loopback socket. Legacy single-process
  // servers can opt into an HTTPS origin, with the normal Node CA trust settings.
  const origin = new URL(
    process.env.DEPLOY_PIPELINE_ORIGIN || `http://127.0.0.1:${process.env.CONTROL_PORT || 7843}`,
  );
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/' ||
    (origin.protocol !== 'https:' &&
      !(origin.protocol === 'http:' && origin.hostname === '127.0.0.1'))
  )
    throw new Error('Pipeline release origin must be HTTPS or the loopback control server');
  const { issueOwnedCiCredential, revokeCiCredential } = await import('../ci-releases.ts');
  const credential = issueOwnedCiCredential(owner, application, 1800);
  return {
    async request(path, options = {}) {
      if (!/^\/api\/ci\/releases(?:\/(?:head|[a-f0-9-]+)(?:\/upload)?)?$/.test(path))
        throw new Error('Invalid release endpoint');
      const response = await fetch(new URL(path, origin), {
        ...options,
        redirect: 'error',
        signal: AbortSignal.timeout(120000),
        headers: { ...options.headers, 'x-deploy-ci-token': credential.token },
      });
      const result = (await response.json()) as any;
      if (!response.ok)
        throw Object.assign(new Error(`Release request rejected (${response.status})`), {
          permanent:
            response.status >= 400 &&
            response.status < 500 &&
            response.status !== 408 &&
            response.status !== 429,
        });
      return result;
    },
    close: () => revokeCiCredential(credential.id, owner),
  };
};

export async function advancePipelineDeployment(
  owner: string,
  pipelineId: string,
  access: ReleaseAccess = coordinatorReleaseAccess,
) {
  const run = get('pipeline-run', owner, pipelineId);
  if (run.status !== 'succeeded' || !['ready', 'publishing'].includes(run.deployment?.status))
    return;
  let deployment = { ...run.deployment };
  const persist = (changes: any) => {
    deployment = { ...deployment, ...changes, updatedAt: now() };
    // Preserve other state if the coordinator updated it during network IO.
    save('pipeline-run', owner, {
      ...get('pipeline-run', owner, pipelineId),
      deployment,
      updatedAt: now(),
    });
  };
  let session: Awaited<ReturnType<ReleaseAccess>> | undefined;
  try {
    session = await access(owner, deployment.application);
    const request = session.request;
    let receipt: any;
    let source: Awaited<ReturnType<typeof pipelineSource>> | undefined;
    if (!deployment.releaseId) {
      const project = get('project', owner, run.projectId);
      source = await pipelineSource(project.repositoryPath, run.commit);
      if (!deployment.intent) {
        const head = await request('/api/ci/releases/head');
        persist({
          status: 'publishing',
          intent: {
            application: deployment.application,
            sourceCommit: run.commit,
            sourceDigest: source.sourceDigest,
            sourceArchiveDigest: source.sourceArchiveDigest,
            idempotencyKey: `pipeline:${pipelineId}`,
            expectedRelease: head.releaseId,
          },
        });
      }
      if (
        source.sourceDigest !== deployment.intent.sourceDigest ||
        source.sourceArchiveDigest !== deployment.intent.sourceArchiveDigest
      )
        throw Object.assign(new Error('Pinned source does not match publication intent'), {
          permanent: true,
        });
      receipt = await request('/api/ci/releases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deployment.intent),
      });
    } else receipt = await request(`/api/ci/releases/${deployment.releaseId}`);
    const intent = deployment.intent;
    if (
      !/^[a-f0-9-]{36}$/.test(receipt.releaseId || '') ||
      (deployment.releaseId && receipt.releaseId !== deployment.releaseId) ||
      receipt.application !== intent.application ||
      receipt.sourceCommit !== intent.sourceCommit ||
      receipt.sourceDigest !== intent.sourceDigest ||
      receipt.sourceArchiveDigest !== intent.sourceArchiveDigest ||
      receipt.predecessorReleaseId !== intent.expectedRelease
    )
      throw Object.assign(new Error('Release receipt does not match pipeline intent'), {
        permanent: true,
      });
    persist({ releaseId: receipt.releaseId, receipt, failures: 0, error: null });
    if (receipt.status === 'accepted') {
      source ||= await pipelineSource(
        get('project', owner, run.projectId).repositoryPath,
        run.commit,
      );
      if (
        source.sourceDigest !== intent.sourceDigest ||
        source.sourceArchiveDigest !== intent.sourceArchiveDigest
      )
        throw Object.assign(new Error('Pinned source does not match publication intent'), {
          permanent: true,
        });
      const form = new FormData();
      form.set('name', deployment.application);
      form.set('detached', '1');
      form.set('file', new Blob([new Uint8Array(source.body)]), 'source.tar.gz');
      await request(`/api/ci/releases/${receipt.releaseId}/upload`, { method: 'POST', body: form });
    } else if (receipt.status === 'healthy') {
      if (!receipt.containerId || !/^sha256:[a-f0-9]{64}$/.test(receipt.imageDigest || ''))
        throw Object.assign(new Error('Healthy release lacks runtime identity'), {
          permanent: true,
        });
      persist({ status: 'succeeded', completedAt: now() });
    } else if (['failed', 'cancelled', 'superseded', 'interrupted'].includes(receipt.status)) {
      persist({
        status: receipt.status === 'interrupted' ? 'unknown' : receipt.status,
        completedAt: now(),
      });
    } else if (!['building', 'starting'].includes(receipt.status)) {
      throw Object.assign(new Error('Unrecognized release status'), { permanent: true });
    }
  } catch (error: any) {
    const failures = (deployment.failures || 0) + 1;
    persist({
      failures,
      error: error.message,
      ...(error.permanent || failures >= 20
        ? {
            status: deployment.intent ? 'unknown' : 'failed',
          }
        : {}),
    });
  } finally {
    session?.close();
  }
}

export async function advancePipelineDeployments() {
  for (const row of db
    .prepare("SELECT owner,data FROM records WHERE kind='pipeline-run'")
    .all() as any[]) {
    const run = JSON.parse(row.data);
    if (run.status === 'succeeded' && ['ready', 'publishing'].includes(run.deployment?.status))
      await advancePipelineDeployment(row.owner, run.id);
  }
}
