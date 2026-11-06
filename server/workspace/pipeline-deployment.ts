import { createHash } from 'node:crypto';
import { gzip, gunzipSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { extract } from 'tar-stream';
import {
  directoryBundle,
  applicationFailureLog,
  uploadApplication,
  agentDeploymentAdmission,
  redactDeploymentLog,
} from './application-deployment.ts';
import { assertAgentApplication, recordAgentUpload, finishAgentUpload } from '../agent-upload.ts';
import { readDeploymentRecord, getBuildLogResult } from '../store.ts';
import { applicationSpecDigest } from '../application-spec.ts';
import { promisify } from 'node:util';
import { repositoryGit, gitText } from './repository-git.ts';
import { db, get, now, save } from './store.ts';
import { expandLfsArchive } from './lfs-archive.ts';

const compress = promisify(gzip);
// A release bounds each of its phases (each computer job has a 20-minute deadline,
// and Watch runs for 10 minutes), so wait as long as a healthy one can take rather
// than failing the run while it is still verifying or watching.
const RELEASE_WAIT_MS = 75 * 60_000;
const digest = (data: Buffer) => 'sha256:' + createHash('sha256').update(data).digest('hex');
type Request = (path: string, options?: RequestInit) => Promise<any>;
export type ReleaseAccess = (
  owner: string,
  application: string,
  scope?: { projectId: string; pipelineId: string },
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

// Extract only regular files into a fresh directory. Never follow archived links.
export async function pipelineBundle(
  repositoryPath: string,
  commit: string,
  path = '.',
  name?: string,
) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').includes('..')
  )
    throw new Error('pipeline.deploy.path must be a repository subdirectory');
  const source = await pipelineSource(repositoryPath, commit);
  const root = mkdtempSync(join(tmpdir(), 'deploy-pipeline-'));
  try {
    const archive = extract();
    const completed = new Promise<void>((done, fail) => {
      archive.on('finish', done).on('error', fail);
      archive.on('entry', (header, stream, next) => {
        void (async () => {
          const parts = header.name.replace(/\/$/, '').split('/');
          if (
            header.name.startsWith('/') ||
            header.name.includes('\\') ||
            parts.some((p) => !p || p === '..' || p === '.' || p === '.git')
          )
            throw new Error('Unsafe pinned source path');
          const target = join(root, ...parts);
          if (header.type === 'directory') {
            mkdirSync(target, { recursive: true });
            stream.resume();
          } else if (header.type === 'file') {
            const chunks: Buffer[] = [];
            for await (const chunk of stream) chunks.push(Buffer.from(chunk));
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, Buffer.concat(chunks), {
              flag: 'wx',
              mode: (header.mode || 0o644) & 0o777,
            });
          } else throw new Error('Pinned source contains unsupported links or special files');
          next();
        })().catch((error) => archive.destroy(error));
      });
    });
    archive.end(gunzipSync(source.body));
    await completed;
    const bundle = await directoryBundle(resolve(root, path), name);
    return {
      ...bundle,
      sourceDigest: digest(bundle.body),
      sourceArchiveDigest: digest(gunzipSync(bundle.body)),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export const coordinatorReleaseAccess: ReleaseAccess = async (owner, application, scope) => {
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
  if (scope)
    save('pipeline-ci-authority', owner, {
      id: credential.id,
      scope: { owner, application, ...scope },
    });
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
        throw Object.assign(
          new Error(result.error || `Release request rejected (${response.status})`),
          {
            permanent:
              response.status >= 400 &&
              response.status < 500 &&
              response.status !== 408 &&
              response.status !== 429,
          },
        );
      return result;
    },
    close: () => revokeCiCredential(credential.id, owner),
  };
};

export async function advancePipelineDeployment(
  owner: string,
  pipelineId: string,
  access?: ReleaseAccess,
) {
  const run = get('pipeline-run', owner, pipelineId);
  if (run.specification?.publish?.length && run.packages?.status !== 'succeeded') return;
  if (run.status !== 'succeeded' || !['ready', 'publishing'].includes(run.deployment?.status))
    return;
  let deployment = { ...run.deployment };
  const persist = (changes: any) => {
    deployment = {
      ...get('pipeline-run', owner, pipelineId).deployment,
      ...changes,
      updatedAt: now(),
    };
    // Preserve other state if the coordinator updated it during network IO.
    save('pipeline-run', owner, {
      ...get('pipeline-run', owner, pipelineId),
      deployment,
      updatedAt: now(),
    });
  };
  let session: Awaited<ReturnType<ReleaseAccess>> | undefined;
  let uploading = false;
  try {
    const project = get('project', owner, run.projectId);
    const scope = {
      owner,
      projectId: project.id,
      pipelineId,
      application: deployment.application,
      deploymentRecordId: pipelineId,
    };
    if (project.owner !== owner || run.pullId || run.trigger === 'pull_request')
      throw Object.assign(new Error("Only the repository owner's pipelines may deploy"), {
        permanent: true,
      });
    if (!deployment.startedAt && !deployment.intent) assertAgentApplication(scope);
    if (deployment.method === 'upload') {
      // Resume only the recorded build. An interrupted upload is never submitted twice.
      const buildLogId = deployment.buildLogId;
      if (!buildLogId)
        throw new Error(
          'Coordinator interrupted during upload. Inspect the application and deploy manually before retrying.',
        );
      const current = readDeploymentRecord(deployment.application);
      const build = getBuildLogResult(deployment.application, buildLogId);
      if (!current || current.currentBuildLogId !== buildLogId)
        throw new Error('Deployment was superseded; inspect View logs.');
      if (current.status === 'running' && build?.status === 'complete') {
        finishAgentUpload(scope);
        persist({ status: 'succeeded', url: deployment.url, completedAt: now(), error: null });
      } else if (
        build?.status === 'failed' ||
        ['failed', 'configuration-required', 'stopped'].includes(current.status || '')
      ) {
        const failedBundle = await pipelineBundle(
          project.repositoryPath,
          run.commit,
          deployment.path,
          deployment.application,
        );
        const reason = applicationFailureLog(deployment.application, buildLogId, failedBundle.spec);
        throw new Error(
          `Deployment ${current.status}. Check configuration and build logs.${reason ? `\n${reason}` : ''}`,
        );
      } else if (Date.now() - Date.parse(deployment.startedAt) > RELEASE_WAIT_MS) {
        throw new Error(
          'Timed out waiting for build/start; the deployment may still finish. Inspect View logs.',
        );
      }
      return;
    }
    let bundle: Awaited<ReturnType<typeof pipelineBundle>> | undefined;
    if (!deployment.intent) {
      bundle = await pipelineBundle(
        project.repositoryPath,
        run.commit,
        deployment.path,
        deployment.application,
      );
      let useRelease = Boolean(access);
      if (!access) {
        // Retain the cheaper CI path for an existing CI-managed, unchanged supported graph.
        // New apps and graph/placement/configuration changes must use normal upload admission.
        const { ciTarget, ciHead } = await import('../ci-releases.ts');
        try {
          const target = ciTarget(deployment.application, owner);
          useRelease = !deployment.path || deployment.path === '.';
          useRelease &&= !Object.values(bundle.spec.resources).some(
            (resource) => resource.type === 'volume',
          );
          useRelease &&= applicationSpecDigest(bundle.spec) === target.activeSpecDigest;
          useRelease &&= !ciHead({
            application: deployment.application,
            username: owner,
          } as any).releaseId.startsWith('baseline:');
        } catch {
          useRelease = false;
        }
      }
      if (!useRelease) {
        agentDeploymentAdmission(deployment.application);
        persist({
          method: 'upload',
          status: 'publishing',
          startedAt: now(),
          sourceDigest: bundle.sourceDigest,
          sourceArchiveDigest: bundle.sourceArchiveDigest,
          url: `https://${deployment.application}.local`,
        });
        uploading = true;
        const receipt = await uploadApplication(scope, bundle, 120000);
        const buildLogId =
          receipt.buildLogId ||
          (receipt.unchanged
            ? readDeploymentRecord(deployment.application)?.currentBuildLogId
            : null);
        if (!Number.isSafeInteger(buildLogId) || buildLogId <= 0)
          throw new Error('Upload did not return a deployment identity');
        if (receipt.unchanged) recordAgentUpload(scope, buildLogId);
        persist({ buildLogId, error: null });
        return;
      }
      persist({ method: 'release' });
    }
    session = await (access || coordinatorReleaseAccess)(owner, deployment.application, {
      projectId: project.id,
      pipelineId,
    });
    const request = session.request;
    let receipt: any;
    let source: Awaited<ReturnType<typeof pipelineBundle>> | undefined = bundle;
    if (!deployment.releaseId) {
      source ||= await pipelineBundle(
        project.repositoryPath,
        run.commit,
        deployment.path,
        deployment.application,
      );
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
        uncertain: true,
        permanent: true,
      });
    persist({
      releaseId: receipt.releaseId,
      receipt,
      buildLogId: receipt.buildLogId,
      failures: 0,
      error: null,
    });
    if (receipt.status === 'accepted') {
      source ||= await pipelineBundle(
        get('project', owner, run.projectId).repositoryPath,
        run.commit,
        deployment.path,
        deployment.application,
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
      if (receipt.buildLogId) {
        const current = readDeploymentRecord(deployment.application);
        if (
          !current ||
          current.currentBuildLogId !== receipt.buildLogId ||
          current.sourceArtifactDigest !== receipt.sourceDigest
        )
          throw Object.assign(new Error('Deployment was superseded; inspect View logs.'), {
            permanent: true,
          });
        recordAgentUpload(scope, receipt.buildLogId);
        finishAgentUpload(scope);
      }
      persist({
        status: 'succeeded',
        url: `https://${deployment.application}.local`,
        completedAt: now(),
      });
    } else if (['failed', 'cancelled', 'superseded', 'interrupted'].includes(receipt.status)) {
      persist({
        status: receipt.status === 'interrupted' ? 'unknown' : receipt.status,
        error: `${receipt.failure || `Release ${receipt.status}`}. Deploy manually to resolve this failure.`,
        completedAt: now(),
      });
    } else if (!['building', 'starting'].includes(receipt.status)) {
      throw Object.assign(new Error('Unrecognized release status'), { permanent: true });
    }
  } catch (error: any) {
    deployment = get('pipeline-run', owner, pipelineId).deployment;
    const failures = (deployment.failures || 0) + 1;
    if (uploading && deployment.buildLogId) return; // The handler admitted a build even if its response was lost.
    if (deployment.method !== 'release') {
      persist({
        status: 'failed',
        error: redactDeploymentLog(`${error.message} Deploy manually to resolve this failure.`),
        completedAt: now(),
      });
      return;
    }
    persist({
      failures,
      error: redactDeploymentLog(`${error.message} Deploy manually to resolve this failure.`),
      ...(error.permanent || failures >= 20
        ? {
            status:
              error.uncertain || (!error.permanent && deployment.intent) ? 'unknown' : 'failed',
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
