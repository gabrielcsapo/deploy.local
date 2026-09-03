import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  ApplicationGraphExecutor,
  type GraphExecutorContext,
  type GraphRecoveryArtifact,
} from './application-graph-executor.ts';
import { applicationWriterSiteId } from './application-authority.ts';
import { resolveApplicationConfiguration } from './application-configuration.ts';
import { buildApplicationGraphRuntime } from './application-runtime.ts';
import { parseStoredApplicationSpec, type ApplicationSpec } from './application-spec.ts';
import {
  createDataChangeset,
  createDataCheckpoint,
  createFileManifest,
  loadFileManifestArtifact,
  materializeFileManifest,
} from './data-reconciliation.ts';
import { getArtifact, verifyArtifact } from './content-store.ts';
import { deployDataPath } from './data-directory.ts';
import { getApplicationSpecRevision, getSqlite } from './store.ts';
import { inspectUploadArchive } from './upload-archive.ts';
import type { PortabilityVolumeSnapshot, SQLiteFileProfile } from './portability.ts';

const execFileAsync = promisify(execFile);

export type SuitcaseDataExecutor = Pick<
  ApplicationGraphExecutor,
  'createRecoveryPoint' | 'restoreRecoveryPoint'
>;

interface ReconciliationProfile {
  id: string;
  schemaFingerprint: string | null;
  sqliteFiles: SQLiteFileProfile[];
  uploadPaths: string[];
}

interface CheckpointRecord {
  id: string;
  databaseArtifactDigest: string | null;
  filesystemArtifactDigest: string | null;
  manifestArtifactDigest: string;
  schemaFingerprint: string | null;
  profileVersion: string | null;
}

interface RecoveryManifest {
  version: 1;
  applicationId: string;
  siteId: string;
  specDigest: string;
  configurationDigest: string;
  resources: Array<{
    resource: string;
    archive: string;
    digest: `sha256:${string}`;
    bytes: number;
  }>;
}

export interface RestoredCheckpointEvidence {
  checkpointId: string;
  manifestArtifactDigest: string;
  resources: string[];
  reused: boolean;
}

export interface CapturedBranchResult {
  status: 'unchanged' | 'pending' | 'captured';
  changesetId?: string;
  authenticatedDigest?: string;
}

/**
 * Run an analyzer against a cold, digest-verified snapshot of every managed
 * recovery resource, then resume the graph and erase the temporary plaintext.
 */
export async function inspectQuiescedApplicationVolumes<T>(input: {
  applicationId: string;
  context: GraphExecutorContext;
  executor: SuitcaseDataExecutor;
  inspect: (volumes: readonly PortabilityVolumeSnapshot[]) => Promise<T> | T;
}): Promise<T> {
  const rootParent = deployDataPath('portability-capture');
  mkdirSync(rootParent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(resolve(rootParent, `${safeSegment(input.applicationId)}-`));
  try {
    const recovery = await input.executor.createRecoveryPoint(input.context, resolve(root, 'cold'));
    const raw = await extractRecoveryCapture(recovery, resolve(root, 'raw'));
    const volumes = Object.keys(input.context.runtime.spec.resources)
      .sort()
      .map((resource) => ({
        resource,
        snapshotPath: resolve(raw, safeSegment(resource)),
      }))
      .filter((volume) => existsSync(volume.snapshotPath));
    return await input.inspect(volumes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export interface LocalDataApplication {
  applicationId: string;
  deploymentName: string;
  siteId: string;
  profileVersion: string;
  baseCheckpointId: string;
  spec: ApplicationSpec;
  context: GraphExecutorContext;
}

export interface SiteLocalDataApplication extends Omit<LocalDataApplication, 'baseCheckpointId'> {
  baseCheckpointId: null;
}

export async function createInitialSuitcaseCheckpoint(input: {
  applicationId: string;
  originSiteId: string;
  profileVersion: string;
  context: GraphExecutorContext;
  executor: SuitcaseDataExecutor;
  actor: string;
}): Promise<{ id: string; manifestDigest: string }> {
  const profile = reconciliationProfile(input.applicationId, input.profileVersion);
  const rootParent = deployDataPath('checkpoint-capture');
  mkdirSync(rootParent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(resolve(rootParent, `${safeSegment(input.applicationId)}-`));
  try {
    const recovery = await input.executor.createRecoveryPoint(input.context, resolve(root, 'cold'));
    const raw = await extractRecoveryCapture(recovery, resolve(root, 'raw'));
    const database = profile.sqliteFiles.length > 0 ? singleSqliteFile(profile) : undefined;
    const databasePath = database
      ? containedResourcePath(raw, database.resource, database.relativePath)
      : undefined;
    if (database && databasePath && !existsSync(databasePath)) {
      throw new Error(
        `Home volume is missing profiled SQLite file ${database.resource}/${database.relativePath}`,
      );
    }
    const filesRoot = resolve(root, 'files');
    mkdirSync(filesRoot, { recursive: true, mode: 0o700 });
    copyProfiledUploads(profile, raw, filesRoot);
    return createDataCheckpoint({
      appId: input.applicationId,
      originSiteId: input.originSiteId,
      databasePath,
      filesRoot: profile.uploadPaths.length > 0 ? filesRoot : undefined,
      schemaFingerprint: profile.schemaFingerprint || undefined,
      profileVersion: input.profileVersion,
      actor: input.actor,
      allowEmpty: !databasePath && profile.uploadPaths.length === 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Reconstruct one verified semantic checkpoint and restore it into the exact graph volumes. */
export async function restoreSuitcaseCheckpoint(input: {
  applicationId: string;
  siteId: string;
  checkpointId: string;
  profileVersion?: string | null;
  spec: ApplicationSpec;
  context: GraphExecutorContext;
  executor: SuitcaseDataExecutor;
}): Promise<RestoredCheckpointEvidence> {
  const checkpoint = checkpointRecord(input.applicationId, input.checkpointId);
  const profile = reconciliationProfile(
    input.applicationId,
    checkpoint.profileVersion || input.profileVersion,
  );
  const resources = managedResources(input.spec);
  const root = deployDataPath(
    'suitcase-checkpoints',
    safeSegment(input.applicationId),
    safeSegment(input.checkpointId),
  );
  const markerPath = resolve(root, 'restored.json');
  const marker = existsSync(markerPath)
    ? (JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>)
    : undefined;
  if (
    marker?.manifestArtifactDigest === checkpoint.manifestArtifactDigest &&
    marker?.specDigest === input.context.runtime.execution.specDigest &&
    marker?.configurationDigest === input.context.runtime.configurationDigest
  ) {
    return {
      checkpointId: checkpoint.id,
      manifestArtifactDigest: checkpoint.manifestArtifactDigest,
      resources,
      reused: true,
    };
  }

  await verifyCheckpointArtifacts(checkpoint);
  await rm(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(resolve(root, '.staging-'));
  try {
    for (const resource of resources) {
      mkdirSync(resolve(staging, resource), { recursive: true, mode: 0o700 });
    }
    if (checkpoint.filesystemArtifactDigest) {
      const fileManifest = loadFileManifestArtifact(checkpoint.filesystemArtifactDigest);
      assertManifestResources(fileManifest.entries, new Set(resources));
      materializeFileManifest(fileManifest, staging);
    }
    if (checkpoint.databaseArtifactDigest) {
      const database = singleSqliteFile(profile);
      const artifact = getArtifact(checkpoint.databaseArtifactDigest)!;
      const destination = containedResourcePath(staging, database.resource, database.relativePath);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(artifact.localPath, destination);
    } else if (profile.sqliteFiles.length > 0) {
      throw new Error('Checkpoint is missing the SQLite artifact required by its profile');
    }

    const recoveryResources: RecoveryManifest['resources'] = [];
    for (const resource of resources) {
      const archive = `${createHash('sha256').update(resource).digest('hex').slice(0, 16)}.tar.gz`;
      const archivePath = resolve(root, archive);
      await execFileAsync('tar', ['-czf', archivePath, '-C', resolve(staging, resource), '.']);
      const bytes = statSync(archivePath).size;
      recoveryResources.push({
        resource,
        archive,
        digest: fileDigest(archivePath),
        bytes,
      });
    }
    const recovery: RecoveryManifest = {
      version: 1,
      applicationId: input.applicationId,
      siteId: input.siteId,
      specDigest: input.context.runtime.execution.specDigest,
      configurationDigest: input.context.runtime.configurationDigest,
      resources: recoveryResources,
    };
    const manifestPath = resolve(root, 'recovery-manifest.json');
    const content = `${JSON.stringify(recovery, null, 2)}\n`;
    writeFileSync(manifestPath, content, { encoding: 'utf8', mode: 0o600 });
    const artifact: GraphRecoveryArtifact = {
      artifactReference: manifestPath,
      artifactDigest: bufferDigest(Buffer.from(content)),
      verification: `semantic-checkpoint:${checkpoint.id}`,
    };
    await input.executor.restoreRecoveryPoint(input.context, artifact);
    writeFileSync(
      markerPath,
      `${JSON.stringify({
        checkpointId: checkpoint.id,
        manifestArtifactDigest: checkpoint.manifestArtifactDigest,
        specDigest: input.context.runtime.execution.specDigest,
        configurationDigest: input.context.runtime.configurationDigest,
        restoredAt: new Date().toISOString(),
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    return {
      checkpointId: checkpoint.id,
      manifestArtifactDigest: checkpoint.manifestArtifactDigest,
      resources,
      reused: false,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Quiesce/capture the graph, select only profile-approved paths, and emit a signed branch. */
export async function captureSuitcaseDataBranch(input: {
  applicationId: string;
  siteId: string;
  baseCheckpointId: string;
  profileVersion?: string | null;
  context: GraphExecutorContext;
  executor: SuitcaseDataExecutor;
  explicitManual?: boolean;
  actor?: string;
  /** Leave the graph cold so a coordinator can restore the merged checkpoint atomically. */
  resumeAfterCapture?: boolean;
}): Promise<CapturedBranchResult> {
  const pending = getSqlite()!
    .prepare(
      `SELECT id FROM data_changesets
        WHERE app_id = ? AND origin_site_id = ? AND status IN ('pending', 'conflicted', 'blocked')
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(input.applicationId, input.siteId) as { id: string } | undefined;
  if (pending) return { status: 'pending', changesetId: pending.id };

  const checkpoint = checkpointRecord(input.applicationId, input.baseCheckpointId);
  const profile = reconciliationProfile(
    input.applicationId,
    checkpoint.profileVersion || input.profileVersion,
  );
  const branchRoot = deployDataPath('branch-capture');
  mkdirSync(branchRoot, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(resolve(branchRoot, `${safeSegment(input.applicationId)}-`));
  try {
    const recovery = await input.executor.createRecoveryPoint(
      input.context,
      resolve(root, 'cold'),
      { resume: input.resumeAfterCapture !== false },
    );
    const raw = await extractRecoveryCapture(recovery, resolve(root, 'raw'));

    const database = profile.sqliteFiles.length > 0 ? singleSqliteFile(profile) : undefined;
    const databasePath = database
      ? containedResourcePath(raw, database.resource, database.relativePath)
      : undefined;
    if (database && databasePath && !existsSync(databasePath)) {
      throw new Error(
        `Captured volume is missing profiled SQLite file ${database.resource}/${database.relativePath}`,
      );
    }
    const filesRoot = resolve(root, 'files');
    mkdirSync(filesRoot, { recursive: true, mode: 0o700 });
    copyProfiledUploads(profile, raw, filesRoot);

    const filesPresent = profile.uploadPaths.length > 0;
    if (branchMatchesCheckpoint({ checkpoint, databasePath, filesRoot, filesPresent })) {
      return { status: 'unchanged' };
    }
    const changeset = await createDataChangeset({
      appId: input.applicationId,
      originSiteId: input.siteId,
      baseCheckpointId: checkpoint.id,
      databasePath,
      databaseLogicalPath: database ? `${database.resource}/${database.relativePath}` : undefined,
      filesRoot: filesPresent ? filesRoot : undefined,
      schemaFingerprint: profile.schemaFingerprint || undefined,
      explicitManual: input.explicitManual,
      actor: input.actor,
    });
    return {
      status: 'captured',
      changesetId: changeset.id,
      authenticatedDigest: changeset.authenticatedDigest,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Capture Home's live branch through the same quiesced graph/profile path as a Suitcase. */
export async function captureHomeDataBranch(input: {
  applicationId: string;
  homeSiteId: string;
  explicitManual?: boolean;
  executor?: SuitcaseDataExecutor;
}): Promise<CapturedBranchResult> {
  const application = resolveLocalDataApplication(input.applicationId, input.homeSiteId);
  return captureSuitcaseDataBranch({
    applicationId: application.applicationId,
    siteId: application.siteId,
    baseCheckpointId: application.baseCheckpointId,
    profileVersion: application.profileVersion,
    context: application.context,
    executor: input.executor || new ApplicationGraphExecutor(),
    explicitManual: input.explicitManual,
    actor: `system@${input.homeSiteId}`,
    // Home must not accept writes between its branch snapshot and adoption of
    // the merged checkpoint. A conflict intentionally leaves it cold until an
    // administrator resolves the branch and the restore succeeds.
    resumeAfterCapture: false,
  });
}

/** Adopt a verified merged checkpoint into Home's physical graph before declaring data ready. */
export async function restoreHomeDataCheckpoint(input: {
  applicationId: string;
  homeSiteId: string;
  checkpointId: string;
  executor?: SuitcaseDataExecutor;
}): Promise<RestoredCheckpointEvidence> {
  const application = resolveLocalDataApplication(input.applicationId, input.homeSiteId, {
    checkpointId: input.checkpointId,
  });
  return restoreSuitcaseCheckpoint({
    applicationId: application.applicationId,
    siteId: application.siteId,
    checkpointId: input.checkpointId,
    profileVersion: application.profileVersion,
    spec: application.spec,
    context: application.context,
    executor: input.executor || new ApplicationGraphExecutor(),
  });
}

export function resolveLocalDataApplication(
  applicationId: string,
  siteId: string,
  options: { checkpointId?: string; allowSiteLocal: true },
): LocalDataApplication | SiteLocalDataApplication;
export function resolveLocalDataApplication(
  applicationId: string,
  siteId: string,
  options?: { checkpointId?: string; allowSiteLocal?: false },
): LocalDataApplication;
export function resolveLocalDataApplication(
  applicationId: string,
  siteId: string,
  options: { checkpointId?: string; allowSiteLocal?: boolean } = {},
): LocalDataApplication | SiteLocalDataApplication {
  const sqlite = getSqlite()!;
  const row = sqlite
    .prepare(
      `SELECT d.name, d.active_spec_digest, d.desired_spec_digest, d.directory,
              d.memory_limit, d.cpu_limit, r.profile_version, r.base_checkpoint_id,
              r.data_mode, r.shared_lineage, r.removed_at
         FROM deployments d JOIN app_replicas r ON r.app_id = d.app_id
        WHERE d.app_id = ? AND r.site_id = ?`,
    )
    .get(applicationId, siteId) as
    | {
        name: string;
        active_spec_digest: string | null;
        desired_spec_digest: string | null;
        directory: string | null;
        memory_limit: string | null;
        cpu_limit: string | null;
        profile_version: string | null;
        base_checkpoint_id: string | null;
        data_mode: string;
        shared_lineage: number;
        removed_at: string | null;
      }
    | undefined;
  if (!row || row.removed_at) throw new Error('Active Home data replica not found');
  if (!options.allowSiteLocal && (row.data_mode !== 'replicated' || row.shared_lineage !== 1)) {
    throw new Error('Home data replica is not in the shared reconciliation lineage');
  }
  if (!row.profile_version) throw new Error('Home data replica has no reconciliation profile');
  const baseCheckpointId = options.checkpointId || row.base_checkpoint_id || null;
  if (!baseCheckpointId && !options.allowSiteLocal) {
    throw new Error('Home data replica has no retained base checkpoint');
  }
  const specDigest = row.active_spec_digest || row.desired_spec_digest;
  const revision = specDigest ? getApplicationSpecRevision(row.name, specDigest) : undefined;
  if (!revision) throw new Error('Home data replica has no active immutable graph');
  const spec = parseStoredApplicationSpec(revision.normalizedSpec);
  const configuration = resolveApplicationConfiguration({
    deploymentName: row.name,
    specDigest: revision.digest,
    declarations: spec.configuration,
    siteId,
  });
  if (!configuration.ready) {
    throw new Error(`Home configuration is missing: ${configuration.missing.join(', ')}`);
  }
  const runtime = buildApplicationGraphRuntime({
    applicationId,
    specDigest: revision.digest,
    spec,
    configuration,
  });
  if (!runtime.ready) {
    throw new Error(
      runtime.execution.findings
        .filter((finding) => finding.severity === 'error')
        .map((finding) => finding.message)
        .join('; ') || 'Home graph is not admissible for shared-data materialization',
    );
  }
  return {
    applicationId,
    deploymentName: row.name,
    siteId,
    profileVersion: row.profile_version,
    baseCheckpointId,
    spec,
    context: {
      deploymentName: row.name,
      applicationId,
      siteId,
      nodeId: 'coordinator',
      projectDirectory: row.directory || process.cwd(),
      runtime,
      memoryLimit: row.memory_limit || '4g',
      cpuLimit: row.cpu_limit || undefined,
      writerSiteId: applicationWriterSiteId(applicationId),
    },
  };
}

function reconciliationProfile(appId: string, version?: string | null): ReconciliationProfile {
  if (!version) throw new Error('Shared data requires a persisted reconciliation profile');
  const row = getSqlite()!
    .prepare(
      `SELECT id, schema_fingerprint, sqlite_files, upload_paths
         FROM data_reconciliation_profiles WHERE app_id = ? AND (id = ? OR version = ?)
         ORDER BY created_at DESC LIMIT 1`,
    )
    .get(appId, version, version) as
    | {
        id: string;
        schema_fingerprint: string | null;
        sqlite_files: string;
        upload_paths: string;
      }
    | undefined;
  if (!row) throw new Error(`Reconciliation profile ${version} is not materialized`);
  return {
    id: row.id,
    schemaFingerprint: row.schema_fingerprint,
    sqliteFiles: JSON.parse(row.sqlite_files) as SQLiteFileProfile[],
    uploadPaths: JSON.parse(row.upload_paths) as string[],
  };
}

function checkpointRecord(appId: string, checkpointId: string): CheckpointRecord {
  const row = getSqlite()!
    .prepare(
      `SELECT id, database_artifact_digest, filesystem_artifact_digest,
              manifest_artifact_digest, schema_fingerprint, profile_version
         FROM data_checkpoints
        WHERE id = ? AND app_id = ? AND verification_status = 'verified'`,
    )
    .get(checkpointId, appId) as
    | {
        id: string;
        database_artifact_digest: string | null;
        filesystem_artifact_digest: string | null;
        manifest_artifact_digest: string;
        schema_fingerprint: string | null;
        profile_version: string | null;
      }
    | undefined;
  if (!row) throw new Error(`Verified checkpoint ${checkpointId} is not materialized`);
  return {
    id: row.id,
    databaseArtifactDigest: row.database_artifact_digest,
    filesystemArtifactDigest: row.filesystem_artifact_digest,
    manifestArtifactDigest: row.manifest_artifact_digest,
    schemaFingerprint: row.schema_fingerprint,
    profileVersion: row.profile_version,
  };
}

async function verifyCheckpointArtifacts(checkpoint: CheckpointRecord): Promise<void> {
  for (const digest of [
    checkpoint.manifestArtifactDigest,
    checkpoint.databaseArtifactDigest,
    checkpoint.filesystemArtifactDigest,
  ].filter((value): value is string => Boolean(value))) {
    if (!getArtifact(digest) || !(await verifyArtifact(digest))) {
      throw new Error(`Checkpoint artifact ${digest} is missing or corrupt`);
    }
  }
}

function singleSqliteFile(profile: ReconciliationProfile): SQLiteFileProfile {
  if (profile.sqliteFiles.length !== 1) {
    throw new Error(
      `Generic v1 reconciliation supports exactly one SQLite file, found ${profile.sqliteFiles.length}`,
    );
  }
  return profile.sqliteFiles[0]!;
}

function managedResources(spec: ApplicationSpec): string[] {
  const bind = Object.entries(spec.resources).find(
    ([, resource]) => resource.source?.type === 'bind',
  );
  if (bind) throw new Error(`Shared checkpoints cannot restore bind resource ${bind[0]}`);
  return Object.keys(spec.resources).sort();
}

function assertManifestResources(
  entries: Record<string, { path: string }>,
  resources: ReadonlySet<string>,
): void {
  for (const entry of Object.values(entries)) {
    const normalized = entry.path.replaceAll('\\', '/');
    const resource = normalized.split('/')[0];
    if (!resource || !resources.has(resource)) {
      throw new Error(`Checkpoint file path ${entry.path} does not name a declared resource`);
    }
  }
}

function splitProfilePath(value: string): { resource: string; path: string } {
  const normalized = value.replaceAll('\\', '/');
  const slash = normalized.indexOf('/');
  if (slash <= 0 || slash === normalized.length - 1) {
    throw new Error(`Invalid reconciliation profile path ${value}`);
  }
  return { resource: normalized.slice(0, slash), path: normalized.slice(slash + 1) };
}

function containedResourcePath(root: string, resource: string, child: string): string {
  const resourceRoot = resolve(root, safeSegment(resource));
  const destination = resolve(resourceRoot, child);
  if (destination !== resourceRoot && !destination.startsWith(`${resourceRoot}${sep}`)) {
    throw new Error(`Profile path ${resource}/${child} escapes its resource`);
  }
  return destination;
}

function parseRecoveryManifest(artifact: GraphRecoveryArtifact): RecoveryManifest {
  const content = readFileSync(artifact.artifactReference);
  if (bufferDigest(content) !== artifact.artifactDigest) {
    throw new Error('Cold capture manifest digest changed after graph restart');
  }
  const parsed = JSON.parse(content.toString('utf8')) as RecoveryManifest;
  if (parsed.version !== 1 || !Array.isArray(parsed.resources)) {
    throw new Error('Cold capture manifest format is invalid');
  }
  return parsed;
}

async function extractRecoveryCapture(
  artifact: GraphRecoveryArtifact,
  destinationRoot: string,
): Promise<string> {
  mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  const manifest = parseRecoveryManifest(artifact);
  for (const resource of manifest.resources) {
    const destination = resolve(destinationRoot, safeSegment(resource.resource));
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    const archive = resolve(dirname(artifact.artifactReference), resource.archive);
    await inspectUploadArchive(archive);
    await execFileAsync('tar', ['-xzf', archive, '-C', destination]);
  }
  return destinationRoot;
}

function copyProfiledUploads(
  profile: ReconciliationProfile,
  sourceRoot: string,
  destinationRoot: string,
): void {
  for (const logicalPath of profile.uploadPaths) {
    const { resource, path } = splitProfilePath(logicalPath);
    const source = containedResourcePath(sourceRoot, resource, path);
    if (!existsSync(source)) continue;
    const destination = containedResourcePath(destinationRoot, resource, path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(source, destination);
  }
}

function branchMatchesCheckpoint(input: {
  checkpoint: CheckpointRecord;
  databasePath?: string;
  filesRoot: string;
  filesPresent: boolean;
}): boolean {
  const databaseMatches = input.databasePath
    ? input.checkpoint.databaseArtifactDigest === fileDigest(input.databasePath)
    : !input.checkpoint.databaseArtifactDigest;
  const filesMatches = input.filesPresent
    ? Boolean(input.checkpoint.filesystemArtifactDigest) &&
      loadFileManifestArtifact(input.checkpoint.filesystemArtifactDigest!).rootDigest ===
        createFileManifest(input.filesRoot).rootDigest
    : !input.checkpoint.filesystemArtifactDigest;
  return databaseMatches && filesMatches;
}

function fileDigest(path: string): `sha256:${string}` {
  return bufferDigest(readFileSync(path));
}

function bufferDigest(value: Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function safeSegment(value: string): string {
  const safe = value.replaceAll(/[^a-zA-Z0-9_.-]/g, '_');
  if (!safe || safe === '.' || safe === '..') throw new Error('Unsafe data bridge identifier');
  return safe;
}

export function relativeCapturedPath(root: string, path: string): string {
  return relative(resolve(root), resolve(path)).split(sep).join('/');
}
