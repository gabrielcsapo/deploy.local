import {
  decryptSecret,
  encryptSecret,
  loadOrCreateSecretKey,
  projectSecretAddress,
} from '../secrets.ts';
import type { Project } from '../../shared/v2/contracts.ts';
import { getDeployments, getApplicationSpecRevision, getSqlite } from '../store.ts';
import { db, list, save, remove, command, commandReplay } from '../workspace/store.ts';
import { queueProject, repositoryApplication } from '../workspace/repositories.ts';
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

/** GET callers opt into Git views; admission/write callers keep direct reads. Membership is live. */
export async function projectsForOwner(owner: string, presentation = false): Promise<Project[]> {
  const projects = list('project', owner).map(({ id, name }) => ({ id, name }));
  // Only inspect manifests when their committed main revision changes.
  const links = (
    await Promise.all(
      projects.map(async (project) => {
        const application = await repositoryApplication(owner, project.id, presentation).catch(
          () => null,
        );
        return application ? [{ projectId: project.id, application }] : [];
      }),
    )
  ).flat();
  // Older releases can predate explicit membership; use their project when no main manifest links it.
  const currentReleaseIds = new Set(
    list('v2-project-current', owner).flatMap((row) => [row.releaseId, ...(row.releaseIds || [])]),
  );
  for (const row of list('v2-release', owner)) {
    if (
      !currentReleaseIds.has(row.id) ||
      !projects.some((project) => project.id === row.release.projectId)
    )
      continue;
    for (const app of row.release.apps)
      if (!links.some((link) => link.application === app.appId))
        links.push({ projectId: row.release.projectId, application: app.appId });
  }
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
  const repositories = list('project', owner);
  return groupProjects(projects, apps, persisted).map((project) => {
    const fromDiscover = project.apps.some((app) => isDiscoverApp(app.name));
    const storedStage = repositories.find((row) => row.id === project.id)?.stage;
    const stage: Project['stage'] = ['active', 'maintained', 'done'].includes(storedStage)
      ? storedStage
      : fromDiscover
        ? 'maintained'
        : 'active';
    return { ...project, stage, ...(fromDiscover ? { fromDiscover: true } : {}) };
  });
}

export async function resolveProject(
  owner: string,
  key: string,
  presentation = false,
): Promise<Project> {
  const projects = await projectsForOwner(owner, presentation);
  const byId = projects.find((project) => project.id === key);
  if (byId) return byId;
  const alias = list('v2-project-alias', owner).find((row) => row.id === key);
  if (alias) {
    const target = projects.find((project) => project.id === alias.projectId);
    if (target) return target;
  }
  const matches = projects.filter((project) => project.name === key);
  if (matches.length > 1) fail('Project name is ambiguous; use its id', 409);
  if (!matches.length) fail('Project not found', 404);
  return matches[0];
}

export async function addProjectApplication(owner: string, key: string, application: string) {
  const project = await resolveProject(owner, key);
  // Take the write lock up front: this reads before it writes, and a write by another process
  // in between would fail the upgrade with “database is locked” instead of waiting.
  db.transaction(() => moveProjectApplication(owner, project, application)).immediate();
  return resolveProject(owner, project.id);
}

function moveProjectApplication(owner: string, project: Project, application: string) {
  if (!getDeployments(owner).some((app) => app.name === application)) fail('App not found', 404);
  if (isDiscoverApp(application)) fail('Only apps shipped from a folder can be added', 409);
  const database = getSqlite()!;
  if (
    list('v2-project-removal', owner).some(
      (removal) =>
        removal.id === project.id ||
        removal.id === `app:${application}` ||
        removal.project.apps.some((app: ProjectApplication) => app.name === application),
    )
  )
    fail('This project or app is being removed', 409);
  if (
    list('v2-project-run', owner).some(
      (run) =>
        run.id === project.id || run.id === `app:${application}` || run.apps.includes(application),
    )
  )
    fail('A release is changing this project; try again after it finishes', 409);
  if (!list('project', owner).some((row) => row.id === project.id))
    fail('Add a repository to this project first', 409);
  database
    .transaction(() => {
      const current = database
        .prepare('SELECT project_id FROM project_applications WHERE owner=? AND application=?')
        .get(owner, application) as { project_id: string } | undefined;
      if (current && current.project_id !== `app:${application}`)
        fail('App already belongs to another project', 409);
      // A standalone project's defaults become app overrides when it joins a
      // repository, so its values cannot unexpectedly change the other apps.
      if (current && current.project_id !== project.id) {
        const rows = database
          .prepare(
            'SELECT * FROM project_configuration WHERE owner=? AND project_id=? ORDER BY app',
          )
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
        // These are every other coordinator table with a project_id. Package pins have
        // no owner column; app names are globally unique and membership was owner-checked above.
        database
          .prepare('UPDATE packages SET project_id=? WHERE project_id=? AND created_by=?')
          .run(project.id, current.project_id, owner);
        database
          .prepare(`INSERT OR IGNORE INTO package_pins
        SELECT ecosystem,key,?,release_id,reason FROM package_pins WHERE project_id=?`)
          .run(project.id, current.project_id);
        database.prepare('DELETE FROM package_pins WHERE project_id=?').run(current.project_id);
        database
          .prepare(`INSERT OR IGNORE INTO package_project_copies
        SELECT username,?,commit_id,checked_at FROM package_project_copies WHERE username=? AND project_id=?`)
          .run(project.id, owner, current.project_id);
        database
          .prepare(`INSERT OR IGNORE INTO package_project_requirements
        SELECT username,?,key,name,version FROM package_project_requirements WHERE username=? AND project_id=?`)
          .run(project.id, owner, current.project_id);
        for (const table of ['package_project_copies', 'package_project_requirements'])
          database
            .prepare(`DELETE FROM ${table} WHERE username=? AND project_id=?`)
            .run(owner, current.project_id);
        moveProjectHistory(owner, current.project_id, project.id);
        database
          .prepare('DELETE FROM project_configuration WHERE owner=? AND project_id=?')
          .run(owner, current.project_id);
      }
      database
        .prepare(
          'INSERT INTO project_applications(application,owner,project_id) VALUES(?,?,?) ON CONFLICT(application) DO UPDATE SET project_id=excluded.project_id',
        )
        .run(application, owner, project.id);
    })
    .immediate();
}

/** Rewrite structured project references, never app ids, messages or historical event payloads. */
function moveProjectHistory(owner: string, from: string, to: string) {
  function references(value: any): any {
    if (Array.isArray(value)) return value.map(references);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key === 'project' &&
        entry &&
        typeof entry === 'object' &&
        'id' in entry &&
        entry.id === from
          ? { ...references(entry), id: to }
          : (key === 'projectId' || key === 'project') && entry === from
            ? to
            : key === 'projects' && Array.isArray(entry)
              ? entry.map((id) => (id === from ? to : id))
              : references(entry),
      ]),
    );
  }
  db.transaction(() => {
    const records = db.prepare('SELECT kind,id,data FROM records WHERE owner=?').all(owner) as {
      kind: string;
      id: string;
      data: string;
    }[];
    for (const record of records) {
      const row = references(JSON.parse(record.data));
      // Project-scoped preferences and the current-release pointer use the project as their key.
      if (record.id === from && record.kind.startsWith('v2-project-')) {
        const existing = list(record.kind, owner).find((entry) => entry.id === to);
        if (record.kind === 'v2-project-current' && existing) {
          row.releaseIds = [
            ...new Set([
              ...(existing.releaseIds || []),
              existing.releaseId,
              ...(row.releaseIds || []),
              row.releaseId,
            ]),
          ];
          row.releaseId = existing.releaseId;
          row.releasedAt = existing.releasedAt;
        } else if (existing) {
          // The destination's project-wide preferences keep governing its other apps.
          Object.assign(row, existing);
        }
        row.id = to;
        remove(record.kind, owner, from);
      }
      if (JSON.stringify(row) !== record.data) save(record.kind, owner, row);
    }
    save('v2-project-alias', owner, { id: from, projectId: to });
  })();
}

/** The same creation path serves New project and Add repository, including legacy clients. */
export async function createRepositoryProject(
  owner: string,
  input: any,
  signature?: string,
  expectedStandalone?: string,
) {
  const replay = commandReplay(owner, input.operationId, signature);
  if (replay.found) return resolveProject(owner, replay.result.id);
  const projects = await projectsForOwner(owner);
  const name = String(input.name || '').trim();
  const standalone = projects.find(
    (project) =>
      project.id.startsWith('app:') && project.name === name && !isDiscoverApp(project.name),
  );
  return command(
    owner,
    input.operationId,
    () => {
      if (expectedStandalone && standalone?.id !== expectedStandalone)
        fail('App already belongs to a repository project', 409);
      const repository = queueProject(owner, input);
      const project: Project = { id: repository.id, name: repository.name, apps: [] };
      if (standalone) {
        for (const app of standalone.apps) moveProjectApplication(owner, project, app.name);
        project.apps = standalone.apps;
      }
      return project;
    },
    signature,
  );
}

export async function addProjectRepository(owner: string, key: string, input: any) {
  const signature = JSON.stringify({ key, sourcePath: input.sourcePath || '' });
  const replay = commandReplay(owner, input.operationId, signature);
  if (replay.found) return resolveProject(owner, replay.result.id);
  const project = await resolveProject(owner, key);
  if (!project.id.startsWith('app:') || isDiscoverApp(project.name))
    fail('App already belongs to a repository project', 409);
  return createRepositoryProject(owner, { ...input, name: project.name }, signature, project.id);
}

export async function unlinkedProjectApps(owner: string, presentation = false) {
  return (await projectsForOwner(owner, presentation))
    .filter((project) => project.id.startsWith('app:') && !isDiscoverApp(project.name))
    .flatMap((project) => project.apps);
}

function isDiscoverApp(application: string) {
  return !!getSqlite()!
    .prepare('SELECT 1 FROM catalog_installations WHERE application_name=?')
    .get(application);
}
