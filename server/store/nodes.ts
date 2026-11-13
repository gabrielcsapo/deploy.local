import { materialized } from '../materialized.ts';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { nodes, computerRolePreferences, nodeEnrollments, deployments } from '../schema.ts';
import { getDb, getSqlite, refreshDeploymentInCache } from './connection.ts';
import { hostname, platform, arch, cpus, totalmem } from 'node:os';
import { configuredPlacementLabels } from '../application-placement.ts';
import { sql, eq, and } from 'drizzle-orm';
import { type WantedRoles, parseWantedRoles } from '../computer-roles.ts';
import { notifyRouteChanged } from '../ipc.ts';
import { setSystemSetting, getSystemSetting } from './settings.ts';

// Node liveness may age for two seconds; node/role writes invalidate immediately.
export const NODE_VIEW_CADENCE_MS = 2_000;
const nodeObservers = new Set<() => void>();
export function onNodeChange(listener: () => void) {
  nodeObservers.add(listener);
}
function invalidateNode(id: string) {
  nodeView.invalidate(id);
  preferenceView.invalidate(id);
  for (const listener of nodeObservers) listener();
}
const nodeView = materialized(readNode, { cadenceMs: NODE_VIEW_CADENCE_MS });
const preferenceView = materialized(readComputerRolePreferences, {
  cadenceMs: NODE_VIEW_CADENCE_MS,
});

// ── Fleet nodes ─────────────────────────────────────────────────────────────

const NODE_ONLINE_WINDOW_MS = 30_000;

const ENROLLMENT_TTL_MS = 10 * 60_000;

const DEFAULT_NODE_SETTING = 'default_node_id';

function hashNodeSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function publicNode<T extends typeof nodes.$inferSelect>(node: T) {
  const { credentialHash: _, ...safe } = node;
  const online =
    node.revokedAt == null &&
    (node.kind === 'coordinator' ||
      (node.lastSeenAt != null && Date.now() - node.lastSeenAt < NODE_ONLINE_WINDOW_MS));
  return { ...safe, online };
}

/** Ensure the machine hosting the control plane is represented in the fleet. */
export function ensureCoordinatorNode() {
  const db = getDb();
  const now = new Date().toISOString();
  const id = 'coordinator';
  db.insert(nodes)
    .values({
      id,
      name: process.env.DEPLOY_NODE_NAME || hostname(),
      kind: 'coordinator',
      platform: platform(),
      architecture: arch(),
      agentVersion:
        process.env.DEPLOY_COORDINATOR_VERSION || process.env.npm_package_version || null,
      address: '127.0.0.1',
      capabilities: JSON.stringify({
        cpuCount: cpus().length,
        memoryBytes: totalmem(),
        docker: true,
        labels: configuredPlacementLabels(),
      }),
      enrolledAt: now,
      lastSeenAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: nodes.id,
      set: {
        // Upgrade only the legacy default; an owner's chosen name always wins.
        name: sql`CASE WHEN ${nodes.name} = 'Main Host' THEN ${process.env.DEPLOY_NODE_NAME || hostname()} ELSE ${nodes.name} END`,
        platform: platform(),
        architecture: arch(),
        ...(process.env.DEPLOY_COORDINATOR_VERSION
          ? { agentVersion: process.env.DEPLOY_COORDINATOR_VERSION }
          : {}),
        capabilities: JSON.stringify({
          cpuCount: cpus().length,
          memoryBytes: totalmem(),
          docker: true,
          labels: configuredPlacementLabels(),
        }),
        lastSeenAt: Date.now(),
        revokedAt: null,
      },
    })
    .run();
  invalidateNode(id);
  return publicNode(db.select().from(nodes).where(eq(nodes.id, id)).get()!);
}

export const getComputerRolePreferences = (id: string) =>
  preferenceView.read(id, !getSqlite()!.inTransaction);
function readComputerRolePreferences(id: string): WantedRoles {
  const row = getDb()
    .select()
    .from(computerRolePreferences)
    .where(eq(computerRolePreferences.id, id))
    .get();
  return row ? JSON.parse(row.roles) : {};
}

/** CLI enrollment defaults preserve execution-agent-only clients. */
export function getAgentRoles(id: string) {
  return {
    deploy: true,
    tasks: false,
    computer: false,
    browser: false,
    ...getComputerRolePreferences(id),
  };
}

export function setComputerRolePreferences(id: string, roles: WantedRoles) {
  const merged = { ...readComputerRolePreferences(id), ...parseWantedRoles(roles) };
  getDb()
    .insert(computerRolePreferences)
    .values({ id, roles: JSON.stringify(merged) })
    .onConflictDoUpdate({
      target: computerRolePreferences.id,
      set: { roles: JSON.stringify(merged) },
    })
    .run();
  invalidateNode(id);
  return merged;
}

export function deployRoleEnabled(id: string) {
  return getComputerRolePreferences(id).deploy !== false;
}

export function assertDeployRole(id: string) {
  if (!deployRoleEnabled(id))
    throw new Error(
      'The deploy role is off on this computer. Turn it on in Computers before deploying here.',
    );
}

export function getNodes() {
  const db = getDb();
  return db
    .select()
    .from(nodes)
    .all()
    .map((node) => publicNode(node));
}

export const getNode = (id: string) => nodeView.read(id, !getSqlite()!.inTransaction);
function readNode(id: string) {
  const db = getDb();
  const node = db.select().from(nodes).where(eq(nodes.id, id)).get();
  return node ? publicNode(node) : null;
}

function enrollmentCode(): string {
  const raw = randomBytes(18).toString('base64url').toUpperCase();
  return `JOIN-${raw.match(/.{1,6}/g)!.join('-')}`;
}

export function createNodeEnrollment(name: string, createdBy: string, roles?: WantedRoles) {
  if (roles) parseWantedRoles(roles);
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('Node name is required');
  const db = getDb();
  const existing = db.select().from(nodes).where(eq(nodes.name, trimmedName)).get();
  if (existing && !existing.revokedAt)
    throw new Error(`A node named "${trimmedName}" already exists`);
  const code = enrollmentCode();
  const now = new Date();
  const id = randomBytes(16).toString('hex');
  const expiresAt = now.getTime() + ENROLLMENT_TTL_MS;
  db.insert(nodeEnrollments)
    .values({
      id,
      name: trimmedName,
      codeHash: hashNodeSecret(code),
      createdBy,
      createdAt: now.toISOString(),
      expiresAt,
    })
    .run();
  if (roles) setComputerRolePreferences(`enrollment:${id}`, roles);
  return { id, name: trimmedName, code, expiresAt };
}

export function redeemNodeEnrollment(input: {
  roles?: WantedRoles;
  code: string;
  name?: string;
  platform?: string;
  architecture?: string;
  agentVersion?: string;
  address?: string;
  capabilities?: Record<string, unknown>;
}) {
  if (input.roles) parseWantedRoles(input.roles);
  const db = getDb();
  const codeHash = hashNodeSecret(input.code.trim().toUpperCase());
  const enrollment = db
    .select()
    .from(nodeEnrollments)
    .where(eq(nodeEnrollments.codeHash, codeHash))
    .get();
  if (!enrollment || enrollment.usedAt || enrollment.expiresAt < Date.now()) {
    return { error: 'Enrollment code is invalid or expired' as const };
  }

  const name = input.name?.trim() || enrollment.name;
  if (name !== enrollment.name) {
    return { error: `This enrollment is reserved for "${enrollment.name}"` as const };
  }

  const existing = db.select().from(nodes).where(eq(nodes.name, name)).get();
  if (existing && !existing.revokedAt) {
    return { error: `A node named "${name}" already exists` as const };
  }

  const nodeId = existing?.id || `node_${randomBytes(12).toString('hex')}`;
  const secret = `node_secret_${randomBytes(32).toString('base64url')}`;
  const now = new Date().toISOString();
  db.transaction((tx) => {
    if (existing) {
      tx.update(nodes)
        .set({
          platform: input.platform || null,
          architecture: input.architecture || null,
          agentVersion: input.agentVersion || null,
          address: input.address || null,
          capabilities: JSON.stringify(input.capabilities || {}),
          credentialHash: hashNodeSecret(secret),
          enrolledAt: now,
          lastSeenAt: Date.now(),
          revokedAt: null,
        })
        .where(eq(nodes.id, nodeId))
        .run();
    } else {
      tx.insert(nodes)
        .values({
          id: nodeId,
          name,
          kind: 'agent',
          platform: input.platform || null,
          architecture: input.architecture || null,
          agentVersion: input.agentVersion || null,
          address: input.address || null,
          capabilities: JSON.stringify(input.capabilities || {}),
          credentialHash: hashNodeSecret(secret),
          enrolledAt: now,
          lastSeenAt: Date.now(),
        })
        .run();
    }
    tx.update(nodeEnrollments)
      .set({ usedAt: now })
      .where(eq(nodeEnrollments.id, enrollment.id))
      .run();
  });
  invalidateNode(nodeId);
  const roles = { ...getComputerRolePreferences(`enrollment:${enrollment.id}`), ...input.roles };
  if (Object.keys(roles).length) setComputerRolePreferences(nodeId, roles);
  return {
    nodeId,
    name,
    secret,
    enrollmentOwner: enrollment.createdBy,
    roles: getAgentRoles(nodeId),
  };
}

export function authenticateNode(nodeId: string | undefined, secret: string | undefined) {
  if (!nodeId || !secret) return false;
  const db = getDb();
  const node = db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
  if (!node?.credentialHash || node.revokedAt) return false;
  const actual = Buffer.from(hashNodeSecret(secret));
  const expected = Buffer.from(node.credentialHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function heartbeatNode(
  nodeId: string,
  details: {
    platform?: string;
    architecture?: string;
    agentVersion?: string;
    address?: string;
    capabilities?: Record<string, unknown>;
  },
) {
  const db = getDb();
  const previous = db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
  db.update(nodes)
    .set({
      platform: details.platform,
      architecture: details.architecture,
      agentVersion: details.agentVersion,
      address: details.address,
      capabilities: details.capabilities ? JSON.stringify(details.capabilities) : undefined,
      lastSeenAt: Date.now(),
    })
    .where(eq(nodes.id, nodeId))
    .run();
  invalidateNode(nodeId);
  if (details.address && previous?.address !== details.address) {
    const assigned = db
      .select({ name: deployments.name })
      .from(deployments)
      .where(eq(deployments.activeNodeId, nodeId))
      .all();
    for (const deployment of assigned) notifyRouteChanged(deployment.name);
  }
  return getNode(nodeId);
}

export function reconcileNodeRuntimePorts(
  nodeId: string,
  apps: Array<{
    name?: unknown;
    relayPort?: unknown;
    id?: unknown;
    containerName?: unknown;
    status?: unknown;
  }>,
) {
  const db = getDb();
  for (const app of apps) {
    const name = typeof app.name === 'string' ? app.name : '';
    const relayPort = Number(app.relayPort);
    if (!name || !Number.isInteger(relayPort) || relayPort <= 0 || relayPort > 65535) continue;
    // A stopped container's relay is a leftover; it must not become the app's address.
    if (app.status !== 'running') continue;
    const deployment = db
      .select()
      .from(deployments)
      .where(and(eq(deployments.name, name), eq(deployments.activeNodeId, nodeId)))
      .get();
    if (!deployment) continue;
    // A running container on the recorded port still restores 'running' (a release that failed
    // midway can leave the record 'unknown' while the app keeps serving).
    const recovers = deployment.status === 'unknown';
    if (deployment.port === relayPort && !recovers) continue;
    db.update(deployments)
      .set({
        port: relayPort,
        containerId: typeof app.id === 'string' ? app.id : deployment.containerId,
        containerName:
          typeof app.containerName === 'string' ? app.containerName : deployment.containerName,
        status: 'running',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(deployments.name, name))
      .run();
    refreshDeploymentInCache(name);
  }
}

export function revokeNode(nodeId: string) {
  if (nodeId === 'coordinator') throw new Error('The coordinator node cannot be revoked');
  const db = getDb();
  const node = db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
  if (!node) throw new Error('Node not found');
  db.update(nodes)
    .set({ revokedAt: new Date().toISOString(), credentialHash: null })
    .where(eq(nodes.id, nodeId))
    .run();
  invalidateNode(nodeId);
  if (getDefaultNodeId() === nodeId) setSystemSetting(DEFAULT_NODE_SETTING, '');
}

export function getDefaultNodeId(): string | null {
  return getSystemSetting(DEFAULT_NODE_SETTING) || null;
}

export function setDefaultNode(nodeId: string) {
  const node = getNode(nodeId);
  if (!node || node.revokedAt) throw new Error('Node not found');
  assertDeployRole(nodeId);
  setSystemSetting(DEFAULT_NODE_SETTING, nodeId);
  return node;
}

export function getFleetPlacementState() {
  ensureCoordinatorNode();
  const allNodes = getNodes().filter((node) => !node.revokedAt);
  const defaultNodeId = getDefaultNodeId();
  const defaultNode = defaultNodeId
    ? allNodes.find((node) => node.id === defaultNodeId && deployRoleEnabled(node.id)) || null
    : null;
  return {
    ready: Boolean(defaultNode),
    defaultNodeId,
    defaultNode,
    nodes: allNodes,
  };
}
