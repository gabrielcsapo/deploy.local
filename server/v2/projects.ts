import {
  decryptSecret,
  encryptSecret,
  loadOrCreateSecretKey,
  projectSecretAddress,
} from '../secrets.ts';
import type { Project } from '../../shared/v2/contracts.ts';
import { getDeployments, getApplicationSpecRevision, getSqlite } from '../store.ts';
import { list } from '../workspace/store.ts';
import { repositoryApplication } from '../workspace/repositories.ts';
import { parseStoredApplicationSpec } from '../application-spec.ts';
import { fail } from '../errors.ts';

export type ProjectApplication = { id: string; name: string; kind: 'web' | 'worker' };

/** Project membership is explicit; unlinked apps receive a stable standalone project. */
export function groupProjects(
  projects: { id: string; name: string }[],
  apps: ProjectApplication[],
  links: { projectId: string; application: string }[],
): Project[] {
  const result = projects.map((project) => ({ ...project, apps: [] as ProjectApplication[] }));
  for (const app of apps) {
    const matches = result.filter((project) =>
      links.some((link) => link.projectId === project.id && link.application === app.name),
    );
    if (matches.length > 1) fail(`App ${app.name} belongs to more than one project`, 409);
    if (matches[0]) matches[0].apps.push(app);
    else result.push({ id: `app:${app.id}`, name: app.name, apps: [app] });
  }
  return result;
}

export async function projectsForOwner(owner: string): Promise<Project[]> {
  const projects = list('project', owner).map(({ id, name }) => ({ id, name }));
  // Only inspect manifests when their committed main revision changes.
  const links = (
    await Promise.all(
      projects.map(async (project) => {
        const application = await repositoryApplication(owner, project.id);
        return application ? [{ projectId: project.id, application }] : [];
      }),
    )
  ).flat();
  const apps = getDeployments(owner).map((app) => {
    const revision = app.activeSpecDigest
      ? getApplicationSpecRevision(app.name, app.activeSpecDigest)
      : null;
    const spec = revision ? parseStoredApplicationSpec(revision.normalizedSpec) : null;
    const kind =
      spec &&
      !Object.keys(spec.routes).length &&
      Object.values(spec.components).some((component) => component.role === 'worker')
        ? ('worker' as const)
        : ('web' as const);
    return { id: app.name, name: app.name, kind };
  });
  const database = getSqlite()!;
  // Workspace and coordinator records live in separate databases. Seed links on
  // first read, then keep explicit membership authoritative across manifest edits.
  const grouped = groupProjects(
    projects,
    apps,
    links.filter(
      (link) =>
        !database
          .prepare('SELECT 1 FROM project_applications WHERE application=? AND owner=?')
          .get(link.application, owner),
    ),
  );
  const changes = grouped.flatMap((project) =>
    project.apps
      .filter(
        (app) =>
          !database
            .prepare('SELECT 1 FROM project_applications WHERE application=? AND owner=?')
            .get(app.name, owner),
      )
      .map((app) => ({ application: app.name, projectId: project.id })),
  );
  if (changes.length)
    database.transaction(() => {
      for (const change of changes)
        database
          .prepare(
            'INSERT INTO project_applications(application,owner,project_id) VALUES(?,?,?) ON CONFLICT(application) DO UPDATE SET owner=excluded.owner,project_id=excluded.project_id,configuration_migrated=0 WHERE owner<>excluded.owner',
          )
          .run(change.application, owner, change.projectId);
    })();
  const stored = database
    .prepare('SELECT project_id AS projectId, application FROM project_applications WHERE owner=?')
    .all(owner) as { projectId: string; application: string }[];
  // A standalone app's own project is nothing without the app. A row left behind after the app
  // was deleted would list an empty project that cannot be opened or removed, so drop it. A
  // removal that is still retryable keeps its rows until it finishes.
  const removing = new Set(list('v2-project-removal', owner).map((row) => row.id));
  const leftover = stored.filter(
    (link) =>
      link.projectId.startsWith('app:') &&
      !removing.has(link.projectId) &&
      !apps.some((app) => app.name === link.application),
  );
  for (const link of leftover)
    database
      .prepare('DELETE FROM project_applications WHERE owner=? AND application=? AND project_id=?')
      .run(owner, link.application, link.projectId);
  const persisted = stored.filter((link) => !leftover.includes(link));
  for (const link of persisted)
    if (!projects.some((project) => project.id === link.projectId))
      projects.push({
        id: link.projectId,
        name: apps.find((app) => app.name === link.application)?.name || link.projectId,
      });
  return groupProjects(projects, apps, persisted);
}

export async function resolveProject(owner: string, key: string): Promise<Project> {
  const projects = await projectsForOwner(owner);
  const byId = projects.find((project) => project.id === key);
  if (byId) return byId;
  const matches = projects.filter((project) => project.name === key);
  if (matches.length > 1) fail('Project name is ambiguous; use its id', 409);
  if (!matches.length) fail('Project not found', 404);
  return matches[0];
}

export async function addProjectApplication(owner: string, key: string, application: string) {
  const project = await resolveProject(owner, key);
  if (!getDeployments(owner).some((app) => app.name === application)) fail('App not found', 404);
  const database = getSqlite()!;
  if (
    list('v2-project-removal', owner).some(
      (removal) =>
        removal.id === project.id ||
        removal.project.apps.some((app: ProjectApplication) => app.name === application),
    )
  )
    fail('This project or app is being removed', 409);
  if (
    list('v2-project-run', owner).some(
      (run) => run.id === project.id || run.apps.includes(application),
    )
  )
    fail('A release is changing this project; try again after it finishes', 409);
  database.transaction(() => {
    const current = database
      .prepare('SELECT project_id FROM project_applications WHERE owner=? AND application=?')
      .get(owner, application) as { project_id: string } | undefined;
    if (current && current.project_id !== project.id && current.project_id !== `app:${application}`)
      fail('App already belongs to another project', 409);
    // A standalone project's defaults become app overrides when it joins a
    // repository, so its values cannot unexpectedly change the other apps.
    if (current && current.project_id !== project.id) {
      const rows = database
        .prepare('SELECT * FROM project_configuration WHERE owner=? AND project_id=? ORDER BY app')
        .all(owner, current.project_id) as Array<{
        app: string;
        key: string;
        value_type: string;
        value: string;
        deleted: number;
        updated_at: string;
        updated_by: string;
      }>;
      for (const row of rows) {
        const value =
          row.value_type === 'secret' && !row.deleted
            ? encryptSecret(
                decryptSecret(
                  row.value,
                  loadOrCreateSecretKey(),
                  projectSecretAddress(owner, current.project_id, row.app, row.key),
                ),
                loadOrCreateSecretKey(),
                projectSecretAddress(owner, project.id, application, row.key),
              )
            : row.value;
        database
          .prepare(
            `INSERT INTO project_configuration(owner,project_id,app,key,value_type,value,deleted,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,project_id,app,key) DO UPDATE SET value_type=excluded.value_type,value=excluded.value,deleted=excluded.deleted,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
          )
          .run(
            owner,
            project.id,
            application,
            row.key,
            row.value_type,
            value,
            row.deleted,
            row.updated_at,
            row.updated_by,
          );
      }
      database
        .prepare('DELETE FROM project_configuration WHERE owner=? AND project_id=?')
        .run(owner, current.project_id);
    }
    database
      .prepare(
        'INSERT INTO project_applications(application,owner,project_id) VALUES(?,?,?) ON CONFLICT(application) DO UPDATE SET project_id=excluded.project_id',
      )
      .run(application, owner, project.id);
  })();
  return resolveProject(owner, project.id);
}
