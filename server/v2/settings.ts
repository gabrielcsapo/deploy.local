import { list } from '../workspace/store.ts';
import { repositoryInfo } from '../workspace/repositories.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Project, ProjectSettings } from '../../shared/v2/contracts.ts';
import { getDeployment, getSqlite } from '../store.ts';
import {
  decryptSecret,
  encryptSecret,
  loadOrCreateSecretKey,
  secretAddress,
  projectSecretAddress,
} from '../secrets.ts';
import { fail } from './inbox.ts';
import { addProjectApplication, resolveProject } from './projects.ts';
import { logsApi } from './logs.ts';

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

export function readProjectSettings(owner: string, project: Project): ProjectSettings {
  migrateProjectConfiguration(owner, project);
  const rows = getSqlite()!
    .prepare(
      'SELECT * FROM project_configuration WHERE owner=? AND project_id=? AND deleted=0 ORDER BY key,app',
    )
    .all(owner, project.id) as Row[];
  return {
    appliesOn: 'next-release',
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
export async function settingsApi(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
): Promise<boolean> {
  if (await logsApi(req, res, owner)) return true;
  const url = new URL(req.url!, 'http://localhost');
  const match = url.pathname.match(
    /^\/api\/v2\/projects\/([^/]+)\/(overview|settings|apps|secrets\/([^/]+))$/,
  );
  if (!match) return false;
  const project = await resolveProject(owner, decodeURIComponent(match[1]));
  let result: unknown;
  if (match[2] === 'overview' && req.method === 'GET') {
    const workspaceProject = list('project', owner).find((entry) => entry.id === project.id);
    let repository = null;
    let repositoryError = false;
    if (workspaceProject)
      try {
        repository = await repositoryInfo(owner, project.id);
      } catch {
        repositoryError = true;
      }
    result = {
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
        .map(({ id, title, state, status, taskId, createdAt }) => ({
          id,
          title,
          state: state || status || 'open',
          taskId,
          createdAt,
        })),
      pulls: list('pull-request', owner)
        .filter((entry) => entry.projectId === project.id)
        .map(({ id, title, state, status, taskId }) => ({
          id,
          title,
          state: state || status || 'open',
          taskId,
        })),
      apps: project.apps.map((app) => {
        const record = getDeployment(app.name)!;
        return {
          ...app,
          computer: record.activeNodeId || record.desiredNodeId,
          memoryLimit: record.memoryLimit,
        };
      }),
    };
  } else if (match[2] === 'settings' && req.method === 'GET')
    result = readProjectSettings(owner, project);
  else if (match[2] === 'settings' && req.method === 'PUT')
    result = putProjectSettings(owner, project, await readProjectBody(req));
  else if (match[2] === 'apps' && req.method === 'POST')
    result = {
      project: await addProjectApplication(owner, project.id, (await readProjectBody(req)).app),
    };
  else if (match[3] && (req.method === 'PUT' || req.method === 'DELETE'))
    result = putProjectSecret(
      owner,
      project,
      decodeURIComponent(match[3]),
      req.method === 'DELETE'
        ? { app: url.searchParams.get('app') || undefined }
        : {
            ...(await readProjectBody(req)),
            ...(url.searchParams.has('app') ? { app: url.searchParams.get('app') } : {}),
          },
      req.method === 'DELETE',
    );
  else fail('Method not allowed', 405);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(result));
  return true;
}
