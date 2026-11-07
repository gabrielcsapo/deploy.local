import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Project } from '../../shared/v2/contracts.ts';
import { db, list, save } from '../workspace/store.ts';
import {
  getDeployment,
  getApplicationSpecRevision,
  getSqlite,
  deleteDeployment,
  enqueueAgentJob,
  getAgentJob,
  getNode,
  cancelQueuedAgentJob,
} from '../store.ts';
import { ApplicationGraphExecutor } from '../application-graph-executor.ts';
import { removeContainer } from '../docker.ts';
import {
  apiRemoveContainer,
  apiRemoveNetwork,
  apiRemoveVolume,
  DockerApiError,
  listContainersByLabel,
  listDeployContainers,
  listNetworkNamesByLabel,
  listVolumeNamesByLabel,
  type ApiContainerSummary,
} from '../docker-api.ts';
import { DockerCliGraphAdapter } from '../graph-docker-adapter.ts';
import { getBackupDir, deleteVolumes } from '../volumes.ts';
import { parseStoredApplicationSpec } from '../application-spec.ts';
import { deployDataPath } from '../data-directory.ts';
import {
  assertFleetMutationReady,
  applicationDeleteMutationFingerprint,
} from '../fleet-mutation-guard.ts';
import { assertNoApplicationMutations, beginApplicationMutation } from './releases-fence.ts';
import { assertProjectWritable } from './project-policy.ts';
import { resolveProject } from './projects.ts';
import { readProjectBody } from './settings.ts';
import { fail } from '../errors.ts';

async function ignoreMissing(remove: () => Promise<unknown>) {
  try {
    await remove();
  } catch (error) {
    if (!(error instanceof DockerApiError && error.status === 404)) throw error;
  }
}
export function removeProjectContainer(name: string, remove = apiRemoveContainer) {
  return ignoreMissing(() => remove(name));
}

export interface ApplicationLeftovers {
  containers: string[];
  networks: string[];
  volumes: string[];
}

/**
 * The shared adapter ignores every removal error so a deploy can always clean up after itself.
 * Removing a project has to know: only a missing object counts as removed.
 */
export class ProjectRemovalDocker extends DockerCliGraphAdapter {
  override removeContainer(name: string) {
    return removeProjectContainer(name);
  }
  override removeNetwork(name: string) {
    return ignoreMissing(() => apiRemoveNetwork(name));
  }
  override removeVolume(name: string) {
    return ignoreMissing(() => apiRemoveVolume(name));
  }
  removeLegacyContainers(deploymentName: string) {
    return removeContainer(deploymentName);
  }
  /** What Docker still holds for this app, whichever instance rows it was recorded under. */
  async findLeftovers(
    deploymentName: string,
    applicationIds: readonly string[],
  ): Promise<ApplicationLeftovers> {
    const labels = [
      `deploy-sh.app=${deploymentName}`,
      ...applicationIds.map((id) => `deploy-sh.app-id=${id}`),
    ];
    const legacy = `deploy-sh-${deploymentName.toLowerCase()}`;
    const name = (container: ApiContainerSummary) => container.Names[0]?.replace(/^\//, '') ?? '';
    const containers = new Set<string>();
    for (const container of await listDeployContainers()) {
      if (name(container) === legacy || name(container).startsWith(`${legacy}-prev-`))
        containers.add(name(container));
    }
    const networks = new Set<string>();
    const volumes = new Set<string>();
    for (const label of labels) {
      for (const container of await listContainersByLabel(label)) containers.add(name(container));
      for (const network of await listNetworkNamesByLabel(label)) networks.add(network);
      for (const volume of await listVolumeNamesByLabel(label)) volumes.add(volume);
    }
    return { containers: [...containers], networks: [...networks], volumes: [...volumes] };
  }
}

type App = NonNullable<ReturnType<typeof getDeployment>>;
interface RemovalTargets {
  /** Instance rows on this machine, each under the site it was recorded with. */
  local: { applicationId: string; siteId: string }[];
  computers: string[];
  applicationIds: string[];
  /** Instance rows on a site this server has no way to reach. */
  unreachable: string[];
}

/** Every place this app may be running, taken from its rows rather than one assumed site. */
function removalTargets(app: App): RemovalTargets {
  const primaryId = app.appId || app.name;
  const sqlite = getSqlite()!;
  const home = (
    sqlite.prepare('SELECT home_site_id FROM fleets ORDER BY created_at LIMIT 1').get() as
      | { home_site_id: string }
      | undefined
  )?.home_site_id;
  const instances = sqlite
    .prepare(
      `SELECT DISTINCT app_id, site_id, node_id, status FROM component_instances
        WHERE app_id = ? OR deployment_name = ?`,
    )
    .all(primaryId, app.name) as {
    app_id: string;
    site_id: string;
    node_id: string | null;
    status: string;
  }[];
  const local = new Map<string, { applicationId: string; siteId: string }>();
  const addLocal = (applicationId: string, siteId: string) =>
    local.set(`${applicationId}\0${siteId}`, { applicationId, siteId });
  const computers = new Set<string>();
  const unreachable = new Set<string>();

  const placements = [app.activeNodeId, app.desiredNodeId].filter((id): id is string => !!id);
  if (placements.length === 0 || placements.includes('coordinator'))
    addLocal(primaryId, 'coordinator');
  for (const nodeId of placements) {
    if (nodeId === 'coordinator') continue;
    // A computer the app never reached has nothing on it once that computer is gone.
    const node = getNode(nodeId);
    if (nodeId === app.activeNodeId || (node && !node.revokedAt)) computers.add(nodeId);
  }
  for (const row of instances) {
    if (
      row.node_id === 'coordinator' ||
      (!row.node_id && (row.site_id === 'coordinator' || row.site_id === home))
    ) {
      addLocal(row.app_id, row.site_id);
      continue;
    }
    if (row.status === 'removed') continue;
    const computer = row.node_id || row.site_id;
    if (getNode(computer)) computers.add(computer);
    else unreachable.add(row.site_id);
  }
  return {
    local: [...local.values()],
    computers: [...computers],
    applicationIds: [...new Set([primaryId, ...instances.map((row) => row.app_id)])],
    unreachable: [...unreachable],
  };
}

function removalConfirmed(job: { result: string | null }) {
  try {
    return JSON.parse(job.result || '{}').verified === true;
  } catch {
    return false;
  }
}

/** Resume a job still in flight, but a job that ended without removing anything gets a new try. */
function removalJobId(base: string) {
  for (let attempt = 1; ; attempt++) {
    const id = attempt === 1 ? base : `${base}-${attempt}`;
    const job = getAgentJob(id);
    if (!job || job.status === 'queued' || job.status === 'running') return id;
    if (job.status === 'complete' && removalConfirmed(job)) return id;
  }
}

async function removeFromComputer(app: App, nodeId: string, jobId: string) {
  const job = enqueueAgentJob({
    id: removalJobId(`${jobId}-${nodeId}-delete`),
    nodeId,
    deploymentName: app.name,
    type: 'delete',
    payload: { deleteVolumes: true, applicationId: app.appId || app.name },
  });
  const deadline = Date.now() + 120_000;
  for (;;) {
    const result = getAgentJob(job.id);
    if (result?.status === 'complete') {
      // An older worker reports success without checking and leaves the network behind.
      if (!removalConfirmed(result))
        fail(
          'This computer needs a newer worker to confirm the app is gone. Update it, then retry removal.',
          409,
        );
      return;
    }
    if (!result || result.status === 'failed')
      fail(`The computer could not remove the app${result?.error ? `: ${result.error}` : ''}`, 502);
    if (Date.now() > deadline) {
      cancelQueuedAgentJob(job.id, 'Project removal timed out');
      fail('Still waiting for the computer to remove the app. Retry removal to check again.', 409);
    }
    await delay(500);
  }
}

async function removeFromThisMachine(
  app: App,
  targets: RemovalTargets,
  docker: ProjectRemovalDocker,
) {
  const revision = app.activeSpecDigest
    ? getApplicationSpecRevision(app.name, app.activeSpecDigest)
    : null;
  const managedVolumeResources = revision
    ? Object.entries(parseStoredApplicationSpec(revision.normalizedSpec).resources)
        .filter(([, resource]) => resource.source?.type !== 'bind')
        .map(([name]) => name)
    : [];
  const executor = new ApplicationGraphExecutor({ docker });
  for (const { applicationId, siteId } of targets.local)
    await executor.remove({
      applicationId,
      siteId,
      managedVolumeResources,
      removeInfrastructure: true,
    });
  if (revision?.manifestFormat !== 'deploy.yaml') await docker.removeLegacyContainers(app.name);

  // Rows can be stale or missing, so finish from what Docker reports. Containers go first because
  // Docker refuses to remove a network or volume that one of them still holds.
  const found = await docker.findLeftovers(app.name, targets.applicationIds);
  for (const name of found.containers) await docker.removeContainer(name);
  for (const name of found.networks) await docker.removeNetwork(name);
  for (const name of found.volumes) await docker.removeVolume(name);
  deleteVolumes(app.name);

  const left = await docker.findLeftovers(app.name, targets.applicationIds);
  const remaining = [...left.containers, ...left.networks, ...left.volumes];
  if (remaining.length > 0)
    fail(`Removal is not finished. Still on this machine: ${remaining.join(', ')}.`, 409);
}

export async function stopApp(app: App, jobId: string, docker = new ProjectRemovalDocker()) {
  const targets = removalTargets(app);
  if (targets.unreachable.length > 0)
    fail(`This app still has instances on ${targets.unreachable.join(', ')}, out of reach.`, 409);
  // Check every computer first, so one that is offline does not leave a half-removed app.
  for (const nodeId of targets.computers)
    if (!getNode(nodeId)?.online) fail('The computer running this app is offline', 409);
  for (const nodeId of targets.computers) await removeFromComputer(app, nodeId, jobId);
  if (targets.local.length > 0) await removeFromThisMachine(app, targets, docker);
}

export async function removeProject(
  owner: string,
  project: Project,
  confirmation: unknown,
  runtime = { stopApp },
) {
  if (confirmation !== project.name) fail('Confirm the project name before removing it');
  const releases: (() => unknown)[] = [];
  let receipt = list('v2-project-removal', owner).find((row) => row.id === project.id);
  db.transaction(() => {
    assertNoApplicationMutations(
      owner,
      project.apps.map((app) => app.id),
    );
    if (!receipt) assertProjectWritable(owner, project);
    else if (list('v2-project-run', owner).some((row) => row.id === project.id))
      fail('A release is running', 409);
    for (const member of project.apps) {
      const app = getDeployment(member.name);
      if (!app && receipt?.stopped.includes(member.name)) continue;
      if (!app || app.username !== owner) fail('App not found', 404);
      if (app.appId)
        assertFleetMutationReady({
          appId: app.appId,
          applicationName: app.name,
          kind: 'application-delete',
          mutationFingerprint: applicationDeleteMutationFingerprint(app.appId),
          consequence: 'Removing the project stops its apps and frees their addresses.',
          actor: owner,
        });
    }
    receipt ??= {
      id: project.id,
      project,
      archiveId: randomUUID(),
      removedAt: new Date().toISOString(),
      retainUntil: new Date(Date.now() + 30 * 86400_000).toISOString(),
      stopped: [],
    };
    if (!receipt.releaseRecords)
      receipt.releaseRecords = list('v2-release', owner).filter(
        (row) => row.release.projectId === project.id,
      );
    save('v2-project-removal', owner, receipt);
    for (const member of project.apps) releases.push(beginApplicationMutation(owner, member.name));
  }).immediate();
  const archive = deployDataPath('removed-projects', receipt!.archiveId);
  try {
    await mkdir(archive, { recursive: true });
    for (const [index, member] of project.apps.entries()) {
      const app = getDeployment(member.name)!;
      // Copy first. A failed stop remains retryable, and app-name reuse cannot inherit backups.
      if (existsSync(getBackupDir(member.name)))
        await cp(getBackupDir(member.name), join(archive, String(index)), { recursive: true });
      if (!receipt!.stopped.includes(member.name)) {
        await runtime.stopApp(app, `${receipt!.archiveId}-${index}`);
        receipt!.stopped.push(member.name);
        save('v2-project-removal', owner, receipt!);
      }
    }
    for (const member of project.apps) {
      if (getDeployment(member.name)) deleteDeployment(member.name);
      getSqlite()!
        .prepare('DELETE FROM project_applications WHERE owner=? AND application=?')
        .run(owner, member.name);
      await rm(getBackupDir(member.name), { recursive: true, force: true });
    }
    getSqlite()!
      .prepare('DELETE FROM project_configuration WHERE owner=? AND project_id=?')
      .run(owner, project.id);
    db.transaction(() => {
      db.prepare("DELETE FROM records WHERE kind='project' AND owner=? AND id=?").run(
        owner,
        project.id,
      );
      db.prepare("DELETE FROM records WHERE kind='v2-project-current' AND owner=? AND id=?").run(
        owner,
        project.id,
      );
      for (const row of list('v2-release', owner).filter(
        (entry) => entry.release.projectId === project.id,
      )) {
        const { backup: _backup, plan: _plan, ...audit } = row;
        save('v2-release', owner, { ...audit, codeExpiredAt: receipt!.removedAt });
      }
      receipt!.removedAt = new Date().toISOString();
      receipt!.retainUntil = new Date(Date.now() + 30 * 86400_000).toISOString();
      save('v2-removed-project', owner, {
        ...receipt,
        id: receipt!.archiveId,
        archive,
        completed: true,
      });
      db.prepare("DELETE FROM records WHERE kind='v2-project-removal' AND owner=? AND id=?").run(
        owner,
        project.id,
      );
    }).immediate();
    return { removed: true, retainUntil: receipt!.retainUntil };
  } finally {
    for (const release of releases) release();
  }
}
export async function purgeRemovedProjects(owner: string, time = Date.now()) {
  for (const row of list('v2-removed-project', owner)) {
    if (Date.parse(row.retainUntil) > time) continue;
    await rm(deployDataPath('removed-projects', row.archiveId), { recursive: true, force: true });
    db.prepare("DELETE FROM records WHERE kind='v2-removed-project' AND owner=? AND id=?").run(
      owner,
      row.id,
    );
  }
}
export async function projectRemovalApi(req: IncomingMessage, res: ServerResponse, owner: string) {
  const path = new URL(req.url!, 'http://localhost').pathname;
  if (req.method === 'GET' && path.startsWith('/api/v2/projects/removed')) {
    await purgeRemovedProjects(owner);
    if (path === '/api/v2/projects/removed') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify({
          projects: list('v2-removed-project', owner).map((row) => ({
            id: row.id,
            name: row.project.name,
            removedAt: row.removedAt,
            retainUntil: row.retainUntil,
            backupUrl: `/api/v2/projects/removed/${row.id}/backup`,
          })),
        }),
      );
      return true;
    }
    const download = path.match(/^\/api\/v2\/projects\/removed\/([^/]+)\/backup$/);
    if (!download) return false;
    const receipt = list('v2-removed-project', owner).find((row) => row.id === download[1]);
    if (!receipt) fail('Retained backups not found', 404);
    const child = spawn(
      'tar',
      ['-czf', '-', '-C', deployDataPath('removed-projects', receipt.archiveId), '.'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="project-backups-${receipt.archiveId}.tar.gz"`,
      'Cache-Control': 'no-store',
    });
    child.stdout.pipe(res, { end: false });
    child.stderr.resume();
    child.on('error', () => res.destroy());
    child.on('close', (code) => {
      if (code === 0) res.end();
      else res.destroy();
    });
    res.on('close', () => {
      if (child.exitCode === null) child.kill();
    });
    return true;
  }
  const match = path.match(/^\/api\/v2\/projects\/([^/]+)$/);
  if (!match || req.method !== 'DELETE') return false;
  const key = decodeURIComponent(match[1]);
  const pending = list('v2-project-removal', owner).find(
    (row) => row.id === key || row.project.name === key,
  );
  const project = pending?.project || (await resolveProject(owner, key));
  const result = await removeProject(owner, project, (await readProjectBody(req)).confirm);
  await purgeRemovedProjects(owner);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(result));
  return true;
}

// Expire retained copies even when nobody removes another project.
const cleanup = setInterval(() => {
  const owners = db
    .prepare("SELECT DISTINCT owner FROM records WHERE kind='v2-removed-project'")
    .all() as { owner: string }[];
  for (const { owner } of owners) void purgeRemovedProjects(owner).catch(() => {});
}, 3600_000);
cleanup.unref();
