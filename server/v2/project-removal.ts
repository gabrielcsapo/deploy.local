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
import { applicationWriterSiteId } from '../application-authority.ts';
import { removeContainer } from '../docker.ts';
import { apiRemoveContainer, DockerApiError, listDeployContainers } from '../docker-api.ts';
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

export async function removeProjectContainer(name: string, remove = apiRemoveContainer) {
  try {
    await remove(name);
  } catch (error) {
    if (!(error instanceof DockerApiError && error.status === 404)) throw error;
  }
}
class ProjectRemovalDocker extends DockerCliGraphAdapter {
  override removeContainer(name: string) {
    return removeProjectContainer(name);
  }
}

type App = NonNullable<ReturnType<typeof getDeployment>>;
async function stopApp(app: App, jobId: string) {
  if (app.activeNodeId && app.activeNodeId !== 'coordinator') {
    if (!getNode(app.activeNodeId)?.online) fail('The computer running this app is offline', 409);
    for (const type of ['stop', 'delete']) {
      const job = enqueueAgentJob({
        id: `${jobId}-${type}`,
        nodeId: app.activeNodeId,
        deploymentName: app.name,
        type,
        payload: { deleteVolumes: true },
      });
      const deadline = Date.now() + 120_000;
      for (;;) {
        const result = getAgentJob(job.id);
        if (result?.status === 'complete') break;
        if (!result || result.status === 'failed') fail('The computer could not stop the app', 502);
        if (Date.now() > deadline) {
          cancelQueuedAgentJob(job.id, 'Project removal timed out');
          fail(
            'Still waiting for the computer to stop the app. Retry removal to check again.',
            409,
          );
        }
        await delay(500);
      }
    }
    return;
  }

  const revision = app.activeSpecDigest
    ? getApplicationSpecRevision(app.name, app.activeSpecDigest)
    : null;
  if (revision?.manifestFormat === 'deploy.yaml') {
    await new ApplicationGraphExecutor({ docker: new ProjectRemovalDocker() }).remove({
      applicationId: app.appId || app.name,
      siteId: applicationWriterSiteId(app.appId || app.name) || 'coordinator',
      managedVolumeResources: Object.entries(
        parseStoredApplicationSpec(revision.normalizedSpec).resources,
      )
        .filter(([, resource]) => resource.source?.type !== 'bind')
        .map(([name]) => name),
      removeInfrastructure: true,
    });
  } else {
    const prefix = `deploy-sh-${app.name.toLowerCase()}`;
    const containers = await listDeployContainers();
    await removeContainer(app.name);
    for (const container of containers) {
      const name = container.Names[0]?.replace(/^\//, '');
      if (name === prefix || name?.startsWith(`${prefix}-prev-`))
        await removeProjectContainer(name);
    }
    deleteVolumes(app.name);
  }
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
