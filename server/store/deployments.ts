import { assertCiMutation } from '../ci-fence.ts';
import {
  getDb,
  refreshDeploymentInCache,
  loadDeploymentsCache,
  _deploymentsCache,
} from './connection.ts';
import {
  deployments,
  componentServices,
  serviceEndpoints,
  actualVolumeAttachments,
  componentProfileOperations,
  componentProfileValues,
  componentJobExecutions,
  componentInstances,
  componentPlacements,
  applicationConfigurationValues,
  applicationSpecRevisions,
  applicationSpecTransitions,
} from '../schema.ts';
import { eq, inArray } from 'drizzle-orm';
import { notifyRouteChanged } from '../ipc.ts';
import { assertDeployRole, getNode } from './nodes.ts';

// ── Deployments ─────────────────────────────────────────────────────────────

interface DeploymentInput {
  name: string;
  type?: string;
  username: string;
  port?: number;
  containerId?: string;
  containerName?: string;
  directory?: string;
  extraPorts?: string | null;
  desiredNodeId?: string | null;
  activeNodeId?: string | null;
  createdAt?: string;
}

export function saveDeployment(deployment: DeploymentInput) {
  assertCiMutation(deployment.name);
  const db = getDb();
  const now = new Date().toISOString();
  db.insert(deployments)
    .values({
      name: deployment.name,
      type: deployment.type || null,
      username: deployment.username,
      port: deployment.port || null,
      containerId: deployment.containerId || null,
      containerName: deployment.containerName || null,
      directory: deployment.directory || null,
      extraPorts: deployment.extraPorts || null,
      desiredNodeId: deployment.desiredNodeId || null,
      activeNodeId: deployment.activeNodeId || null,
      createdAt: deployment.createdAt || now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: deployments.name,
      set: {
        type: deployment.type || null,
        username: deployment.username,
        port: deployment.port || null,
        containerId: deployment.containerId || null,
        containerName: deployment.containerName || null,
        directory: deployment.directory || null,
        extraPorts: deployment.extraPorts || null,
        ...(deployment.desiredNodeId !== undefined
          ? { desiredNodeId: deployment.desiredNodeId }
          : {}),
        ...(deployment.activeNodeId !== undefined ? { activeNodeId: deployment.activeNodeId } : {}),
        updatedAt: now,
      },
    })
    .run();
  refreshDeploymentInCache(deployment.name);
}

/**
 * Make a deployment visible while its first build is in progress without
 * clearing the active runtime fields of an existing deployment.
 */
export function registerDeploymentStart(name: string, username: string, type: string) {
  const db = getDb();
  const now = new Date().toISOString();
  db.insert(deployments)
    .values({
      name,
      type,
      username,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: deployments.name,
      set: { type, username, updatedAt: now },
    })
    .run();
  refreshDeploymentInCache(name);
}

export function getDeployment(name: string) {
  return loadDeploymentsCache().get(name) ?? null;
}

/**
 * Read one deployment row without the cache. Services in other processes (the
 * pipeline worker) never see the control process's cache writes, so release
 * authority checks must not trust a cache loaded before the app existed.
 */
export function readDeploymentRecord(name: string) {
  return getDb().select().from(deployments).where(eq(deployments.name, name)).get() ?? null;
}

export function updateDeploymentConfigurationDigest(deploymentName: string, digest: string) {
  assertCiMutation(deploymentName);
  getDb()
    .update(deployments)
    .set({ configurationDigest: digest, updatedAt: new Date().toISOString() })
    .where(eq(deployments.name, deploymentName))
    .run();
  refreshDeploymentInCache(deploymentName);
}

/** Link verified content-store artifacts to the stable application identity before fleet publish. */
export function updateDeploymentArtifactDigests(
  deploymentName: string,
  artifacts: {
    sourceArtifactDigest?: string | null;
    imageArtifactDigest?: string | null;
    snapshotArtifactDigest?: string | null;
  },
) {
  assertCiMutation(deploymentName);
  const values: Partial<typeof deployments.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };
  if (artifacts.sourceArtifactDigest !== undefined) {
    values.sourceArtifactDigest = artifacts.sourceArtifactDigest;
  }
  if (artifacts.imageArtifactDigest !== undefined) {
    values.imageArtifactDigest = artifacts.imageArtifactDigest;
  }
  if (artifacts.snapshotArtifactDigest !== undefined) {
    values.snapshotArtifactDigest = artifacts.snapshotArtifactDigest;
  }
  getDb().update(deployments).set(values).where(eq(deployments.name, deploymentName)).run();
  refreshDeploymentInCache(deploymentName);
}

/** Preserve the retained repository checkout for deferred graph activation. */
export function updateDeploymentSourceDirectory(deploymentName: string, directory: string) {
  assertCiMutation(deploymentName);
  getDb()
    .update(deployments)
    .set({ directory, updatedAt: new Date().toISOString() })
    .where(eq(deployments.name, deploymentName))
    .run();
  refreshDeploymentInCache(deploymentName);
}

/** Promote a site-local desired revision only after its physical graph passed health admission. */
export function recordMaterializedApplicationRuntime(input: {
  deploymentName: string;
  specDigest: string;
  siteId: string;
  projectDirectory: string;
  primaryPort: number | null;
  primaryContainerId: string | null;
  primaryContainerName: string | null;
}) {
  assertCiMutation(input.deploymentName);
  getDb()
    .update(deployments)
    .set({
      type: 'application-graph',
      activeSpecDigest: input.specDigest,
      activeNodeId: input.siteId,
      directory: input.projectDirectory,
      port: input.primaryPort,
      containerId: input.primaryContainerId,
      containerName: input.primaryContainerName,
      status: 'running',
      containerStartedAt: Date.now(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(deployments.name, input.deploymentName))
    .run();
  refreshDeploymentInCache(input.deploymentName);
}

export function getDeployments(username: string) {
  // Read straight from SQLite rather than the process-local `_deploymentsCache`.
  // That cache is a module singleton loaded once per process/worker and is only
  // invalidated in the process that performs a write; the RSC server-action
  // worker that backs the dashboard never sees writes made by the API process,
  // so its cached list goes stale (showing e.g. 6 apps while the DB has 8).
  // `getDashboardAggregate` already reads the DB directly for the same reason —
  // this keeps the list read consistent with it. The list read is low-frequency
  // (dashboard/CLI), so skipping the cache costs nothing meaningful; the cached
  // single-row `getDeployment` still backs the proxy hot path.
  const db = getDb();
  return db.select().from(deployments).where(eq(deployments.username, username)).all();
}

export function deleteDeployment(name: string) {
  assertCiMutation(name);
  const db = getDb();
  db.transaction((tx) => {
    const serviceIds = tx
      .select({ id: componentServices.id })
      .from(componentServices)
      .where(eq(componentServices.deploymentName, name))
      .all()
      .map((row) => row.id);
    if (serviceIds.length > 0) {
      tx.delete(serviceEndpoints).where(inArray(serviceEndpoints.serviceId, serviceIds)).run();
    }
    tx.delete(actualVolumeAttachments)
      .where(eq(actualVolumeAttachments.deploymentName, name))
      .run();
    tx.delete(componentProfileOperations)
      .where(eq(componentProfileOperations.deploymentName, name))
      .run();
    tx.delete(componentProfileValues).where(eq(componentProfileValues.deploymentName, name)).run();
    tx.delete(componentJobExecutions).where(eq(componentJobExecutions.deploymentName, name)).run();
    tx.delete(componentInstances).where(eq(componentInstances.deploymentName, name)).run();
    tx.delete(componentPlacements).where(eq(componentPlacements.deploymentName, name)).run();
    tx.delete(componentServices).where(eq(componentServices.deploymentName, name)).run();
    // These v1 records are keyed by the human-readable deployment name rather
    // than an immutable application id. Keeping them after deletion would let
    // a later owner of the same name inherit encrypted configuration and see
    // the previous owner's manifest history.
    tx.delete(applicationConfigurationValues)
      .where(eq(applicationConfigurationValues.deploymentName, name))
      .run();
    tx.delete(applicationSpecRevisions)
      .where(eq(applicationSpecRevisions.deploymentName, name))
      .run();
    tx.delete(applicationSpecTransitions)
      .where(eq(applicationSpecTransitions.deploymentName, name))
      .run();
    tx.delete(deployments).where(eq(deployments.name, name)).run();
  });
  _deploymentsCache?.delete(name);
  notifyRouteChanged(name);
}

export interface VolumeMount {
  component?: string;
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

export function updateDeploymentSettings(
  name: string,
  settings: {
    autoBackup?: boolean;
    discoverable?: boolean;
    envVars?: Record<string, string>;
    memoryLimit?: string;
    cpuLimit?: string;
    volumes?: VolumeMount[];
    gpuEnabled?: boolean;
    privilegedDocker?: boolean;
  },
) {
  assertCiMutation(name);
  const db = getDb();
  const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (settings.autoBackup !== undefined) set.autoBackup = settings.autoBackup;
  if (settings.discoverable !== undefined) set.discoverable = settings.discoverable;
  if (settings.envVars !== undefined) set.envVars = JSON.stringify(settings.envVars);
  if (settings.memoryLimit !== undefined) set.memoryLimit = settings.memoryLimit;
  if (settings.cpuLimit !== undefined) set.cpuLimit = settings.cpuLimit;
  if (settings.volumes !== undefined) set.volumes = JSON.stringify(settings.volumes);
  if (settings.gpuEnabled !== undefined) set.gpuEnabled = settings.gpuEnabled;
  if (settings.privilegedDocker !== undefined) set.privilegedDocker = settings.privilegedDocker;
  db.update(deployments).set(set).where(eq(deployments.name, name)).run();
  refreshDeploymentInCache(name);
}

export function setDeploymentDesiredNode(name: string, nodeId: string) {
  assertDeployRole(nodeId);
  assertCiMutation(name);
  const node = getNode(nodeId);
  if (!node || node.revokedAt) throw new Error('Node not found');
  const db = getDb();
  db.update(deployments)
    .set({ desiredNodeId: nodeId, updatedAt: new Date().toISOString() })
    .where(eq(deployments.name, name))
    .run();
  refreshDeploymentInCache(name);
  return getDeployment(name);
}

export function getDeploymentEnvVars(name: string): Record<string, string> {
  const d = getDeployment(name);
  if (!d?.envVars) return {};
  return JSON.parse(d.envVars);
}

export function getDeploymentVolumes(name: string): VolumeMount[] {
  const d = getDeployment(name);
  if (!d?.volumes) return [];
  return JSON.parse(d.volumes);
}

export function updateDeploymentStatus(name: string, status: string) {
  assertCiMutation(name);
  const db = getDb();
  db.update(deployments)
    .set({
      status,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(deployments.name, name))
    .run();
  refreshDeploymentInCache(name);
}

export function recordContainerStart(name: string) {
  const db = getDb();
  db.update(deployments)
    .set({ containerStartedAt: Date.now() })
    .where(eq(deployments.name, name))
    .run();
  refreshDeploymentInCache(name);
}

export function getAllDeployments() {
  return Array.from(loadDeploymentsCache().values());
}

export function getDiscoverableDeployments() {
  // Read directly from SQLite, not `_deploymentsCache` — same rationale as
  // `getDeployments`: the process-local cache goes stale in the RSC action
  // worker, so the discover list would otherwise miss recently-added (or show
  // recently-removed) apps.
  const db = getDb();
  return db.select().from(deployments).where(eq(deployments.discoverable, true)).all();
}
