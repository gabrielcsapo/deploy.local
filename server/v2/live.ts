import { sendJson } from '../http.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type {
  AppHealth,
  LiveApp,
  LiveAppResponse,
  LiveResponse,
  Role,
  Rollback,
  InboxItem,
} from '../../shared/v2/contracts.ts';
import { authenticateCi } from '../ci-releases.ts';
import { recentRestarts } from '../crash-tracker.ts';
import {
  authenticateNode,
  getApplicationSpecRevision,
  getCurrentHealth,
  getDeployment,
  getDeployments,
  getNodes,
  getSqlite,
  getRequestSeries,
} from '../store.ts';
import { db, event, list, save } from '../workspace/store.ts';
import { repositoryInfo } from '../workspace/repositories.ts';
import { createInboxItem } from './inbox.ts';
import { fail } from '../errors.ts';
import { currentProjectReleases, projectRollbacks, releaseById } from './releases.ts';
import { requestWorkerRollback } from './releases-api.ts';
import {
  recordWorker,
  validateReport,
  webHealth,
  workerHealth,
  workerRuntimeHealth,
  type WebEvidence,
  type WorkerState,
} from './health.ts';

type RequireAuth = (req: IncomingMessage, res: ServerResponse) => { username: string } | null;
const refreshes = new Map<
  string,
  { at: number; releases: string; pending?: Promise<LiveResponse>; value?: LiveResponse }
>();
const projects = new Map<string, { at: number; values: Map<string, string> }>();
async function projectNames(owner: string) {
  const previous = projects.get(owner);
  if (previous && Date.now() - previous.at < 60_000) return previous.values;
  const values = new Map<string, string>();
  for (const project of list('project', owner)) {
    if (!project.repositoryPath) continue;
    try {
      const repository = await repositoryInfo(owner, project.id);
      if ('deployment' in repository && repository.deployment.application)
        values.set(repository.deployment.application, project.id);
    } catch {
      /* A missing repository is not health evidence. */
    }
  }
  const links = getSqlite()!
    .prepare('SELECT application, project_id AS projectId FROM project_applications WHERE owner=?')
    .all(owner) as { application: string; projectId: string }[];
  for (const link of links) {
    values.delete(link.application);
    if (list('project', owner).some((project) => project.id === link.projectId))
      values.set(link.application, link.projectId);
  }
  projects.set(owner, { at: Date.now(), values });
  return values;
}

function appConfiguration(deployment: NonNullable<ReturnType<typeof getDeployment>>) {
  let kind: AppHealth['kind'] = deployment.type === 'worker' || !deployment.port ? 'worker' : 'web';
  let path: string | undefined;
  if (deployment.activeSpecDigest) {
    const revision = getApplicationSpecRevision(deployment.name, deployment.activeSpecDigest);
    if (revision) {
      try {
        const spec = JSON.parse(revision.normalizedSpec);
        const components = Object.values(spec.components ?? {}) as any[];
        if (components.length === 1) {
          kind = components[0].role === 'worker' ? 'worker' : 'web';
          const check = components[0].health;
          if (check && components[0].interfaces?.[check.interface]?.protocol === 'http')
            path = check.path ?? '/';
        }
      } catch {
        /* Invalid legacy configuration has no usable check. */
      }
    }
  }
  return { kind, path };
}

/**
 * The address the edge routes a remote app to: its ready, published endpoint. The deployment's own
 * port is only a relay port the agent last reported and can outlive the container behind it.
 */
function readyEndpoint(
  appId: string | null | undefined,
): { host: string; port: number } | undefined {
  if (!appId) return;
  const row = getSqlite()!
    .prepare(
      `SELECT se.host, se.port
         FROM component_services cs
         JOIN service_endpoints se
           ON se.service_id = cs.id AND se.admitted_generation = cs.membership_generation
        WHERE cs.app_id = ? AND cs.published = 1 AND se.readiness = 'ready'
        ORDER BY cs.id, se.id
        LIMIT 1`,
    )
    .get(appId) as { host: string; port: number } | undefined;
  return row && isIP(row.host) ? row : undefined;
}

async function checkHttp(host: string, port: number, path: string): Promise<WebEvidence['check']> {
  if (!isIP(host) || !path.startsWith('/') || path.startsWith('//')) return;
  const start = Date.now();
  let status = 0;
  try {
    const response = await fetch(
      `http://${host.includes(':') ? `[${host}]` : host}:${port}${path}`,
      { redirect: 'manual', signal: AbortSignal.timeout(3000) },
    );
    status = response.status;
    await response.body?.cancel();
  } catch {
    /* A timed-out configured check is evidence of failure. */
  }
  return { path, status, at: Date.now(), durationMs: Date.now() - start };
}

export function publishHealth(owner: string, app: AppHealth) {
  const previous = list('v2-health', owner).find((row) => row.id === app.appId);
  if (JSON.stringify(previous?.app) === JSON.stringify(app)) return;
  db.transaction(() => {
    save('v2-health', owner, { id: app.appId, app });
    event(owner, '', null, 'v2.health', { app });
  }).immediate();
}

export async function acceptWorkerReport(owner: string, body: unknown, now = Date.now()) {
  const report = validateReport(body);
  const app = getDeployment(report.appId);
  if (!app || app.username !== owner) fail('App not found', 404);
  const state = db
    .transaction(() => {
      const previous = list('v2-worker-health', owner).find((row) => row.id === report.appId);
      const state = recordWorker(previous?.state, report, now);
      save('v2-worker-health', owner, { id: report.appId, state });
      return state;
    })
    .immediate();
  const nodeId = app.activeNodeId || 'coordinator';
  const online = getNodes().find((node) => node.id === nodeId)?.online ?? nodeId === 'coordinator';
  const health = workerRuntimeHealth(
    workerHealth(report.appId, state, now),
    app.status ?? 'unknown',
    online,
    recentRestarts(app.name),
  );
  publishHealth(owner, health);
  await requestWorkerRollback(owner, health, now);
  refreshes.delete(owner);
  return health;
}

/** A healthy outcome needs ten minutes of continuous observed health after completion. */
export function updateRollbackOutcomes(
  owner: string,
  rollbacks: Rollback[],
  apps: LiveApp[],
  at = Date.now(),
) {
  for (const rollback of rollbacks) {
    if (!rollback.steps.every((step) => step.state === 'done' || step.state === 'skipped'))
      continue;
    const projectApps = apps.filter((app) => app.project === rollback.projectId);
    if (!projectApps.length || !projectApps.every((app) => app.release === rollback.to)) continue;
    const previous = list('v2-rollback-health', owner).find((row) => row.id === rollback.id);
    const healthy = projectApps.every((app) => app.state === 'healthy');
    const since = healthy
      ? previous?.healthy && at - previous.at <= 90000
        ? previous.since
        : at
      : undefined;
    save('v2-rollback-health', owner, { id: rollback.id, at, healthy, since });
    const outcome: InboxItem['outcome'] =
      healthy && at - since >= 600000
        ? { text: 'Healthy after 10 min', tone: 'ok' }
        : rollback.approvedBy === 'rule'
          ? { text: 'Allowed by rule', tone: 'neutral' }
          : undefined;
    if (!outcome) continue;
    const itemId = `rollback:${rollback.projectId}:${rollback.from}`;
    if (rollback.approvedBy === 'rule')
      createInboxItem(
        owner,
        {
          id: itemId,
          kind: 'rollback',
          title: `Roll back ${rollback.projectId} to ${rollback.to.slice(0, 7)}`,
          text: rollback.reason,
          from: 'warden',
          projectId: rollback.projectId,
          createdAt:
            rollback.steps.find((step) => step.startedAt)?.startedAt || new Date(at).toISOString(),
          actions: [{ id: 'rule', label: 'Allowed by rule' }],
          state: 'answered',
          outcome,
        },
        { rollbackId: rollback.id },
      );
    const row = list('v2-inbox-native', owner).find((entry) => entry.id === itemId);
    if (
      !row ||
      row.item.state !== 'answered' ||
      row.item.outcome?.text === 'Healthy after 10 min' ||
      JSON.stringify(row.item.outcome) === JSON.stringify(outcome)
    )
      continue;
    const item = { ...row.item, outcome };
    db.transaction(() => {
      save('v2-inbox-native', owner, { ...row, item });
      event(owner, rollback.projectId, null, 'v2.inbox', { item });
    }).immediate();
  }
}

async function collectLive(owner: string): Promise<LiveResponse> {
  const now = Date.now();
  const nodes = getNodes();
  const names = await projectNames(owner);
  const reports = new Map(
    list('v2-worker-health', owner).map((row) => [row.id, row.state as WorkerState]),
  );
  const releases = currentProjectReleases(owner);
  const discoveries = new Set(
    (
      getSqlite()!.prepare('SELECT application_name FROM catalog_installations').all() as {
        application_name: string;
      }[]
    ).map((row) => row.application_name),
  );
  const computers: LiveResponse['computers'] = [];
  for (const deployment of getDeployments(owner)) {
    const nodeId = deployment.activeNodeId || 'coordinator';
    const node = nodes.find((n) => n.id === nodeId);
    const online = node?.online ?? nodeId === 'coordinator';
    const config = appConfiguration(deployment);
    const metrics = getCurrentHealth(deployment.name);
    const restarts = recentRestarts(deployment.name);
    const heartbeatAt = node?.lastSeenAt ? new Date(node.lastSeenAt).toISOString() : undefined;
    const report = reports.get(deployment.name);
    const kind = report ? 'worker' : config.kind;
    let health: AppHealth;
    if (kind === 'worker') {
      health = workerRuntimeHealth(
        workerHealth(deployment.name, report, now),
        deployment.status ?? 'unknown',
        online,
        restarts,
      );
    } else {
      const endpoint = nodeId === 'coordinator' ? undefined : readyEndpoint(deployment.appId);
      const target = endpoint ?? {
        host: nodeId === 'coordinator' ? '127.0.0.1' : (node?.address ?? ''),
        port: deployment.port,
      };
      const check =
        online && deployment.status === 'running' && target.port && config.path
          ? await checkHttp(target.host, target.port, config.path)
          : undefined;
      health = webHealth(
        {
          appId: deployment.name,
          status: deployment.status ?? 'unknown',
          online,
          heartbeatAt,
          restarts,
          metrics,
          check,
        },
        now,
      );
    }
    const release = releases.find((r) =>
      r.release.apps.some((entry) => entry.appId === deployment.name),
    );
    const app: LiveApp = {
      ...health,
      name: deployment.name,
      ...(release || names.has(deployment.name)
        ? { project: release?.release.projectId ?? names.get(deployment.name) }
        : {}),
      ...(kind === 'web' && deployment.port ? { address: `https://${deployment.name}.local` } : {}),
      ...(release
        ? { release: release.id, releasedAt: release.releasedAt, source: release.release.source }
        : {}),
      ...(discoveries.has(deployment.name) ? { fromDiscover: true } : {}),
    };
    publishHealth(owner, health);
    if (release) await requestWorkerRollback(owner, health, now);
    let computer = computers.find((c) => c.id === nodeId);
    if (!computer) {
      let capabilities: Record<string, unknown> = {};
      try {
        capabilities = JSON.parse(node?.capabilities ?? '{}');
      } catch {
        /* Missing measurements stay missing. */
      }
      const roles: Role[] = nodeId === 'coordinator' ? ['coordinator', 'run-apps'] : ['run-apps'];
      computer = {
        id: nodeId,
        name: node?.name ?? (nodeId === 'coordinator' ? 'Coordinator' : nodeId),
        online,
        roles,
        apps: [],
      };
      for (const [key, field] of [
        ['cpu', 'cpuPercent'],
        ['memory', 'memoryPercent'],
        ['disk', 'diskPercent'],
      ] as const) {
        const value = capabilities[field];
        if (typeof value === 'number' && Number.isFinite(value)) computer[key] = value;
      }
      computers.push(computer);
    }
    computer.apps.push(app);
  }
  const apps = computers.flatMap((computer) => computer.apps);
  const rollbacks = [...new Set(apps.flatMap((app) => (app.project ? [app.project] : [])))].flatMap(
    (project) => projectRollbacks(owner, project),
  );
  updateRollbackOutcomes(owner, rollbacks, apps, now);
  return {
    rollbacks: rollbacks.filter(
      (rollback) =>
        rollback.approvedBy === 'rule' &&
        rollback.steps.every((step) => step.state === 'done' || step.state === 'skipped') &&
        apps.some((app) => app.project === rollback.projectId && app.release === rollback.to),
    ),
    summary: {
      running: apps.filter((app) => app.state !== 'stopped').length,
      failing: apps.filter((app) => app.state === 'failing').length,
      warning: apps.filter((app) => app.state === 'warning').length,
      checkedAt: new Date().toISOString(),
    },
    computers,
  };
}

export async function getLive(owner: string): Promise<LiveResponse> {
  const releases = JSON.stringify(list('v2-project-current', owner));
  const cached = refreshes.get(owner);
  const previous = cached?.releases === releases ? cached : undefined;
  if (previous?.pending) return previous.pending;
  if (previous?.value && Date.now() - previous.at < 15_000) return previous.value;
  const entry: {
    at: number;
    releases: string;
    pending?: Promise<LiveResponse>;
    value?: LiveResponse;
  } = {
    at: Date.now(),
    releases,
  };
  entry.pending = collectLive(owner)
    .then((value) => {
      entry.value = value;
      entry.pending = undefined;
      return value;
    })
    .catch((error) => {
      refreshes.delete(owner);
      throw error;
    });
  refreshes.set(owner, entry);
  return entry.pending;
}

export async function liveApi(
  req: IncomingMessage,
  res: ServerResponse,
  requireAuth: RequireAuth,
): Promise<boolean> {
  const path = new URL(req.url!, 'http://localhost').pathname;
  if (
    path !== '/api/v2/health/report' &&
    path !== '/api/v2/live' &&
    !path.startsWith('/api/v2/live/')
  )
    return false;
  const send = (value: unknown, status = 200) => {
    sendJson(res, value, status, { guard: true });
  };
  try {
    if (path === '/api/v2/health/report') {
      if (req.method !== 'POST') {
        send({ error: 'Method not allowed' }, 405);
        return true;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > 8192) {
          req.resume();
          fail('Report too large', 413);
        }
        chunks.push(Buffer.from(chunk));
      }
      const body = validateReport(JSON.parse(Buffer.concat(chunks).toString()));
      const app = getDeployment(body.appId);
      const bearer = req.headers.authorization?.replace(/^Bearer /, '');
      let owner: string;
      if (bearer) {
        const credential = authenticateCi(bearer);
        if (credential.application !== body.appId) fail('Token belongs to another app', 403);
        owner = credential.username;
      } else if (req.headers['x-deploy-node-id'] || req.headers['x-deploy-node-secret']) {
        const nodeId = req.headers['x-deploy-node-id'];
        const secret = req.headers['x-deploy-node-secret'];
        if (
          typeof nodeId !== 'string' ||
          typeof secret !== 'string' ||
          !authenticateNode(nodeId, secret)
        )
          fail('Invalid computer credential', 401);
        if (!app || (app.activeNodeId || 'coordinator') !== nodeId)
          fail('App is not running on this computer', 403);
        owner = app.username;
      } else {
        const auth = requireAuth(req, res);
        if (!auth) return true;
        if (req.headers['x-deploy-agent-token'] || req.headers['x-deploy-worker-token'])
          fail('Invalid app credential', 403);
        owner = auth.username;
      }
      send({ app: await acceptWorkerReport(owner, body) });
      return true;
    }
    const auth = requireAuth(req, res);
    if (!auth) return true;
    if (req.headers['x-deploy-agent-token'] || req.headers['x-deploy-worker-token'])
      fail('Agent and worker credentials cannot access client commands', 403);
    if (req.method !== 'GET') {
      send({ error: 'Method not allowed' }, 405);
      return true;
    }
    const live = await getLive(auth.username);
    if (path === '/api/v2/live') send(live);
    else {
      const appId = decodeURIComponent(path.slice('/api/v2/live/'.length));
      const app = live.computers.flatMap((c) => c.apps).find((a) => a.appId === appId);
      if (!app) fail('App not found', 404);
      const report = list('v2-worker-health', auth.username).find((r) => r.id === appId);
      const now = Date.now();
      const response: LiveAppResponse = {
        app,
        ...(app.release && app.project
          ? { release: releaseById(auth.username, app.release, app.project) }
          : {}),
        history:
          app.kind === 'worker'
            ? (report?.state.samples ?? [])
                .filter((sample: any) => now - sample.at <= 3600_000)
                .map((sample: any) => ({
                  at: new Date(sample.at).toISOString(),
                  ...(sample.jobs ? { failRate: sample.failures / sample.jobs } : {}),
                }))
            : getRequestSeries(appId, now - 3600_000, now)
                .series.filter((sample) => sample.count > 0)
                .map((sample) => ({
                  at: new Date(sample.bucket).toISOString(),
                  p95ms: sample.p95,
                })),
      };
      send(response);
    }
  } catch (error: any) {
    send({ error: error.message }, error.status ?? 400);
  }
  return true;
}
