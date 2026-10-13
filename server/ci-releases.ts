import { threadId } from 'node:worker_threads';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getDeployment, getSqlite, getApplicationSpecRevision } from './store.ts';
import { ciMutationActive } from './ci-fence.ts';
import { getDeployAdmissionState } from './deploy-admission.ts';
import { parseStoredApplicationSpec } from './application-spec.ts';

export const ciBootId = randomUUID();
export type CiStatus =
  | 'accepted'
  | 'building'
  | 'starting'
  | 'healthy'
  | 'failed'
  | 'interrupted'
  | 'cancelled';
export interface CiCredential {
  id: string;
  username: string;
  application: string;
  expires_at: number;
}
export interface CiRelease {
  id: string;
  application: string;
  username: string;
  credential_id: string;
  request_key: string;
  source_commit: string;
  source_digest: string;
  source_archive_digest: string;
  predecessor: string;
  baseline_source: string;
  baseline_fingerprint: string;
  runtime_fingerprint: string | null;
  resume_fingerprint: string | null;
  baseline_image: string;
  resume_source: string | null;
  resolved_by: string | null;
  resolved_at: number | null;
  baseline_container: string;
  spec_digest: string;
  status: CiStatus;
  boot_id: string;
  owner_pid: number | null;
  owner_active: number;
  container_id: string | null;
  image_digest: string | null;
  failure: string | null;
  created_at: number;
  updated_at: number;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const sql = () => getSqlite()!;
export function ciError(message: string, status = 409): never {
  throw Object.assign(new Error(message), { status });
}
export function ciTarget(application: string, username: string) {
  const d = getDeployment(application);
  if (!d || d.username !== username) ciError('Application not found', 404);
  if (
    !d.activeSpecDigest ||
    d.activeSpecDigest !== d.desiredSpecDigest ||
    !d.sourceArtifactDigest ||
    !d.containerId ||
    d.status !== 'running' ||
    (d.activeNodeId && d.activeNodeId !== 'coordinator') ||
    (d.desiredNodeId && d.desiredNodeId !== 'coordinator')
  )
    ciError(
      'CI publish requires a healthy coordinator graph; legacy adoption and placement changes are unsupported',
    );
  const revision = getApplicationSpecRevision(application, d.activeSpecDigest);
  if (!revision) ciError('Active graph unavailable');
  const spec = parseStoredApplicationSpec(revision.normalizedSpec);
  const components = Object.values(spec.components);
  if (
    components.length !== 1 ||
    components[0].instances !== 1 ||
    !components[0].build ||
    components[0].role !== 'web' ||
    !components[0].health ||
    components[0].interfaces[components[0].health.interface]?.protocol !== 'http' ||
    components[0].runtime.privileged ||
    components[0].runtime.networkMode === 'host' ||
    components[0].runtime.devices.length > 0 ||
    components[0].runtime.runArgs.length > 0 ||
    components[0].runtime.privilegedDocker ||
    components[0].runtime.gpus ||
    components[0].runtime.networks.length > 0 ||
    components[0].profile ||
    Object.keys(spec.jobs).length > 0 ||
    Object.values(spec.resources).some((r) => r.source?.type === 'bind') ||
    (d.volumes && JSON.parse(d.volumes).length > 0) ||
    (d.appId &&
      sql()
        .prepare(
          "SELECT id FROM app_replicas WHERE app_id=? AND removed_at IS NULL AND site_id NOT IN (SELECT id FROM sites WHERE kind='home' UNION SELECT 'coordinator') LIMIT 1",
        )
        .get(d.appId)) ||
    d.privilegedDocker ||
    d.gpuEnabled
  )
    ciError('CI publish supports one existing non-privileged built web component');
  return d;
}
export function issueCiCredential(username: string, application: string, ttlSeconds: number) {
  ciTarget(application, username);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86400 * 30)
    ciError('Expiry must be between 60 seconds and 30 days', 400);
  const token = 'ci_' + randomBytes(32).toString('hex');
  const id = randomUUID();
  const now = Date.now();
  const expiresAt = now + ttlSeconds * 1000;
  sql()
    .prepare('INSERT INTO ci_credentials VALUES(?,?,?,?,?,NULL,?)')
    .run(id, username, application, hash(token), expiresAt, now);
  return { id, application, expiresAt, token };
}
export function authenticateCi(token: unknown): CiCredential {
  if (typeof token !== 'string' || !/^ci_[a-f0-9]{64}$/.test(token)) ciError('Unauthorized', 401);
  const c = sql()
    .prepare(
      'SELECT id,username,application,expires_at FROM ci_credentials WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?',
    )
    .get(hash(token), Date.now()) as CiCredential | undefined;
  if (!c || getDeployment(c.application)?.username !== c.username) ciError('Unauthorized', 401);
  return c;
}
export function revokeCiCredential(id: string, username: string) {
  const result = sql()
    .prepare('UPDATE ci_credentials SET revoked_at=? WHERE id=? AND username=?')
    .run(Date.now(), id, username);
  if (!result.changes) ciError('Credential not found', 404);
}
export function ciRelease(id: string, credential: CiCredential): CiRelease {
  const r = sql()
    .prepare('SELECT * FROM ci_releases WHERE id=? AND application=? AND username=?')
    .get(id, credential.application, credential.username) as CiRelease | undefined;
  if (!r) ciError('Release not found', 404);
  return r;
}
export function ciFingerprint(application: string) {
  const d = getDeployment(application);
  if (!d) ciError('Application not found', 404);
  const configuration = sql()
    .prepare(
      'SELECT spec_digest,key,site_id,value_digest,revision FROM application_configuration_values WHERE deployment_name=? ORDER BY spec_digest,key,site_id',
    )
    .all(application);
  return hash(
    JSON.stringify({
      container: d.containerId,
      source: d.sourceArtifactDigest,
      active: d.activeSpecDigest,
      desired: d.desiredSpecDigest,
      configurationDigest: d.configurationDigest,
      node: d.activeNodeId,
      desiredNode: d.desiredNodeId,
      port: d.port,
      environment: d.envVars,
      volumes: d.volumes,
      memory: d.memoryLimit,
      cpu: d.cpuLimit,
      configuration,
    }),
  );
}
export function ciOwnerAlive(r: CiRelease) {
  if (!r.owner_active || !r.owner_pid) return false;
  try {
    process.kill(r.owner_pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
export function assertCiOwnerStopped(r: CiRelease) {
  if (ciOwnerAlive(r)) ciError('Live process owns release; wait for completion');
}
export function ciReceipt(r: CiRelease) {
  return {
    releaseId: r.id,
    application: r.application,
    sourceCommit: r.source_commit,
    sourceDigest: r.source_digest,
    sourceArchiveDigest: r.source_archive_digest,
    predecessorReleaseId: r.predecessor,
    status:
      ['accepted', 'building', 'starting'].includes(r.status) &&
      r.boot_id !== ciBootId &&
      !ciOwnerAlive(r)
        ? 'interrupted'
        : r.status === 'healthy' && r.runtime_fingerprint !== ciFingerprint(r.application)
          ? 'superseded'
          : r.status,
    containerId: r.container_id,
    imageDigest: r.image_digest,
    failure: r.failure,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at,
    requiresOwnerRecovery:
      ['failed', 'interrupted'].includes(r.status) ||
      (['accepted', 'building', 'starting'].includes(r.status) &&
        r.boot_id !== ciBootId &&
        !ciOwnerAlive(r)),
  };
}
export function activeCiRelease(application: string): CiRelease | undefined {
  return sql()
    .prepare(
      "SELECT * FROM ci_releases WHERE application=? AND status IN ('accepted','building','starting','interrupted','failed')",
    )
    .get(application) as CiRelease | undefined;
}
export function assertNoCiRelease(application: string, allowedId?: string) {
  const r = activeCiRelease(application);
  if (r && r.id !== allowedId) ciError('Application has a durable CI release reservation');
}
export function ciHead(c: CiCredential) {
  const d = ciTarget(c.application, c.username);
  const r = sql()
    .prepare(
      "SELECT * FROM ci_releases WHERE application=? AND status='healthy' ORDER BY created_at DESC,id DESC LIMIT 1",
    )
    .get(c.application) as CiRelease | undefined;
  return {
    releaseId:
      r && r.runtime_fingerprint === ciFingerprint(c.application)
        ? r.id
        : `baseline:${ciFingerprint(c.application)}`,
    application: c.application,
    sourceDigest: d.sourceArtifactDigest,
    graphDigest: d.activeSpecDigest,
    activeRelease: activeCiRelease(c.application)?.id ?? null,
  };
}
export function reserveCiRelease(
  c: CiCredential,
  input: {
    application: string;
    sourceCommit: string;
    sourceDigest: string;
    sourceArchiveDigest: string;
    idempotencyKey: string;
    expectedRelease: string;
  },
  runtime: { containerId: string; imageDigest: string },
) {
  if (
    input.application !== c.application ||
    !/^[a-f0-9]{40}$/.test(input.sourceCommit) ||
    !/^sha256:[a-f0-9]{64}$/.test(input.sourceDigest) ||
    !/^sha256:[a-f0-9]{64}$/.test(input.sourceArchiveDigest) ||
    !/^[a-zA-Z0-9:_.-]{1,128}$/.test(input.idempotencyKey) ||
    typeof input.expectedRelease !== 'string'
  )
    ciError('Invalid release intent', 400);
  return sql()
    .transaction(() => {
      const old = sql()
        .prepare('SELECT * FROM ci_releases WHERE application=? AND request_key=?')
        .get(c.application, input.idempotencyKey) as CiRelease | undefined;
      if (old) {
        if (
          old.username !== c.username ||
          old.source_commit !== input.sourceCommit ||
          old.source_digest !== input.sourceDigest ||
          old.source_archive_digest !== input.sourceArchiveDigest ||
          old.predecessor !== input.expectedRelease
        )
          ciError('Idempotency key conflicts with original release intent');
        return old;
      }
      const admission = getDeployAdmissionState();
      const target = ciTarget(c.application, c.username);
      if (ciMutationActive(c.application) || (target.appId && ciMutationActive(target.appId)))
        ciError('Application mutation in progress');
      if (
        admission.activeDeployments.includes(c.application) ||
        admission.queue.some((q) => q.name === c.application)
      )
        ciError('Application lifecycle already admitted');
      assertNoCiRelease(c.application);
      if (ciHead(c).releaseId !== input.expectedRelease)
        ciError('Stale predecessor; release intent must be reviewed');
      const d = ciTarget(c.application, c.username);
      const id = randomUUID();
      const now = Date.now();
      sql()
        .prepare(
          "INSERT INTO ci_releases(id,application,username,credential_id,request_key,source_commit,source_digest,source_archive_digest,predecessor,baseline_source,baseline_fingerprint,baseline_image,baseline_container,spec_digest,status,boot_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'accepted',?,?,?)",
        )
        .run(
          id,
          c.application,
          c.username,
          c.id,
          input.idempotencyKey,
          input.sourceCommit,
          input.sourceDigest,
          input.sourceArchiveDigest,
          input.expectedRelease,
          d.sourceArtifactDigest,
          ciFingerprint(c.application),
          runtime.imageDigest,
          d.containerId,
          d.activeSpecDigest,
          ciBootId,
          now,
          now,
        );
      return ciRelease(id, c);
    })
    .immediate();
}
export function claimCiUpload(id: string, c: CiCredential) {
  const r = ciRelease(id, c);
  const d = ciTarget(c.application, c.username);
  if (
    r.boot_id !== ciBootId ||
    r.status !== 'accepted' ||
    d.sourceArtifactDigest !== (r.resume_source || r.baseline_source) ||
    d.containerId !== r.baseline_container ||
    d.activeSpecDigest !== r.spec_digest ||
    ciFingerprint(c.application) !== (r.resume_fingerprint || r.baseline_fingerprint)
  )
    ciError('Release upload is stale, already claimed or interrupted');
  if (
    !sql()
      .prepare(
        "UPDATE ci_releases SET status='building',owner_pid=?,owner_thread=?,owner_active=1,updated_at=? WHERE id=? AND status='accepted' AND boot_id=?",
      )
      .run(process.pid, threadId, Date.now(), id, ciBootId).changes
  )
    ciError('Release already claimed');
  return r;
}
export function finishCiRelease(
  id: string,
  result: { containerId: string; imageDigest: string } | null,
) {
  if (result && (!result.containerId || !/^sha256:[a-f0-9]{64}$/.test(result.imageDigest)))
    ciError('Invalid runtime receipt');
  sql()
    .prepare(
      "UPDATE ci_releases SET status=?,owner_active=0,container_id=?,image_digest=?,runtime_fingerprint=?,failure=?,updated_at=? WHERE id=? AND boot_id=? AND status IN ('building','starting')",
    )
    .run(
      result ? 'healthy' : 'failed',
      result?.containerId ?? null,
      result?.imageDigest ?? null,
      result
        ? ciFingerprint(
            (
              sql().prepare('SELECT application FROM ci_releases WHERE id=?').get(id) as {
                application: string;
              }
            ).application,
          )
        : null,
      result ? null : 'Release failed; inspect owner build logs before retry',
      Date.now(),
      id,
      ciBootId,
    );
}
export function assertCiUploadCurrent(r: CiRelease) {
  const d = ciTarget(r.application, r.username);
  const current = sql().prepare('SELECT status,boot_id FROM ci_releases WHERE id=?').get(r.id) as {
    status: string;
    boot_id: string;
    owner_pid: number | null;
    owner_active: number;
  };
  if (
    current.status !== 'building' ||
    current.boot_id !== ciBootId ||
    d.sourceArtifactDigest !== (r.resume_source || r.baseline_source) ||
    d.containerId !== r.baseline_container ||
    d.activeSpecDigest !== r.spec_digest ||
    ciFingerprint(r.application) !== (r.resume_fingerprint || r.baseline_fingerprint)
  )
    ciError('Release target changed after admission');
}

export function ownerCiRelease(id: string, username: string): CiRelease {
  const r = sql()
    .prepare('SELECT * FROM ci_releases WHERE id=? AND username=?')
    .get(id, username) as CiRelease | undefined;
  if (!r || getDeployment(r.application)?.username !== username) ciError('Release not found', 404);
  return r;
}
export function resolveOwnerCiRelease(
  r: CiRelease,
  username: string,
  status: 'accepted' | 'healthy' | 'cancelled',
  runtime: { containerId: string; imageDigest: string; sourceDigest: string },
) {
  assertCiOwnerStopped(ownerCiRelease(r.id, username));
  if (
    status === 'healthy' &&
    (runtime.sourceDigest !== r.source_digest ||
      (runtime.containerId === r.baseline_container && r.source_digest !== r.baseline_source))
  )
    ciError('Recovery cannot attest an unrelated runtime');
  if (
    status !== 'healthy' &&
    (runtime.containerId !== r.baseline_container ||
      runtime.imageDigest !== r.baseline_image ||
      ![r.baseline_source, r.source_digest].includes(runtime.sourceDigest))
  )
    ciError('Recovery requires verified original runtime');
  const now = Date.now();
  const result = sql()
    .prepare(
      'UPDATE ci_releases SET status=?,owner_active=0,owner_pid=NULL,boot_id=?,resume_source=?,resume_fingerprint=?,container_id=?,image_digest=?,runtime_fingerprint=?,resolved_by=?,resolved_at=?,updated_at=? WHERE id=? AND username=? AND status=? AND boot_id=?',
    )
    .run(
      status,
      ciBootId,
      status === 'accepted' ? runtime.sourceDigest : r.resume_source,
      status === 'accepted' ? ciFingerprint(r.application) : r.resume_fingerprint,
      status === 'healthy' ? runtime.containerId : null,
      status === 'healthy' ? runtime.imageDigest : null,
      status === 'healthy' ? ciFingerprint(r.application) : r.runtime_fingerprint,
      username,
      now,
      now,
      r.id,
      username,
      r.status,
      r.boot_id,
    );
  if (!result.changes) ciError('Recovery state changed');
  return ownerCiRelease(r.id, username);
}

export function existingCiIntent(c: CiCredential, input: Parameters<typeof reserveCiRelease>[1]) {
  const r = sql()
    .prepare('SELECT * FROM ci_releases WHERE application=? AND request_key=?')
    .get(c.application, input.idempotencyKey) as CiRelease | undefined;
  if (!r) return undefined;
  if (
    input.application !== c.application ||
    r.username !== c.username ||
    r.source_commit !== input.sourceCommit ||
    r.source_digest !== input.sourceDigest ||
    r.source_archive_digest !== input.sourceArchiveDigest ||
    r.predecessor !== input.expectedRelease
  )
    ciError('Idempotency key conflicts with original release intent');
  return r;
}
