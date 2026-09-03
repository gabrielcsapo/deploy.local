import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  ApplicationGraphExecutor,
  type GraphExecutorContext,
  type GraphMaterializationResult,
} from './application-graph-executor.ts';
import { applicationWriterSiteId } from './application-authority.ts';
import {
  resolveApplicationGraphRuntime,
  type ResolvedApplicationGraphRuntime,
} from './application-runtime.ts';
import { deployDataDirectory } from './data-directory.ts';
import { getApplicationSpecRevision } from './store.ts';
import {
  createBackup as createLegacyBackup,
  getBackupDir,
  restoreBackup as restoreLegacyBackup,
} from './volumes.ts';

export interface CoordinatorBackupDeployment {
  name: string;
  appId?: string | null;
  directory?: string | null;
  activeNodeId?: string | null;
  desiredNodeId?: string | null;
  activeSpecDigest?: string | null;
  memoryLimit?: string | null;
  cpuLimit?: string | null;
}

export interface CoordinatorApplicationBackup {
  filename: string;
  sizeBytes: number;
  timestamp: string;
  volumeSizeBytes: number;
  volumePaths: string[];
  format: 'application-graph' | 'legacy';
}

export interface CoordinatorApplicationRestore {
  format: 'application-graph' | 'legacy';
  materialization?: GraphMaterializationResult;
}

type GraphBackupExecutor = Pick<
  ApplicationGraphExecutor,
  'createRecoveryPoint' | 'restoreRecoveryPoint' | 'converge'
>;

export interface CoordinatorApplicationBackupOptions {
  executor?: GraphBackupExecutor;
  backupDirectory?: (deploymentName: string) => string;
  manifestFormat?: (deployment: CoordinatorBackupDeployment) => 'deploy.yaml' | 'generated' | null;
  graphRuntime?: (deployment: CoordinatorBackupDeployment) => ResolvedApplicationGraphRuntime;
  legacyCreate?: typeof createLegacyBackup;
  legacyRestore?: typeof restoreLegacyBackup;
  now?: () => Date;
}

const GRAPH_BACKUP_PATTERN = /^.+-([a-f0-9]{64})\.graph$/;

/**
 * Create the coordinator-local recovery format appropriate for the active
 * immutable revision. Application graphs are archived as one cold recovery
 * point spanning every included consistency group.
 */
export async function createCoordinatorApplicationBackup(
  deployment: CoordinatorBackupDeployment,
  label?: string | null,
  options: CoordinatorApplicationBackupOptions = {},
): Promise<CoordinatorApplicationBackup> {
  if (!isApplicationGraph(deployment, options)) {
    const result = await (options.legacyCreate ?? createLegacyBackup)(
      deployment.name,
      label || undefined,
    );
    return {
      ...result,
      volumePaths: ['data', 'uploads'],
      format: 'legacy',
    };
  }

  assertCoordinatorLocal(deployment);
  const runtime = resolveCoordinatorRuntime(deployment, options);
  if (!runtime.ready) {
    throw new Error(`Required application configuration is missing: ${runtime.missing.join(', ')}`);
  }

  const backupRoot = (options.backupDirectory ?? getBackupDir)(deployment.name);
  const stagingDirectory = await mkdtemp(join(backupRoot, '.graph-backup-'));
  const executor = options.executor ?? new ApplicationGraphExecutor();
  const context = graphContext(deployment, runtime);
  let committedDirectory: string | null = null;
  try {
    const artifact = await executor.createRecoveryPoint(context, stagingDirectory);
    const expectedManifest = resolve(stagingDirectory, 'recovery-manifest.json');
    if (resolve(artifact.artifactReference) !== expectedManifest) {
      throw new Error('Graph recovery manifest escaped its backup staging directory');
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(artifact.artifactDigest)) {
      throw new Error('Graph recovery manifest digest is invalid');
    }

    const timestamp = (options.now ?? (() => new Date()))().toISOString();
    const timestampSegment = timestamp.replace(/[:.]/g, '-');
    const labelSuffix = label ? `-${label.replace(/[^a-zA-Z0-9-]/g, '_')}` : '';
    const digest = artifact.artifactDigest.slice('sha256:'.length);
    const filename = `${timestampSegment}${labelSuffix}-${digest}.graph`;
    const destination = resolve(backupRoot, filename);
    await rename(stagingDirectory, destination);
    committedDirectory = destination;
    const sizeBytes = directoryBytes(destination);
    return {
      filename,
      sizeBytes,
      timestamp,
      volumeSizeBytes: sizeBytes,
      volumePaths: selectedGraphResources(runtime),
      format: 'application-graph',
    };
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    if (committedDirectory) await rm(committedDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** Restore an exact graph recovery point cold, then reconverge the same graph. */
export async function restoreCoordinatorApplicationBackup(
  deployment: CoordinatorBackupDeployment,
  filename: string,
  options: CoordinatorApplicationBackupOptions = {},
): Promise<CoordinatorApplicationRestore> {
  if (basename(filename) !== filename) throw new Error('Invalid backup filename');
  if (!isApplicationGraph(deployment, options)) {
    if (filename.endsWith('.graph')) {
      throw new Error('Application graph recovery points require an active graph revision');
    }
    (options.legacyRestore ?? restoreLegacyBackup)(deployment.name, filename);
    return { format: 'legacy' };
  }

  assertCoordinatorLocal(deployment);
  const match = filename.match(GRAPH_BACKUP_PATTERN);
  if (!match) {
    throw new Error('The selected backup is not an application graph recovery point');
  }
  const runtime = resolveCoordinatorRuntime(deployment, options);
  if (!runtime.ready) {
    throw new Error(`Required application configuration is missing: ${runtime.missing.join(', ')}`);
  }
  const backupRoot = (options.backupDirectory ?? getBackupDir)(deployment.name);
  const artifactReference = resolve(backupRoot, filename, 'recovery-manifest.json');
  if (!existsSync(artifactReference)) throw new Error('Backup file not found');
  const executor = options.executor ?? new ApplicationGraphExecutor();
  const context = graphContext(deployment, runtime);
  await executor.restoreRecoveryPoint(context, {
    artifactReference,
    artifactDigest: `sha256:${match[1]}`,
  });
  return {
    format: 'application-graph',
    materialization: await executor.converge(context),
  };
}

export function isCoordinatorApplicationGraph(
  deployment: CoordinatorBackupDeployment,
  options: Pick<CoordinatorApplicationBackupOptions, 'manifestFormat'> = {},
): boolean {
  return isApplicationGraph(deployment, options);
}

function isApplicationGraph(
  deployment: CoordinatorBackupDeployment,
  options: Pick<CoordinatorApplicationBackupOptions, 'manifestFormat'>,
): boolean {
  const format = options.manifestFormat
    ? options.manifestFormat(deployment)
    : activeManifestFormat(deployment);
  return format === 'deploy.yaml' || format === 'generated';
}

function activeManifestFormat(
  deployment: CoordinatorBackupDeployment,
): 'deploy.yaml' | 'generated' | null {
  if (!deployment.activeSpecDigest) return null;
  const revision = getApplicationSpecRevision(deployment.name, deployment.activeSpecDigest);
  if (!revision) {
    throw new Error(
      `Active application revision ${JSON.stringify(deployment.activeSpecDigest)} was not found`,
    );
  }
  if (revision.manifestFormat === 'deploy.yaml' || revision.manifestFormat === 'generated') {
    return revision.manifestFormat;
  }
  throw new Error(`Unsupported active application manifest format ${revision.manifestFormat}`);
}

function resolveCoordinatorRuntime(
  deployment: CoordinatorBackupDeployment,
  options: CoordinatorApplicationBackupOptions,
): ResolvedApplicationGraphRuntime {
  return (options.graphRuntime ?? resolveApplicationGraphRuntime)({
    ...deployment,
    // This module intentionally owns only the coordinator Docker runtime.
    // Remote execution remains on the existing agent command path.
    activeNodeId: 'coordinator',
  });
}

function graphContext(
  deployment: CoordinatorBackupDeployment,
  runtime: ResolvedApplicationGraphRuntime,
): GraphExecutorContext {
  const applicationId = deployment.appId || deployment.name;
  return {
    deploymentName: deployment.name,
    applicationId,
    siteId: 'coordinator',
    nodeId: 'coordinator',
    projectDirectory: deployment.directory || deployDataDirectory(),
    runtime,
    writerSiteId: applicationWriterSiteId(applicationId),
    memoryLimit: deployment.memoryLimit || '4g',
    cpuLimit: deployment.cpuLimit || undefined,
  };
}

function assertCoordinatorLocal(deployment: CoordinatorBackupDeployment): void {
  if (deployment.activeNodeId && deployment.activeNodeId !== 'coordinator') {
    throw new Error('Application graph backup requires the coordinator-local control surface');
  }
}

function selectedGraphResources(runtime: ResolvedApplicationGraphRuntime): string[] {
  return Object.entries(runtime.spec.resources)
    .filter(([, resource]) => resource.backup.policy !== 'exclude')
    .sort(([leftName, left], [rightName, right]) => {
      const groupOrder = left.consistencyGroup.localeCompare(right.consistencyGroup);
      return groupOrder || leftName.localeCompare(rightName);
    })
    .map(([name]) => name);
}

function directoryBytes(path: string): number {
  return readdirSync(path, { withFileTypes: true }).reduce((total, entry) => {
    const child = resolve(path, entry.name);
    return total + (entry.isDirectory() ? directoryBytes(child) : statSync(child).size);
  }, 0);
}
