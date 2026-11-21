import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { extract } from 'tar-stream';
import {
  directorySource,
  applicationFailureLog,
  uploadApplication,
  agentDeploymentAdmission,
  redactDeploymentLog,
} from './application-deployment.ts';
import {
  assertAgentApplication,
  finishAgentUpload,
  recordAgentUpload,
} from '../../agent-upload.ts';
import { readDeploymentRecord, getBuildLogResult } from '../../store.ts';
import { applicationSpecDigest } from '../../application-spec.ts';
import { promisify } from 'node:util';
import { repositoryGit, gitText } from '../../workspace/repository-git.ts';
import { db, get, now, save } from '../../workspace/store.ts';
import { expandLfsArchive } from '../../workspace/lfs-archive.ts';
import { assertApplicationReleaseIdle, assertNoApplicationMutations } from './releases-fence.ts';
import type { Release } from '../../../shared/v2/contracts.ts';

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
async function pinnedArchive(repositoryPath: string, commit: string) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Full source commit required');
  const tree = await gitText(repositoryPath, ['ls-tree', '-r', commit]);
  if (tree.split('\n').some((line) => line.startsWith('160000 ')))
    throw new Error('Submodule source publishing is unsupported');
  const raw = await repositoryGit(repositoryPath, ['archive', '--format=tar', commit], {
    limit: 100 * 1024 * 1024,
    timeout: 120000,
  });
  return expandLfsArchive(raw, repositoryPath, 100 * 1024 * 1024);
}

export async function pipelineSource(repositoryPath: string, commit: string) {
  const tar = await pinnedArchive(repositoryPath, commit);
  const body = await compress(tar);
  return { body, sourceDigest: digest(body), sourceArchiveDigest: digest(tar) };
}

// Extract only regular files into a fresh directory. Never follow archived links.
export async function pipelineCandidate(
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
  const tar = await pinnedArchive(repositoryPath, commit);
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
            for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
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
    archive.end(tar);
    await completed;
    return await directorySource(resolve(root, path), name);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function packPipelineCandidate(candidate: Awaited<ReturnType<typeof pipelineCandidate>>) {
  const { archive, ...source } = candidate;
  const tar = await archive();
  const body = await compress(tar);
  return { ...source, body, sourceDigest: digest(body), sourceArchiveDigest: digest(tar) };
}

export async function pipelineBundle(
  repositoryPath: string,
  commit: string,
  path = '.',
  name?: string,
) {
  return packPipelineCandidate(await pipelineCandidate(repositoryPath, commit, path, name));
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
  const { issueOwnedCiCredential, revokeCiCredential } = await import('../../ci-releases.ts');
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

function supersededWhileWaiting(owner: string, run: any) {
  if (run.trigger !== 'push' || !run.branch) return false;
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM records
       WHERE kind='pipeline-run' AND owner=?
         AND rowid > (SELECT rowid FROM records WHERE kind='pipeline-run' AND owner=? AND id=?)
         AND json_extract(data, '$.projectId')=?
         AND json_extract(data, '$.branch')=?
         AND json_extract(data, '$.trigger')='push'
         AND json_extract(data, '$.deployment.application')=?
         AND json_extract(data, '$.status')='succeeded'
         AND json_extract(data, '$.deployment.status') IN ('ready', 'publishing', 'succeeded')
       LIMIT 1`,
      )
      .get(owner, owner, run.id, run.projectId, run.branch, run.deployment.application),
  );
}

function uploadedRelease(
  owner: string,
  buildLogId: number,
): { release: Release; recoveryRequired?: boolean } | undefined {
  try {
    const receipt = get('v2-upload-release', owner, String(buildLogId));
    return get('v2-release', owner, receipt.releaseId);
  } catch {
    return undefined;
  }
}

function equivalentLiveRelease(
  owner: string,
  projectId: string,
  application: string,
  bundle: Pick<Awaited<ReturnType<typeof pipelineCandidate>>, 'effectiveSourceDigest' | 'spec'>,
  resolveConfiguration: typeof import('../../application-configuration.ts').resolveApplicationConfiguration,
) {
  try {
    assertApplicationReleaseIdle(owner, application);
    assertNoApplicationMutations(owner, [application]);
    const current = readDeploymentRecord(application);
    const spec = applicationSpecDigest(bundle.spec);
    if (
      !current ||
      current.status !== 'running' ||
      current.username !== owner ||
      current.activeSpecDigest !== spec ||
      current.desiredSpecDigest !== spec ||
      (current.desiredNodeId && current.desiredNodeId !== current.activeNodeId) ||
      current.currentBuildLogId === null ||
      getBuildLogResult(application, current.currentBuildLogId)?.status !== 'complete'
    )
      return;
    const configuration = resolveConfiguration({
      deploymentName: application,
      specDigest: spec,
      declarations: bundle.spec.configuration,
      siteId: current.activeNodeId || 'coordinator',
    });
    if (!configuration.ready || configuration.digest !== current.configurationDigest) return;
    const origin = get('application-origin', owner, application);
    if (
      origin.projectId !== projectId ||
      !origin.sourceCommit ||
      origin.buildLogId !== current.currentBuildLogId ||
      origin.sourceArtifactDigest !== current.sourceArtifactDigest ||
      origin.effectiveSourceDigest !== bundle.effectiveSourceDigest
    )
      return;
    const release = uploadedRelease(owner, current.currentBuildLogId)?.release;
    if (!release) return;
    const pointer = get('v2-project-current', owner, release.projectId);
    if (
      pointer.releaseId !== release.id ||
      release.state !== 'live' ||
      release.source.commit !== origin.sourceCommit ||
      release.apps.length !== 1 ||
      release.apps[0].appId !== application ||
      release.projectId !== projectId ||
      release.steps.find((step) => step.name === 'verify')?.state !== 'done'
    )
      return;
    return release.id;
  } catch {
    // Older or incomplete receipts cannot establish equivalence.
    return undefined;
  }
}

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
    if (!deployment.startedAt && !deployment.intent) {
      assertAgentApplication(scope);
      if (deployment.waitingSince && supersededWhileWaiting(owner, run)) {
        persist({ status: 'superseded', error: null, completedAt: now() });
        return;
      }
      assertApplicationReleaseIdle(owner, deployment.application);
    }
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
      const record = uploadedRelease(owner, buildLogId);
      const release = record?.release;
      const timedOut = Date.now() - Date.parse(deployment.startedAt) > RELEASE_WAIT_MS;
      if (release) {
        if (release.source.commit && release.source.commit !== run.commit)
          throw new Error('Admitted release does not match the pinned candidate');
        // The release receipt survives a coordinator restart that can leave the build log
        // failed while the same verified candidate is still making progress.
        const verified = release.steps.some(
          (step) => step.name === 'verify' && step.state === 'done',
        );
        if (release.state === 'running' || (record?.recoveryRequired && verified)) {
          if (timedOut)
            persist({
              status: 'unknown',
              completedAt: now(),
              error: 'Timed out waiting for the admitted release. Follow its release receipt.',
            });
          return;
        }
        if (
          release.state === 'live' &&
          get('v2-project-current', owner, release.projectId).releaseId === release.id &&
          release.apps.some((entry) => entry.appId === deployment.application) &&
          ((verified &&
            release.source.commit === run.commit &&
            current.sourceArtifactDigest === deployment.sourceDigest) ||
            (!release.source.commit &&
              current.status === 'running' &&
              build?.status === 'complete'))
        ) {
          finishAgentUpload(scope);
          persist({ status: 'succeeded', releaseId: release.id, completedAt: now(), error: null });
          return;
        }
      } else if (current.status === 'running' && build?.status === 'complete') {
        finishAgentUpload(scope);
        persist({ status: 'succeeded', completedAt: now(), error: null });
        return;
      }
      if (
        release ||
        build?.status === 'failed' ||
        ['failed', 'configuration-required', 'stopped'].includes(current.status || '')
      ) {
        const failedBundle = await pipelineCandidate(
          project.repositoryPath,
          run.commit,
          deployment.path,
          deployment.application,
        );
        const reason = applicationFailureLog(deployment.application, buildLogId, failedBundle.spec);
        const phase = release?.steps.find((step) => step.state === 'failed')?.name;
        const outcome = phase
          ? `Release ${phase} failed.`
          : build?.status === 'failed' && current.status === 'running'
            ? 'Candidate build failed.'
            : `Deployment ${release?.state || current.status}.`;
        throw new Error(
          `${outcome} Check configuration and build logs.${reason ? `\n${reason}` : ''}`,
        );
      }
      if (timedOut)
        throw new Error(
          'Timed out waiting for build/start; the deployment may still finish. Inspect View logs.',
        );
      return;
    }
    let bundle: Awaited<ReturnType<typeof pipelineBundle>> | undefined;
    if (!deployment.intent) {
      const candidate = await pipelineCandidate(
        project.repositoryPath,
        run.commit,
        deployment.path,
        deployment.application,
      );
      if (!access && run.trigger === 'push') {
        const { resolveApplicationConfiguration } =
          await import('../../application-configuration.ts');
        const reused = db
          .transaction(() => {
            const reusedReleaseId = equivalentLiveRelease(
              owner,
              project.id,
              deployment.application,
              candidate,
              resolveApplicationConfiguration,
            );
            if (!reusedReleaseId) return false;
            // Keep the original release identity and record which checked commit reused it.
            persist({
              status: 'succeeded',
              unchanged: true,
              reusedReleaseId,
              completedAt: now(),
              error: null,
            });
            return true;
          })
          .immediate();
        if (reused) return;
      }
      bundle = await packPipelineCandidate(candidate);
      let useRelease = Boolean(access);
      if (!access) {
        // Retain the cheaper CI path for an existing CI-managed, unchanged supported graph.
        // New apps and graph/placement/configuration changes must use normal upload admission.
        const { ciTarget, ciHead } = await import('../../ci-releases.ts');
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
        const receipt = await uploadApplication(
          {
            ...scope,
            source: {
              commit: run.commit,
              archiveDigest: bundle.sourceDigest,
              effectiveSourceDigest: bundle.effectiveSourceDigest,
            },
          },
          bundle,
          120000,
        );
        const admittedBuildId = get('pipeline-run', owner, pipelineId).deployment.buildLogId;
        const buildLogId = receipt.buildLogId;
        if (!Number.isSafeInteger(buildLogId) || buildLogId <= 0 || buildLogId !== admittedBuildId)
          throw new Error('Upload did not return its admitted build identity');
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
    // This conflict is returned only before upload admission. An ambiguous response is never retried.
    if (error.code === 'release-reservation-busy' && !deployment.intent && !deployment.buildLogId) {
      const waitingSince = deployment.waitingSince || now();
      const expired = Date.now() - Date.parse(waitingSince) > RELEASE_WAIT_MS;
      persist({
        status: expired ? 'failed' : 'ready',
        waitingSince,
        method: undefined,
        startedAt: undefined,
        ...(expired ? { completedAt: now() } : {}),
        error: redactDeploymentLog(error.message),
      });
      return;
    }
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
