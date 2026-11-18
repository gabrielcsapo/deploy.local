import { dispatch, routes } from '../kernel/routes.ts';
import {
  projectReleasePolicy,
  putProjectReleasePolicy,
  assertProjectWritable,
} from './project-policy.ts';
import { get, list } from '../workspace/store.ts';
import { repositoryInfo } from '../workspace/repositories.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Project, ProjectSettings } from '../../shared/v2/contracts.ts';
import { getDeployment, getNodes, getSqlite } from '../store.ts';
import {
  decryptSecret,
  encryptSecret,
  loadOrCreateSecretKey,
  secretAddress,
  projectSecretAddress,
} from '../secrets.ts';
import { fail } from '../kernel/errors.ts';
import { addProjectApplication, resolveProject } from './projects.ts';
import { logsApi } from './logs.ts';
import { computers } from '../workspace/coordination.ts';
import { tasksWaitingForAnswer } from '../workspace/questions.ts';
import { pendingControlRequests } from '../features/tasks/interactive.ts';
import { pullTaskChecks } from '../features/tasks/workspace-checks.ts';
import { requireCollaborationPreferencesSource } from '../workspace/collaboration-preferences-port.ts';
import { syncInbox } from '../features/decisions/inbox.ts';
import type { InboxItem } from '../../shared/v2/contracts.ts';
import { stageProjectWork, type ProjectWork } from '../features/repositories/project-work.ts';

type Row = {
  owner: string;
  project_id: string;
  app: string;
  key: string;
  value_type: string;
  value: string;
  deleted: number;
  updated_at: string;
};

export function migrateProjectConfiguration(owner: string, project: Project) {
  const db = getSqlite()!;
  db.transaction(() => {
    for (const app of project.apps) {
      const membership = db
        .prepare(
          'SELECT configuration_migrated FROM project_applications WHERE application=? AND owner=?',
        )
        .get(app.name, owner) as { configuration_migrated: number } | undefined;
      if (!membership || membership.configuration_migrated) continue;
      const deployment = getDeployment(app.name)!;
      const rows = db
        .prepare(
          `SELECT * FROM application_configuration_values WHERE deployment_name=? AND site_id='' AND spec_digest=?`,
        )
        .all(app.name, deployment.activeSpecDigest || deployment.desiredSpecDigest || '') as Array<{
        key: string;
        value_type: string;
        value: string;
        spec_digest: string;
        updated_at: string;
        updated_by: string;
      }>;
      for (const row of rows) {
        const value =
          row.value_type === 'secret'
            ? encryptSecret(
                decryptSecret(
                  row.value,
                  loadOrCreateSecretKey(),
                  secretAddress(app.name, row.key, '', row.spec_digest),
                ),
                loadOrCreateSecretKey(),
                projectSecretAddress(owner, project.id, app.name, row.key),
              )
            : row.value;
        db.prepare(
          'INSERT OR IGNORE INTO project_configuration(owner,project_id,app,key,value_type,value,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?)',
        ).run(
          owner,
          project.id,
          app.name,
          row.key,
          row.value_type,
          value,
          row.updated_at,
          row.updated_by,
        );
      }
      // Legacy untyped environment values may be credentials. Preserve them as
      // encrypted overrides, never guess which are safe to expose as variables.
      for (const [key, value] of Object.entries(JSON.parse(deployment.envVars || '{}'))) {
        db.prepare(
          'INSERT OR IGNORE INTO project_configuration(owner,project_id,app,key,value_type,value,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?)',
        ).run(
          owner,
          project.id,
          app.name,
          key,
          'secret',
          encryptSecret(
            String(value),
            loadOrCreateSecretKey(),
            projectSecretAddress(owner, project.id, app.name, key),
          ),
          new Date().toISOString(),
          owner,
        );
      }
      db.prepare(
        'UPDATE project_applications SET configuration_migrated=1 WHERE application=? AND owner=?',
      ).run(app.name, owner);
    }
  })();
}

export function readProjectSettings(
  owner: string,
  project: Project,
): ProjectSettings & ReturnType<typeof projectReleasePolicy> {
  migrateProjectConfiguration(owner, project);
  const rows = getSqlite()!
    .prepare(
      'SELECT * FROM project_configuration WHERE owner=? AND project_id=? AND deleted=0 ORDER BY key,app',
    )
    .all(owner, project.id) as Row[];
  return {
    appliesOn: 'next-release',
    ...projectReleasePolicy(owner, project.id),
    values: rows.map((row) => ({
      key: row.key,
      ...(row.app ? { app: row.app } : {}),
      type: row.value_type,
      set: true,
      updatedAt: row.updated_at,
      ...(row.value_type === 'secret' ? {} : { value: JSON.parse(row.value) }),
    })),
  };
}

function scope(project: Project, app: unknown): string {
  if (app === undefined || app === '') return '';
  if (typeof app !== 'string' || !project.apps.some((entry) => entry.name === app))
    fail('App is not in this project', 404);
  return app;
}
function validKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(key))
    fail('Invalid configuration name');
}
function writeValue(
  owner: string,
  project: Project,
  key: string,
  app: string,
  type: string,
  value: unknown,
  deleted = false,
) {
  validKey(key);
  const existing = getSqlite()!
    .prepare(
      'SELECT value_type FROM project_configuration WHERE owner=? AND project_id=? AND key=? AND deleted=0',
    )
    .all(owner, project.id, key) as { value_type: string }[];
  if (!deleted && existing.some((row) => (row.value_type === 'secret') !== (type === 'secret')))
    fail('Secrets and variables cannot share a name', 409);
  const encoded = deleted
    ? ''
    : type === 'secret'
      ? encryptSecret(
          value as string,
          loadOrCreateSecretKey(),
          projectSecretAddress(owner, project.id, app, key),
        )
      : JSON.stringify(value);
  getSqlite()!
    .prepare(
      `INSERT INTO project_configuration(owner,project_id,app,key,value_type,value,deleted,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,project_id,app,key) DO UPDATE SET value_type=excluded.value_type,value=excluded.value,deleted=excluded.deleted,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
    )
    .run(
      owner,
      project.id,
      app,
      key,
      type,
      encoded,
      Number(deleted),
      new Date().toISOString(),
      owner,
    );
}
function assertSettingsIdle(owner: string, project: Project) {
  assertProjectWritable(owner, project);
  if (
    list('v2-project-run', owner).some(
      (run) =>
        run.id === project.id ||
        run.apps.some((app: string) => project.apps.some((entry) => entry.id === app)),
    )
  )
    fail('A release is using these values; try again after it finishes', 409);
}

export function putProjectSettings(owner: string, project: Project, input: any) {
  assertSettingsIdle(owner, project);
  if (!Array.isArray(input?.values) || input.values.length > 200)
    fail('values must be an array of at most 200 variables');
  migrateProjectConfiguration(owner, project);
  getSqlite()!.transaction(() => {
    for (const row of input.values) {
      if (
        !row ||
        !['string', 'number', 'boolean'].includes(typeof row.value) ||
        (typeof row.value === 'number' && !Number.isFinite(row.value)) ||
        Buffer.byteLength(JSON.stringify(row.value)) > 65536
      )
        fail('Invalid variable value');
      writeValue(owner, project, row.key, scope(project, row.app), typeof row.value, row.value);
    }
  })();
  return readProjectSettings(owner, project);
}
export function putProjectSecret(
  owner: string,
  project: Project,
  key: string,
  input: any,
  remove = false,
) {
  assertSettingsIdle(owner, project);
  if (!remove && (typeof input?.value !== 'string' || Buffer.byteLength(input.value) > 65536))
    fail('Secret must be a string of at most 64 KiB');
  migrateProjectConfiguration(owner, project);
  const app = scope(project, input?.app);
  const existing = getSqlite()!
    .prepare(
      'SELECT value_type FROM project_configuration WHERE owner=? AND project_id=? AND app=? AND key=?',
    )
    .get(owner, project.id, app, key) as { value_type: string } | undefined;
  if (remove && existing && existing.value_type !== 'secret') fail('This name is a variable', 409);
  writeValue(owner, project, key, app, 'secret', input?.value, remove);
  return readProjectSettings(owner, project);
}
export async function readProjectBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 262144) {
      req.resume();
      fail('Request body too large', 413);
    }
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    fail('Invalid JSON');
  }
}
/** Shared by the JSON API and request-scoped server pages. */
export async function readProjectOverview(owner: string, project: Project) {
  const workspaceProject = list('project', owner).find((entry) => entry.id === project.id);
  let repository = null;
  let repositoryError = false;
  if (workspaceProject)
    try {
      repository = await repositoryInfo(owner, project.id, true);
    } catch {
      repositoryError = true;
    }
  return {
    project,
    repository,
    repositoryError,
    tasks: list('task', owner)
      .filter((entry) => entry.projectId === project.id)
      .map(({ id, title, status, createdAt, updatedAt }) => ({
        id,
        title,
        status,
        createdAt,
        updatedAt,
      })),
    issues: list('issue', owner)
      .filter((entry) => entry.projectId === project.id)
      .map(({ id, title, state, status, taskIds, createdAt }) => ({
        id,
        title,
        state: state || status || 'open',
        // Records keep every linked task in taskIds; taskId is the first, for older readers.
        taskIds: taskIds ?? [],
        taskId: taskIds?.[0],
        createdAt,
      })),
    pulls: list('pull-request', owner)
      .filter((entry) => entry.projectId === project.id)
      .map(({ id, title, state, status, taskIds }) => ({
        id,
        title,
        state: state || status || 'open',
        taskIds: taskIds ?? [],
        taskId: taskIds?.[0],
      })),
    apps: project.apps.map((app) => {
      const record = getDeployment(app.name)!;
      const nodeId = record.activeNodeId || record.desiredNodeId || 'coordinator';
      return {
        ...app,
        // The computer's name, as every other page shows it, not its internal ID.
        computer: getNodes().find((node) => node.id === nodeId)?.name || nodeId,
        memoryLimit: record.memoryLimit,
      };
    }),
  };
}

const passed = (check: Record<string, any>) => ['succeeded', 'passed'].includes(check.status);

/**
 * A project's Work tab, gathered from the workspace for the pure stageProjectWork, which holds
 * the staging rules. `inbox` is the page's own Waiting on you read, when it has one.
 */
export function readProjectWork(
  owner: string,
  projectId: string,
  inbox?: InboxItem[],
): ProjectWork {
  const inProject = (row: Record<string, any>) => row.projectId === projectId;
  const tasks = list('task', owner).filter(inProject);
  const pulls = list('pull-request', owner).filter(inProject);
  const issues = list('issue', owner).filter(inProject);
  const taskIds = new Set(tasks.map((task) => task.id));
  const checks = new Map<string, { passed: number; failed: number; total: number }>();
  const merging = new Set<string>();
  for (const pull of pulls) {
    if (pull.status !== 'open') continue;
    const rows = pullTaskChecks(owner, pull);
    checks.set(pull.id, {
      passed: rows.filter(passed).length,
      failed: rows.filter((row) => row.status === 'failed').length,
      total: rows.length,
    });
    if (pull.mergeOperationId)
      try {
        const operation = get('repository-operation', owner, pull.mergeOperationId);
        if (['queued', 'running'].includes(operation.status)) merging.add(pull.id);
      } catch {
        /* A missing operation is no merge in flight. */
      }
  }
  const agents = new Map(list('agent', owner).map((agent) => [agent.id, agent.name]));
  const workers = new Map(computers(owner).map((computer: any) => [computer.id, computer.name]));
  return stageProjectWork({
    tasks,
    pulls,
    issues,
    runs: list('run', owner).filter((run) => taskIds.has(run.taskId)),
    inbox: (inbox ?? syncInbox(owner, false)).filter(
      (item) => item.taskId && taskIds.has(item.taskId),
    ),
    waitingForAnswer: tasksWaitingForAnswer(owner),
    controlRequests: new Set(pendingControlRequests(owner).keys()),
    checks,
    merging,
    agentName: (agentId) => (agentId ? agents.get(agentId) : undefined),
    // Read only for an idea a person wrote, as pull requests read their author's name.
    personName: (username) =>
      requireCollaborationPreferencesSource('workspace')(username).name || username,
    computerName: (workerId) => workers.get(workerId),
    now: Date.now(),
  });
}

export async function settingsApi(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
): Promise<boolean> {
  if (await logsApi(req, res, owner)) return true;
  const url = new URL(req.url!, 'http://localhost');
  const match = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/(overview|work|settings|apps|secrets\/([^/]+))$/,
  );
  if (!match) return false;
  const project = await resolveProject(owner, decodeURIComponent(match[1]), req.method === 'GET');
  const makeRoute = routes<undefined>();
  const route: typeof makeRoute = (spec) =>
    makeRoute({
      ...spec,
      handler: async (request) => {
        result = await spec.handler(request);
      },
    });
  // Resolve the project before selecting a method, including unsupported methods.
  let result: unknown;
  await dispatch(
    [
      route({
        method: 'GET',
        path: '/api/projects/:project/overview',
        handler: async () => {
          return readProjectOverview(owner, project);
        },
      }),
      route({
        method: 'GET',
        path: '/api/projects/:project/work',
        handler: () => readProjectWork(owner, project.id),
      }),
      route({
        method: 'GET',
        path: '/api/projects/:project/settings',
        handler: () => readProjectSettings(owner, project),
      }),
      route({
        method: 'PATCH',
        path: '/api/projects/:project/settings',
        handler: async () => {
          putProjectReleasePolicy(owner, project, await readProjectBody(req));
          return readProjectSettings(owner, project);
        },
      }),
      route({
        method: 'PUT',
        path: '/api/projects/:project/settings',
        handler: async () => putProjectSettings(owner, project, await readProjectBody(req)),
      }),
      route({
        method: 'POST',
        path: '/api/projects/:project/apps',
        handler: async () => ({
          project: await addProjectApplication(owner, project.id, (await readProjectBody(req)).app),
        }),
      }),
      route({
        method: 'PUT',
        path: '/api/projects/:project/secrets/:key',
        handler: async ({ params }) =>
          putProjectSecret(
            owner,
            project,
            decodeURIComponent(params.key),
            {
              ...(await readProjectBody(req)),
              ...(url.searchParams.has('app') ? { app: url.searchParams.get('app') } : {}),
            },
            false,
          ),
      }),
      route({
        method: 'DELETE',
        path: '/api/projects/:project/secrets/:key',
        handler: ({ params }) =>
          putProjectSecret(
            owner,
            project,
            decodeURIComponent(params.key),
            { app: url.searchParams.get('app') || undefined },
            true,
          ),
      }),
    ],
    {
      notFound: () => fail('Method not allowed', 405),
    },
  )(req, res, undefined);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(result));
  return true;
}
